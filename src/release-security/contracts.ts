import * as v from 'valibot';
import { CODE_MODEL } from '../models.ts';

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));
const shaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));

export const RELEASE_SECURITY_TARGET = 'withastro/astro';
export const RELEASE_BRANCH_PREFIX = 'changeset-release/';
export const SMOKE_BRANCH_PREFIX = 'release-security-test/';
export const SMOKE_PR_TITLE = '[test] release security reviewer';
export const RELEASE_SECURITY_MODEL = CODE_MODEL;

export const releaseSecurityWorkflowParamsSchema = v.object({
	deliveryId: nonEmptyString,
	installationId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	repositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	pullUrl: v.pipe(nonEmptyString, v.url()),
	pullTitle: nonEmptyString,
	pullBody: v.string(),
	headRef: nonEmptyString,
	headSha: shaSchema,
	baseRef: nonEmptyString,
	baseSha: shaSchema,
	mode: v.picklist(['release', 'smoke']),
	trigger: v.picklist(['pull-request', 'rerequest']),
});

export const releaseSecurityResultSchema = v.object({
	verdict: v.picklist(['PASS', 'BLOCK', 'INCOMPLETE']),
	reviewedSha: shaSchema,
	report: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
});

export const releaseSecurityAgentInputSchema = v.object({
	...releaseSecurityWorkflowParamsSchema.entries,
	sandboxId: nonEmptyString,
	model: nonEmptyString,
});

export type ReleaseSecurityMode = v.InferOutput<
	typeof releaseSecurityWorkflowParamsSchema
>['mode'];
export type ReleaseSecurityWorkflowParams = v.InferOutput<
	typeof releaseSecurityWorkflowParamsSchema
>;
export type ReleaseSecurityAgentInput = v.InferOutput<
	typeof releaseSecurityAgentInputSchema
>;
export type ReleaseSecurityResult = v.InferOutput<
	typeof releaseSecurityResultSchema
>;

export type ReleaseSecurityWorkflowOutcome =
	| { outcome: 'stale'; reason: string }
	| {
			outcome: 'completed';
			verdict: ReleaseSecurityResult['verdict'];
			reportKey: string;
			transcriptKey?: string;
	  };

export function releaseSecurityCoordinatorKey(
	input: Pick<ReleaseSecurityWorkflowParams, 'repositoryId' | 'pullNumber'>,
): string {
	return `${input.repositoryId}:${input.pullNumber}`;
}

export function releaseSecurityAgentId(
	input: Pick<
		ReleaseSecurityWorkflowParams,
		'repositoryId' | 'pullNumber' | 'headSha' | 'deliveryId'
	>,
): string {
	return [
		'release-security',
		input.repositoryId,
		input.pullNumber,
		input.headSha,
		input.deliveryId,
	].join(':');
}

export function releaseSecuritySandboxId(
	input: Pick<
		ReleaseSecurityWorkflowParams,
		'repositoryId' | 'pullNumber' | 'deliveryId'
	>,
): string {
	const delivery = input.deliveryId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
	return `rs-${input.repositoryId}-${input.pullNumber}-${delivery}`.slice(
		0,
		63,
	);
}

export function incompleteResult(
	headSha: string,
	reason: string,
): ReleaseSecurityResult {
	return {
		verdict: 'INCOMPLETE',
		reviewedSha: headSha,
		report: `INCOMPLETE - Could not complete the release security review: ${reason}.`,
	};
}

export function parseReleaseSecurityResult(
	value: unknown,
	expectedSha: string,
): ReleaseSecurityResult {
	const result = v.parse(releaseSecurityResultSchema, value);
	if (
		result.reviewedSha !== expectedSha ||
		!result.report.startsWith(result.verdict)
	) {
		return incompleteResult(
			expectedSha,
			'the model returned an invalid or stale result',
		);
	}
	return result;
}

export function extractReleaseSecurityResult(
	data: Record<string, unknown[]>,
	expectedSha: string,
): ReleaseSecurityResult {
	const writes = data.review;
	if (!writes?.length) {
		throw new Error(
			'The release security agent completed without a structured result.',
		);
	}
	return parseReleaseSecurityResult(writes.at(-1), expectedSha);
}
