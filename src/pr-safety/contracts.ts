import * as v from 'valibot';
import { thinkingLevelSchema } from '../thinking.ts';

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));
const shaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));

export const prSafetyWorkflowParamsSchema = v.object({
	deliveryId: nonEmptyString,
	installationId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	repositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	pullUrl: v.pipe(nonEmptyString, v.url()),
	pullTitle: v.string(),
	pullBody: v.string(),
	author: nonEmptyString,
	authorAssociation: nonEmptyString,
	headRepository: nonEmptyString,
	headSha: shaSchema,
	baseRef: nonEmptyString,
	baseSha: shaSchema,
	/** The base branch tip at webhook time; configuration is read here. */
	configurationSha: shaSchema,
});

export const PR_SAFETY_VERDICTS = [
	'CLEAN',
	'SUSPICIOUS',
	'MALICIOUS',
	'INCOMPLETE',
] as const;

export const prSafetyResultSchema = v.object({
	verdict: v.picklist(PR_SAFETY_VERDICTS),
	reviewedSha: shaSchema,
	/** One or two sentences for the maintainer alert. */
	summary: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
	report: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
});

export const prSafetyAgentInputSchema = v.object({
	...prSafetyWorkflowParamsSchema.entries,
	sandboxId: nonEmptyString,
	model: nonEmptyString,
	thinkingLevel: v.optional(thinkingLevelSchema),
});

export type PrSafetyWorkflowParams = v.InferOutput<
	typeof prSafetyWorkflowParamsSchema
>;
export type PrSafetyAgentInput = v.InferOutput<typeof prSafetyAgentInputSchema>;
export type PrSafetyResult = v.InferOutput<typeof prSafetyResultSchema>;
export type PrSafetyVerdict = PrSafetyResult['verdict'];

export type PrSafetyWorkflowOutcome =
	| { outcome: 'skipped'; reason: string }
	| {
			outcome: 'completed';
			verdict: PrSafetyVerdict;
			reportKey: string;
			alerted: boolean;
	  };

export function prSafetyCoordinatorKey(
	input: Pick<PrSafetyWorkflowParams, 'repositoryId' | 'pullNumber'>,
): string {
	return `${input.repositoryId}:${input.pullNumber}`;
}

export function prSafetyAgentId(
	input: Pick<
		PrSafetyWorkflowParams,
		'repositoryId' | 'pullNumber' | 'headSha' | 'deliveryId'
	>,
): string {
	return [
		'pr-safety',
		input.repositoryId,
		input.pullNumber,
		input.headSha,
		input.deliveryId,
	].join(':');
}

export function prSafetySandboxId(
	input: Pick<
		PrSafetyWorkflowParams,
		'repositoryId' | 'pullNumber' | 'deliveryId'
	>,
): string {
	const delivery = input.deliveryId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
	return `ps-${input.repositoryId}-${input.pullNumber}-${delivery}`.slice(
		0,
		63,
	);
}

export function incompletePrSafetyResult(
	headSha: string,
	reason: string,
): PrSafetyResult {
	return {
		verdict: 'INCOMPLETE',
		reviewedSha: headSha,
		summary: `The PR safety review could not be completed: ${reason}.`,
		report: `INCOMPLETE - Could not complete the PR safety review: ${reason}.`,
	};
}

export function parsePrSafetyResult(
	value: unknown,
	expectedSha: string,
): PrSafetyResult {
	const parsed = v.safeParse(prSafetyResultSchema, value);
	if (
		!parsed.success ||
		parsed.output.reviewedSha !== expectedSha ||
		!parsed.output.report.startsWith(parsed.output.verdict)
	) {
		return incompletePrSafetyResult(
			expectedSha,
			'the model returned an invalid or stale result',
		);
	}
	return parsed.output;
}

export function extractPrSafetyResult(
	data: Record<string, unknown[]>,
	expectedSha: string,
): PrSafetyResult {
	const writes = data.review;
	if (!writes?.length) {
		return incompletePrSafetyResult(
			expectedSha,
			'the agent finished without submitting a result',
		);
	}
	return parsePrSafetyResult(writes.at(-1), expectedSha);
}
