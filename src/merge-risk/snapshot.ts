/**
 * Everything the merge-risk assessor needs about a pull request, read fresh
 * from GitHub. No sandbox and no repository checkout: the assessment reasons
 * over metadata, the changed-file list, check conclusions, and review
 * states, never repository content.
 */

import type { InstallationClient } from '../github/client.ts';

const MAX_FILE_PAGES = 3;
const MAX_REVIEWS = 30;
const MAX_CHECK_RUNS = 50;
const BODY_SNIPPET_LENGTH = 500;

export interface MergeRiskPullRequest {
	state: string;
	draft: boolean;
	title: string;
	body: string;
	baseRef: string;
	headSha: string;
	additions: number;
	deletions: number;
	changedFilesCount: number;
	labels: string[];
	author: { login: string; association: string; isBot: boolean };
}

export async function loadMergeRiskPullRequest(
	client: InstallationClient,
	owner: string,
	repo: string,
	pullNumber: number,
): Promise<MergeRiskPullRequest> {
	const pull = await client.rest.pulls.get({
		owner,
		repo,
		pull_number: pullNumber,
	});
	return {
		state: pull.data.state,
		draft: pull.data.draft ?? false,
		title: pull.data.title,
		body: pull.data.body ?? '',
		baseRef: pull.data.base.ref,
		headSha: pull.data.head.sha,
		additions: pull.data.additions,
		deletions: pull.data.deletions,
		changedFilesCount: pull.data.changed_files,
		labels: pull.data.labels.map((label) =>
			typeof label === 'string' ? label : (label.name ?? ''),
		),
		author: {
			login: pull.data.user?.login ?? 'unknown',
			association: pull.data.author_association ?? 'NONE',
			isBot: pull.data.user?.type === 'Bot',
		},
	};
}

export interface MergeRiskChangedFile {
	path: string;
	status: string;
	additions: number;
	deletions: number;
}

export async function loadMergeRiskFiles(
	client: InstallationClient,
	owner: string,
	repo: string,
	pullNumber: number,
): Promise<{ files: MergeRiskChangedFile[]; truncated: boolean }> {
	const files: MergeRiskChangedFile[] = [];
	let truncated = false;
	for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
		const response = await client.rest.pulls.listFiles({
			owner,
			repo,
			pull_number: pullNumber,
			per_page: 100,
			page,
		});
		for (const file of response.data) {
			files.push({
				path: file.filename,
				status: file.status,
				additions: file.additions,
				deletions: file.deletions,
			});
		}
		if (response.data.length < 100) break;
		if (page === MAX_FILE_PAGES) truncated = true;
	}
	return { files, truncated };
}

export interface MergeRiskCheckRun {
	name: string;
	status: string;
	conclusion: string | null;
}

export async function loadMergeRiskCheckRuns(
	client: InstallationClient,
	owner: string,
	repo: string,
	headSha: string,
): Promise<MergeRiskCheckRun[]> {
	const response = await client.rest.checks.listForRef({
		owner,
		repo,
		ref: headSha,
		per_page: MAX_CHECK_RUNS,
	});
	return response.data.check_runs.map((run) => ({
		name: run.name,
		status: run.status,
		conclusion: run.conclusion,
	}));
}

export interface MergeRiskReview {
	author: string;
	association: string;
	isBot: boolean;
	state: string;
	bodySnippet: string;
}

/** The latest review per reviewer, since an earlier state can be stale. */
export async function loadMergeRiskReviews(
	client: InstallationClient,
	owner: string,
	repo: string,
	pullNumber: number,
): Promise<MergeRiskReview[]> {
	const reviews = await client.paginate(client.rest.pulls.listReviews, {
		owner,
		repo,
		pull_number: pullNumber,
		per_page: 100,
	});
	const latestByAuthor = new Map<string, (typeof reviews)[number]>();
	for (const review of reviews) {
		latestByAuthor.set(review.user?.login ?? 'unknown', review);
	}
	return [...latestByAuthor.values()].slice(-MAX_REVIEWS).map((review) => ({
		author: review.user?.login ?? 'unknown',
		association: review.author_association ?? 'NONE',
		isBot: review.user?.type === 'Bot',
		state: review.state,
		bodySnippet: (review.body ?? '').slice(0, BODY_SNIPPET_LENGTH),
	}));
}
