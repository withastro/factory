import type { InstallationClient } from './client.ts';

export const REVIEW_CHECK_NAME = 'Astro Review';

export interface ReviewCheckInput {
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	deliveryId: string;
}

export async function startReviewCheck(
	client: InstallationClient,
	input: ReviewCheckInput,
): Promise<number> {
	for (let page = 1; ; page += 1) {
		const response = await client.rest.checks.listForRef({
			owner: input.owner,
			repo: input.repo,
			ref: input.headSha,
			check_name: REVIEW_CHECK_NAME,
			filter: 'all',
			per_page: 100,
			page,
		});
		const existing = response.data.check_runs.find(
			(check) => check.external_id === input.deliveryId,
		);
		if (existing) return existing.id;
		if (response.data.check_runs.length < 100) break;
	}

	const response = await client.rest.checks.create({
		owner: input.owner,
		repo: input.repo,
		name: REVIEW_CHECK_NAME,
		head_sha: input.headSha,
		status: 'in_progress',
		external_id: input.deliveryId,
		details_url: pullRequestUrl(input),
		started_at: new Date().toISOString(),
		output: {
			title: 'Review in progress',
			summary: 'Astro Review is analyzing this pull request.',
		},
	});
	return response.data.id;
}

export async function completeReviewCheck(
	client: InstallationClient,
	input: ReviewCheckInput,
	checkRunId: number,
): Promise<void> {
	await client.rest.checks.update({
		owner: input.owner,
		repo: input.repo,
		check_run_id: checkRunId,
		status: 'completed',
		conclusion: 'success',
		external_id: input.deliveryId,
		details_url: pullRequestUrl(input),
		completed_at: new Date().toISOString(),
		output: {
			title: 'Review complete',
			summary: 'Astro Review finished. Findings, if any, were posted on the pull request.',
		},
	});
}

function pullRequestUrl(input: ReviewCheckInput): string {
	return `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`;
}
