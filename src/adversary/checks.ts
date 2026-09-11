import type { InstallationClient } from '../github/client.ts';
import type {
	AdversaryWorkflowOutcome,
	AdversaryWorkflowParams,
} from './contracts.ts';

export const ADVERSARY_CHECK_NAME = 'Factory Adversary';

export type AdversaryCheckInput = Pick<
	AdversaryWorkflowParams,
	| 'owner'
	| 'repo'
	| 'pullNumber'
	| 'headSha'
	| 'baseRef'
	| 'baseSha'
	| 'deliveryId'
>;

interface MatchingCheck {
	id: number;
	status: string;
}

export async function startAdversaryCheck(
	client: InstallationClient,
	input: AdversaryCheckInput,
): Promise<number> {
	const existing = (await listAdversaryChecks(client, input))[0];
	if (existing) return existing.id;

	const response = await client.rest.checks.create({
		owner: input.owner,
		repo: input.repo,
		name: ADVERSARY_CHECK_NAME,
		head_sha: input.headSha,
		status: 'in_progress',
		external_id: input.deliveryId,
		details_url: pullRequestUrl(input),
		started_at: new Date().toISOString(),
		output: {
			title: 'Adversary analysis in progress',
			summary: 'Factory Adversary is evaluating an alternative implementation.',
		},
	});
	return response.data.id;
}

export async function completeAdversaryCheck(
	client: InstallationClient,
	input: AdversaryCheckInput,
	result: AdversaryWorkflowOutcome,
	knownCheckRunIds: number | readonly number[] = [],
): Promise<number[]> {
	const checks = await listAdversaryChecks(client, input);
	const completedIds = new Set(
		checks
			.filter((check) => check.status === 'completed')
			.map((check) => check.id),
	);
	const checkRunIds = new Set(checks.map((check) => check.id));
	const knownIds =
		typeof knownCheckRunIds === 'number'
			? [knownCheckRunIds]
			: knownCheckRunIds;
	for (const id of knownIds) checkRunIds.add(id);

	if (checkRunIds.size === 0) {
		throw new Error(
			`No ${ADVERSARY_CHECK_NAME} check run exists for delivery ${input.deliveryId}.`,
		);
	}

	const completion = completionFor(result);
	for (const checkRunId of checkRunIds) {
		if (completedIds.has(checkRunId)) continue;
		await client.rest.checks.update({
			owner: input.owner,
			repo: input.repo,
			check_run_id: checkRunId,
			status: 'completed',
			conclusion: completion.conclusion,
			external_id: input.deliveryId,
			details_url: pullRequestUrl(input),
			completed_at: new Date().toISOString(),
			output: completion.output,
		});
	}
	return [...checkRunIds];
}

/** Alias matching check helpers that use a plural completion name. */
export const completeAdversaryChecks = completeAdversaryCheck;

function completionFor(result: AdversaryWorkflowOutcome): {
	conclusion: 'success' | 'neutral' | 'cancelled' | 'failure';
	output: { title: string; summary: string };
} {
	if (result.outcome === 'published') {
		return {
			conclusion: 'success',
			output: {
				title: 'Qualified alternative published',
				summary: `Purple selected Blue. [Review alternative PR #${result.pullRequestNumber}](${result.pullRequestUrl}).`,
			},
		};
	}
	if (result.outcome === 'stale') {
		return {
			conclusion: 'cancelled',
			output: {
				title: 'Adversary analysis became stale',
				summary: result.reason,
			},
		};
	}
	if (result.outcome === 'failed') {
		return {
			conclusion: 'failure',
			output: {
				title: 'Adversary analysis failed',
				summary: result.reason,
			},
		};
	}
	return {
		conclusion: 'neutral',
		output: {
			title:
				result.outcome === 'not-selected'
					? 'Purple selected another outcome'
					: 'No qualifying alternative',
			summary: result.reason,
		},
	};
}

async function listAdversaryChecks(
	client: InstallationClient,
	input: Pick<AdversaryCheckInput, 'owner' | 'repo' | 'headSha' | 'deliveryId'>,
): Promise<MatchingCheck[]> {
	const matches: MatchingCheck[] = [];
	for (let page = 1; page <= 10; page += 1) {
		const response = await client.rest.checks.listForRef({
			owner: input.owner,
			repo: input.repo,
			ref: input.headSha,
			check_name: ADVERSARY_CHECK_NAME,
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

function pullRequestUrl(
	input: Pick<AdversaryCheckInput, 'owner' | 'repo' | 'pullNumber'>,
): string {
	return `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`;
}
