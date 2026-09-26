/**
 * Persona handoffs: the GitHub gestures that pass a pull request from one
 * persona (or a person) to the next.
 *
 * The loop is GitHub's own review loop, played by personas:
 *
 *   triage opens a PR → assigns the author, requests the reviewer
 *   reviewer → REQUEST_CHANGES → author round → re-requests the reviewer → …
 *   reviewer → APPROVE → the loop ends; a human merges
 *
 * Every hop is a visible GitHub state change (an assignment, a review
 * request, a review) that arrives back as a webhook, so a maintainer can see
 * the loop in the timeline and step in at any point. When the personas can't
 * agree, or the author's round budget runs out, the pull request is handed to
 * a human: the author unassigns itself and the pull request is labelled.
 *
 * All handoff writes are best-effort. A persona account that lost access to
 * the repository makes GitHub reject the request with a 422; that must not
 * fail the run that already did its real work.
 */

import type { InstallationClient } from '../github/client.ts';
import { isGitHubStatus } from '../github/content.ts';
import {
	addIssueLabels,
	ensureLabelExists,
	removeIssueAssignees,
} from '../github/issues.ts';

/** Labels a pull request the personas handed to a human. */
export const NEEDS_HUMAN_LABEL = 'factory: needs human';

const NEEDS_HUMAN_LABEL_APPEARANCE = {
	color: 'd93f0b',
	description:
		'Factory personas stopped on this pull request; a maintainer needs to take over.',
};

export interface PullRef {
	owner: string;
	repo: string;
	pullNumber: number;
}

/**
 * Request reviews from `logins`, skipping any GitHub refuses (no access, the
 * pull request's own author). Returns the logins actually requested.
 */
export async function requestReviews(
	client: InstallationClient,
	pull: PullRef,
	logins: readonly string[],
): Promise<string[]> {
	const requested: string[] = [];
	for (const login of new Set(logins)) {
		try {
			await client.rest.pulls.requestReviewers({
				owner: pull.owner,
				repo: pull.repo,
				pull_number: pull.pullNumber,
				reviewers: [login],
			});
			requested.push(login);
		} catch (error) {
			if (!isGitHubStatus(error, 422)) throw error;
			console.warn(
				`GitHub refused a review request for ${login} on ${pull.owner}/${pull.repo}#${pull.pullNumber}.`,
			);
		}
	}
	return requested;
}

/** Assign `login`, tolerating GitHub refusing an account without access. */
export async function assignPersona(
	client: InstallationClient,
	pull: PullRef,
	login: string,
): Promise<boolean> {
	try {
		const response = await client.rest.issues.addAssignees({
			owner: pull.owner,
			repo: pull.repo,
			issue_number: pull.pullNumber,
			assignees: [login],
		});
		// GitHub silently drops assignees who can't be assigned.
		return (response.data.assignees ?? []).some(
			(assignee) => assignee.login.toLowerCase() === login.toLowerCase(),
		);
	} catch (error) {
		if (!isGitHubStatus(error, 422)) throw error;
		console.warn(
			`GitHub refused assigning ${login} to ${pull.owner}/${pull.repo}#${pull.pullNumber}.`,
		);
		return false;
	}
}

/**
 * Hand a pull request Factory just opened to the personas: the author owns
 * it, and the reviewer reviews it. Assigning first means the author already
 * owns the pull request when the reviewer's verdict arrives.
 */
export async function handOffNewPullRequest(
	client: InstallationClient,
	pull: PullRef,
	personas: { authorLogin?: string; reviewerLogin?: string },
): Promise<{ authorAssigned: boolean; reviewerRequested: boolean }> {
	const authorAssigned = personas.authorLogin
		? await assignPersona(client, pull, personas.authorLogin)
		: false;
	const reviewerRequested = personas.reviewerLogin
		? (await requestReviews(client, pull, [personas.reviewerLogin])).length > 0
		: false;
	return { authorAssigned, reviewerRequested };
}

/**
 * Stop the persona loop and give the pull request to a human: label it and,
 * when the author persona owns it, unassign the author so nothing proceeds.
 */
export async function handOffToHuman(
	client: InstallationClient,
	pull: PullRef,
	authorLogin: string | undefined,
): Promise<void> {
	await ensureLabelExists(
		client,
		pull.owner,
		pull.repo,
		NEEDS_HUMAN_LABEL,
		NEEDS_HUMAN_LABEL_APPEARANCE,
	);
	await addIssueLabels(client, pull.owner, pull.repo, pull.pullNumber, [
		NEEDS_HUMAN_LABEL,
	]);
	if (authorLogin) {
		await removeIssueAssignees(client, pull.owner, pull.repo, pull.pullNumber, [
			authorLogin,
		]);
	}
}
