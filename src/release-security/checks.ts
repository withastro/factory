import type { InstallationClient } from '../github/client.ts';
import type {
	ReleaseSecurityResult,
	ReleaseSecurityWorkflowParams,
} from './contracts.ts';

export const RELEASE_SECURITY_CHECK_NAMES = {
	release: 'Astro release security review',
	smoke: 'Astro release security smoke test',
} as const;

type CheckInput = Pick<
	ReleaseSecurityWorkflowParams,
	| 'owner'
	| 'repo'
	| 'pullNumber'
	| 'pullUrl'
	| 'headSha'
	| 'deliveryId'
	| 'mode'
>;

export async function startReleaseSecurityCheck(
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
		name: RELEASE_SECURITY_CHECK_NAMES[input.mode],
		head_sha: input.headSha,
		status: 'in_progress',
		external_id: input.deliveryId,
		details_url: input.pullUrl,
		started_at: new Date().toISOString(),
		output: checkOutput(input, undefined),
	});
	return response.data.id;
}

export async function completeReleaseSecurityChecks(
	client: InstallationClient,
	input: CheckInput,
	result: Pick<ReleaseSecurityResult, 'verdict' | 'reviewedSha'>,
	knownCheckRunIds: number[] = [],
): Promise<number[]> {
	const checkRunIds = new Set(knownCheckRunIds);
	for (const check of await listChecks(client, input)) {
		if (check.status !== 'completed') checkRunIds.add(check.id);
	}
	if (checkRunIds.size === 0) {
		throw new Error(
			`No ${RELEASE_SECURITY_CHECK_NAMES[input.mode]} check run exists for delivery ${input.deliveryId}.`,
		);
	}
	for (const checkRunId of checkRunIds) {
		await client.rest.checks.update({
			owner: input.owner,
			repo: input.repo,
			check_run_id: checkRunId,
			status: 'completed',
			conclusion: result.verdict === 'PASS' ? 'success' : 'failure',
			external_id: input.deliveryId,
			details_url: input.pullUrl,
			completed_at: new Date().toISOString(),
			output: checkOutput(input, result.verdict),
		});
	}
	return [...checkRunIds];
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
			check_name: RELEASE_SECURITY_CHECK_NAMES[input.mode],
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

function checkOutput(
	input: Pick<CheckInput, 'pullNumber' | 'headSha' | 'mode'>,
	verdict?: ReleaseSecurityResult['verdict'],
): { title: string; summary: string } {
	if (input.mode === 'smoke') {
		return verdict
			? {
					title: `${verdict}: model health check`,
					summary:
						verdict === 'PASS'
							? 'The isolated model health check passed. No release security analysis was performed.'
							: 'The isolated model health check did not pass. No release security analysis was performed.',
				}
			: {
					title: 'Model health check queued',
					summary:
						'This isolated smoke test does not perform a release security review.',
				};
	}
	if (!verdict) {
		return {
			title: `Reviewing release PR #${input.pullNumber}`,
			summary: 'The private release security review is running.',
		};
	}
	return {
		title: `${verdict}: release security review`,
		summary:
			verdict === 'PASS'
				? `No release-blocking vulnerabilities were found at ${input.headSha}.`
				: verdict === 'BLOCK'
					? `A potential release-blocking vulnerability was found at ${input.headSha}. Details are withheld.`
					: `The review could not be completed for ${input.headSha}. Details are withheld.`,
	};
}
