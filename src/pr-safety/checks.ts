/**
 * The PR safety check run. It records only that the review ran: its
 * conclusion and text are the same whatever the verdict, so the check never
 * tells a contributor whether their change was flagged, or which change
 * would get past it. Maintainers receive verdicts privately.
 */

import type { InstallationClient } from '../github/client.ts';
import type { PrSafetyWorkflowParams } from './contracts.ts';

export const PR_SAFETY_CHECK_NAME = 'Factory PR safety';

type CheckInput = Pick<
	PrSafetyWorkflowParams,
	'owner' | 'repo' | 'pullUrl' | 'headSha' | 'deliveryId'
>;

export const PR_SAFETY_CHECK_OUTPUT = {
	running: {
		title: 'Review in progress',
		summary: 'Factory is reviewing this pull request.',
	},
	completed: {
		title: 'Review completed',
		summary:
			'Factory reviewed this pull request. Maintainers receive the results.',
	},
} as const;

export async function startPrSafetyCheck(
	client: InstallationClient,
	input: CheckInput,
): Promise<number> {
	const existing = (await listChecks(client, input)).find(
		(check) => check.status !== 'completed',
	);
	if (existing) return existing.id;
	const response = await client.rest.checks.create({
		owner: input.owner,
		repo: input.repo,
		name: PR_SAFETY_CHECK_NAME,
		head_sha: input.headSha,
		status: 'in_progress',
		external_id: input.deliveryId,
		details_url: input.pullUrl,
		started_at: new Date().toISOString(),
		output: PR_SAFETY_CHECK_OUTPUT.running,
	});
	return response.data.id;
}

/** Complete every open check for this delivery. Safe to repeat. */
export async function completePrSafetyCheck(
	client: InstallationClient,
	input: CheckInput,
	knownCheckRunId?: number,
): Promise<void> {
	const ids = new Set(
		(await listChecks(client, input))
			.filter((check) => check.status !== 'completed')
			.map((check) => check.id),
	);
	if (knownCheckRunId !== undefined) ids.add(knownCheckRunId);
	for (const id of ids) {
		await client.rest.checks.update({
			owner: input.owner,
			repo: input.repo,
			check_run_id: id,
			status: 'completed',
			conclusion: 'neutral',
			completed_at: new Date().toISOString(),
			output: PR_SAFETY_CHECK_OUTPUT.completed,
		});
	}
}

async function listChecks(
	client: InstallationClient,
	input: CheckInput,
): Promise<Array<{ id: number; status: string }>> {
	const matches: Array<{ id: number; status: string }> = [];
	for (let page = 1; page <= 10; page += 1) {
		const response = await client.rest.checks.listForRef({
			owner: input.owner,
			repo: input.repo,
			ref: input.headSha,
			check_name: PR_SAFETY_CHECK_NAME,
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
