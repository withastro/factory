/**
 * Issue, label, comment, branch, and pull request helpers used by the triage
 * capability. All functions take an installation-scoped Octokit client; the
 * caller decides which installation it acts for.
 */

import * as v from 'valibot';
import type { LabelAppearance } from '../triage/labels.ts';
import type { InstallationClient } from './client.ts';
import { isGitHubStatus } from './content.ts';

export const issueDetailsSchema = v.object({
	number: v.number(),
	title: v.string(),
	body: v.string(),
	state: v.string(),
	url: v.string(),
	author: v.object({ login: v.string() }),
	authorAssociation: v.string(),
	labels: v.array(v.string()),
	createdAt: v.string(),
	comments: v.array(
		v.object({
			author: v.object({ login: v.string() }),
			authorIsBot: v.boolean(),
			authorAssociation: v.string(),
			body: v.string(),
			createdAt: v.string(),
		}),
	),
});
export type IssueDetails = v.InferOutput<typeof issueDetailsSchema>;
export type IssueComment = IssueDetails['comments'][number];

/**
 * Narrow the API's `state` string to the two values that matter.
 *
 * Compared case-insensitively against "closed" rather than against "open" on
 * purpose: an unexpected value then reads as open and leaves triage running,
 * instead of silently switching it off for every issue in the repository.
 */
export function normalizeIssueState(state: string): 'open' | 'closed' {
	return state.trim().toLowerCase() === 'closed' ? 'closed' : 'open';
}

export async function fetchIssueDetails(
	client: InstallationClient,
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<IssueDetails> {
	const [issue, comments] = await Promise.all([
		client.rest.issues.get({ owner, repo, issue_number: issueNumber }),
		client.paginate(client.rest.issues.listComments, {
			owner,
			repo,
			issue_number: issueNumber,
			per_page: 100,
		}),
	]);

	return v.parse(issueDetailsSchema, {
		number: issue.data.number,
		title: issue.data.title,
		body: issue.data.body ?? '',
		state: issue.data.state,
		url: issue.data.html_url,
		author: { login: issue.data.user?.login ?? '' },
		authorAssociation: issue.data.author_association,
		labels: issue.data.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
		createdAt: issue.data.created_at,
		comments: comments.map((comment) => ({
			author: { login: comment.user?.login ?? '' },
			authorIsBot: comment.user?.type === 'Bot',
			authorAssociation: comment.author_association,
			body: comment.body ?? '',
			createdAt: comment.created_at,
		})),
	});
}

export interface RepoLabel {
	name: string;
	description: string | null;
}

/**
 * Split repository labels into the priority and package sets used for issue
 * classification. The patterns follow Astro's conventions (`- P1`…, `pkg:`);
 * they'll move into repository configuration when another convention needs
 * them.
 */
export function partitionClassificationLabels(labels: RepoLabel[]): {
	priorityLabels: RepoLabel[];
	packageLabels: RepoLabel[];
} {
	return {
		priorityLabels: labels.filter((label) => /^- P\d/.test(label.name)),
		packageLabels: labels.filter((label) => label.name.startsWith('pkg:')),
	};
}

/**
 * Compute which priority labels should be removed from an issue when applying
 * a new priority label selection. Any existing priority label that is not the
 * selected priority is returned. Package labels are intentionally left alone;
 * an issue can legitimately carry several of those.
 */
export function computePriorityLabelsToRemove(
	issueLabels: string[],
	selectedPriority: string | null,
	priorityLabels: RepoLabel[],
): string[] {
	const priorityNames = new Set(priorityLabels.map((label) => label.name));
	return issueLabels.filter((label) => priorityNames.has(label) && label !== selectedPriority);
}

export async function fetchRepoLabels(
	client: InstallationClient,
	owner: string,
	repo: string,
): Promise<RepoLabel[]> {
	const labels = await client.paginate(client.rest.issues.listLabelsForRepo, {
		owner,
		repo,
		per_page: 100,
	});
	return labels.map((label) => ({ name: label.name, description: label.description ?? null }));
}

/**
 * Create a label in the repository if it doesn't exist yet, so installing the
 * factory on a fresh repository needs no manual label setup.
 */
export async function ensureLabelExists(
	client: InstallationClient,
	owner: string,
	repo: string,
	name: string,
	appearance?: LabelAppearance,
): Promise<void> {
	try {
		await client.rest.issues.getLabel({ owner, repo, name });
		return;
	} catch (error) {
		if (!isGitHubStatus(error, 404)) throw error;
	}
	try {
		await client.rest.issues.createLabel({
			owner,
			repo,
			name,
			color: appearance?.color,
			description: appearance?.description,
		});
	} catch (error) {
		// Another concurrent run may have created it first.
		if (!isGitHubStatus(error, 422)) throw error;
	}
}

export async function addIssueLabels(
	client: InstallationClient,
	owner: string,
	repo: string,
	issueNumber: number,
	labels: string[],
): Promise<void> {
	if (labels.length === 0) return;
	await client.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
}

export async function removeLabelIfPresent(
	client: InstallationClient,
	owner: string,
	repo: string,
	issueNumber: number,
	label: string,
): Promise<void> {
	try {
		await client.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
	} catch (error) {
		if (!isGitHubStatus(error, 404)) throw error;
	}
}

/**
 * Swap one triage label for another: remove the old one (if present) and add
 * the new one. Not atomic; the coordinator serializes runs per issue so only
 * one swap is in flight at a time.
 */
export async function swapIssueLabel(
	client: InstallationClient,
	owner: string,
	repo: string,
	issueNumber: number,
	oldLabel: string | null,
	newLabel: string,
): Promise<void> {
	if (oldLabel && oldLabel !== newLabel) {
		await removeLabelIfPresent(client, owner, repo, issueNumber, oldLabel);
	}
	await addIssueLabels(client, owner, repo, issueNumber, [newLabel]);
}

/** Replace any of the known old state labels before applying the new state. */
export async function replaceIssueLabels(
	client: InstallationClient,
	owner: string,
	repo: string,
	issueNumber: number,
	oldLabels: ReadonlyArray<string | null>,
	newLabel: string,
): Promise<void> {
	for (const label of new Set(oldLabels)) {
		if (label && label !== newLabel) {
			await removeLabelIfPresent(client, owner, repo, issueNumber, label);
		}
	}
	await addIssueLabels(client, owner, repo, issueNumber, [newLabel]);
}

export async function postIssueComment(
	client: InstallationClient,
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
): Promise<number> {
	const response = await client.rest.issues.createComment({
		owner,
		repo,
		issue_number: issueNumber,
		body,
	});
	return response.data.id;
}

/** Create or update the bot comment carrying a delivery-specific marker. */
export async function upsertIssueComment(
	client: InstallationClient,
	owner: string,
	repo: string,
	issueNumber: number,
	marker: string,
	body: string,
): Promise<number> {
	const markedBody = body.includes(marker) ? body : `${body}\n\n${marker}`;
	const existing = await findMarkedBotComment(client, owner, repo, issueNumber, marker);
	if (existing) {
		await client.rest.issues.updateComment({
			owner,
			repo,
			comment_id: existing.id,
			body: markedBody,
		});
		return existing.id;
	}

	try {
		const response = await client.rest.issues.createComment({
			owner,
			repo,
			issue_number: issueNumber,
			body: markedBody,
			// A Workflow retry must repeat the marker lookup before another POST.
			request: { retries: 0 },
		});
		return response.data.id;
	} catch (error) {
		// The server may have committed the comment before the request failed.
		const committed = await findMarkedBotComment(client, owner, repo, issueNumber, marker);
		if (committed) return committed.id;
		throw error;
	}
}

/** Update a known progress comment, recreating it only if it was deleted. */
export async function saveIssueComment(
	client: InstallationClient,
	owner: string,
	repo: string,
	issueNumber: number,
	commentId: number | null,
	marker: string,
	body: string,
): Promise<number> {
	const markedBody = body.includes(marker) ? body : `${body}\n\n${marker}`;
	if (commentId !== null) {
		try {
			await client.rest.issues.updateComment({
				owner,
				repo,
				comment_id: commentId,
				body: markedBody,
			});
			return commentId;
		} catch (error) {
			if (!isGitHubStatus(error, 404)) throw error;
		}
	}
	return upsertIssueComment(client, owner, repo, issueNumber, marker, markedBody);
}

async function findMarkedBotComment(
	client: InstallationClient,
	owner: string,
	repo: string,
	issueNumber: number,
	marker: string,
) {
	const comments = await client.paginate(client.rest.issues.listComments, {
		owner,
		repo,
		issue_number: issueNumber,
		per_page: 100,
	});
	return comments.find(
		(comment) => comment.user?.type === 'Bot' && comment.body?.includes(marker),
	);
}

export interface PullRequestRef {
	number: number;
	url: string;
}

export async function createPullRequest(
	client: InstallationClient,
	owner: string,
	repo: string,
	options: { head: string; base: string; title: string; body: string },
): Promise<PullRequestRef> {
	const response = await client.rest.pulls.create({
		owner,
		repo,
		head: options.head,
		base: options.base,
		title: options.title,
		body: options.body,
	});
	return { number: response.data.number, url: response.data.html_url };
}

export async function findOpenPullRequest(
	client: InstallationClient,
	owner: string,
	repo: string,
	branch: string,
): Promise<PullRequestRef | null> {
	const response = await client.rest.pulls.list({
		owner,
		repo,
		head: `${owner}:${branch}`,
		state: 'open',
		per_page: 1,
	});
	const pull = response.data[0];
	return pull ? { number: pull.number, url: pull.html_url } : null;
}

/** Return the first branch from `candidates` that exists in the repository. */
export async function findExistingBranch(
	client: InstallationClient,
	owner: string,
	repo: string,
	candidates: string[],
): Promise<string | null> {
	for (const branch of candidates) {
		const response = await client.rest.git.listMatchingRefs({
			owner,
			repo,
			ref: `heads/${branch}`,
		});
		if (response.data.some((entry) => entry.ref === `refs/heads/${branch}`)) {
			return branch;
		}
	}
	return null;
}

/** Head commit SHA of a branch, or null when the branch doesn't exist. */
export async function getBranchHeadSha(
	client: InstallationClient,
	owner: string,
	repo: string,
	branch: string,
): Promise<string | null> {
	try {
		const response = await client.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
		return response.data.object.sha;
	} catch (error) {
		if (isGitHubStatus(error, 404)) return null;
		throw error;
	}
}

export async function deleteBranchIfPresent(
	client: InstallationClient,
	owner: string,
	repo: string,
	branch: string,
): Promise<boolean> {
	try {
		await client.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
		return true;
	} catch (error) {
		// 422 = the ref doesn't exist, which is fine.
		if (isGitHubStatus(error, 422) || isGitHubStatus(error, 404)) return false;
		throw error;
	}
}
