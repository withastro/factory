/**
 * Contracts for the sandboxed triage pipeline agent: its initial data and the
 * structured result each pipeline step must submit.
 */

import * as v from 'valibot';

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));

const conversationEntrySchema = v.object({
	author: nonEmptyString,
	association: v.string(),
	isBot: v.boolean(),
	body: v.string(),
});

export const triagePipelineInputSchema = v.object({
	sandboxId: nonEmptyString,
	owner: nonEmptyString,
	repo: nonEmptyString,
	issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	issueTitle: v.string(),
	issueBody: v.string(),
	issueAuthor: nonEmptyString,
	issueAuthorAssociation: v.string(),
	conversation: v.array(conversationEntrySchema),
	defaultBranch: nonEmptyString,
	fixBranch: nonEmptyString,
	skillName: nonEmptyString,
	skillDirectory: nonEmptyString,
});

export type TriagePipelineInput = v.InferOutput<typeof triagePipelineInputSchema>;

export const SKIP_REASONS = [
	'not-actionable',
	'missing-details',
	'unsupported-version',
	'host-specific',
	'unsupported-runtime',
	'maintainer-override',
] as const;

export const reproduceResultSchema = v.object({
	reproducible: v.pipe(
		v.boolean(),
		v.description('true if the bug was successfully reproduced, false otherwise'),
	),
	skipped: v.pipe(
		v.boolean(),
		v.description(
			'true if reproduction was intentionally skipped (host-specific, unsupported version, etc.)',
		),
	),
	skippedReason: v.pipe(
		v.nullable(v.picklist(SKIP_REASONS)),
		v.description('The reason reproduction was skipped, or null if not skipped'),
	),
});

export const diagnoseResultSchema = v.object({
	confidence: v.pipe(
		v.nullable(v.picklist(['high', 'medium', 'low'])),
		v.description('Diagnosis confidence level, null if not attempted'),
	),
});

export const verifyResultSchema = v.object({
	verdict: v.pipe(
		v.picklist(['bug', 'intended-behavior', 'unclear']),
		v.description('Whether the reported behavior is a bug, intended behavior, or unclear'),
	),
	confidence: v.pipe(
		v.picklist(['high', 'medium', 'low']),
		v.description('Confidence level in the verdict'),
	),
});

export const fixResultSchema = v.object({
	fixed: v.pipe(
		v.boolean(),
		v.description('true if the bug was successfully fixed and verified'),
	),
	commitMessage: v.pipe(
		v.nullable(v.string()),
		v.description('A short commit message describing the fix. null if not fixed.'),
	),
});

export const commentResultSchema = v.object({
	comment: v.pipe(
		nonEmptyString,
		v.description(
			'The GitHub comment body, starting with the bullet-point summary (- **Reproduced:** ...)',
		),
	),
});

export const labelSelectionSchema = v.object({
	priority: v.pipe(
		v.nullable(v.string()),
		v.description('The chosen priority label name, exactly as listed, or null if none fit'),
	),
	packages: v.pipe(
		v.array(v.string()),
		v.maxLength(3),
		v.description('0-3 package label names, exactly as listed'),
	),
});

export const prContentSchema = v.object({
	title: v.pipe(nonEmptyString, v.maxLength(200), v.description('The PR title')),
	body: v.pipe(nonEmptyString, v.maxLength(20_000), v.description('The PR body in markdown')),
});

export type ReproduceResult = v.InferOutput<typeof reproduceResultSchema>;
export type DiagnoseResult = v.InferOutput<typeof diagnoseResultSchema>;
export type VerifyResult = v.InferOutput<typeof verifyResultSchema>;
export type FixResult = v.InferOutput<typeof fixResultSchema>;
export type LabelSelection = v.InferOutput<typeof labelSelectionSchema>;
export type PrContent = v.InferOutput<typeof prContentSchema>;

/** Everything the pipeline produced, assembled step by step by the workflow. */
export interface TriagePipelineResult {
	completedStage: 'reproduce' | 'verify' | 'fix';
	reproducible: boolean;
	skipped: boolean;
	skippedReason: (typeof SKIP_REASONS)[number] | null;
	verdict: 'bug' | 'intended-behavior' | 'unclear' | null;
	diagnosisConfidence: 'high' | 'medium' | 'low' | null;
	fixed: boolean;
	commitMessage: string | null;
}
