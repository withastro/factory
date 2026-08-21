import type { InstallationClient } from '../github/client.ts';

export const REVIEW_CHECK_NAME = 'Factory Review';

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
	const existing = (await listReviewChecks(client, input)).find(
		(check) => check.status !== 'completed',
	);
	if (existing) return existing.id;

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
			summary: 'Factory Review is analyzing this pull request.',
		},
	});
	return response.data.id;
}

export async function completeReviewCheck(
	client: InstallationClient,
	input: ReviewCheckInput,
	checkRunId?: number,
): Promise<void> {
	const checkRunIds = new Set(
		(await listReviewChecks(client, input))
			.filter((check) => check.status !== 'completed')
			.map((check) => check.id),
	);
	if (checkRunId !== undefined) checkRunIds.add(checkRunId);
	if (checkRunIds.size === 0) {
		throw new Error(
			`No ${REVIEW_CHECK_NAME} check run exists for delivery ${input.deliveryId}.`,
		);
	}

	for (const id of checkRunIds) {
		await client.rest.checks.update({
			owner: input.owner,
			repo: input.repo,
			check_run_id: id,
			status: 'completed',
			conclusion: 'success',
			external_id: input.deliveryId,
			details_url: pullRequestUrl(input),
			completed_at: new Date().toISOString(),
			output: {
				title: 'Review complete',
				summary:
					'Factory Review finished. Findings, if any, were posted on the pull request.',
			},
		});
	}
}

async function listReviewChecks(
	client: InstallationClient,
	input: ReviewCheckInput,
): Promise<Array<{ id: number; status: string }>> {
	const matches: Array<{ id: number; status: string }> = [];
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
		for (const check of response.data.check_runs) {
			if (check.external_id === input.deliveryId) {
				matches.push({ id: check.id, status: check.status });
			}
		}
		if (response.data.check_runs.length < 100) break;
	}
	return matches;
}

function pullRequestUrl(input: ReviewCheckInput): string {
	return `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`;
}
