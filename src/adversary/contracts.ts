import * as v from 'valibot';
import { skillSnapshotSchema } from '../github/skill.ts';

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));
const shaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i));
const boundedText = (maxLength: number) =>
	v.pipe(v.string(), v.maxLength(maxLength));

export const adversaryWorkflowParamsSchema = v.object({
	deliveryId: nonEmptyString,
	installationId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	repositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	label: nonEmptyString,
	baseRef: nonEmptyString,
	baseSha: shaSchema,
	configurationSha: shaSchema,
	headSha: shaSchema,
});

export const blueTeamInputSchema = v.object({
	sandboxId: nonEmptyString,
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	baseRef: nonEmptyString,
	baseSha: shaSchema,
	headSha: shaSchema,
	title: boundedText(1_000),
	body: boundedText(20_000),
	model: nonEmptyString,
	skill: skillSnapshotSchema,
});

export const blueTeamResultSchema = v.object({
	solved: v.boolean(),
	summary: boundedText(8_000),
	approach: boundedText(8_000),
	validation: v.pipe(v.array(boundedText(2_000)), v.maxLength(50)),
	limitations: v.pipe(v.array(boundedText(2_000)), v.maxLength(20)),
});

const comparisonSchema = v.object({
	criterion: boundedText(200),
	redAssessment: boundedText(2_000),
	blueAssessment: boundedText(2_000),
	preference: v.picklist(['red', 'blue', 'tie', 'unknown']),
	evidence: boundedText(4_000),
});

export const purpleTeamInputSchema = v.object({
	sandboxId: nonEmptyString,
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	baseSha: shaSchema,
	headSha: shaSchema,
	title: boundedText(1_000),
	body: boundedText(20_000),
	blueSummary: boundedText(8_000),
	blueApproach: boundedText(8_000),
	model: nonEmptyString,
	skill: skillSnapshotSchema,
});

export const purpleTeamResultSchema = v.object({
	changeType: v.picklist([
		'bug-fix',
		'feature',
		'mixed',
		'security',
		'performance',
		'refactor',
		'other',
	]),
	contract: v.pipe(
		v.array(
			v.object({
				requirement: boundedText(2_000),
				source: boundedText(1_000),
			}),
		),
		v.maxLength(50),
	),
	qualification: v.object({
		sameProblem: v.boolean(),
		materiallyDifferent: v.boolean(),
		verified: v.boolean(),
		safeguardsPreserved: v.boolean(),
		scopeAppropriate: v.boolean(),
	}),
	comparisons: v.pipe(v.array(comparisonSchema), v.maxLength(30)),
	recommendation: v.picklist([
		'red',
		'blue',
		'either',
		'hybrid',
		'inconclusive',
	]),
	summary: boundedText(8_000),
	decisiveCriteria: v.pipe(v.array(boundedText(1_000)), v.maxLength(20)),
	uncertainties: v.pipe(v.array(boundedText(1_000)), v.maxLength(20)),
	confidence: v.picklist(['low', 'medium', 'high']),
});

export type AdversaryWorkflowParams = v.InferOutput<
	typeof adversaryWorkflowParamsSchema
>;
export type BlueTeamInput = v.InferOutput<typeof blueTeamInputSchema>;
export type BlueTeamResult = v.InferOutput<typeof blueTeamResultSchema>;
export type PurpleTeamInput = v.InferOutput<typeof purpleTeamInputSchema>;
export type PurpleTeamResult = v.InferOutput<typeof purpleTeamResultSchema>;

export function adversaryCoordinatorKey(
	input: Pick<AdversaryWorkflowParams, 'repositoryId' | 'pullNumber'>,
): string {
	return `${input.repositoryId}:${input.pullNumber}`;
}

export function blueQualifies(result: PurpleTeamResult): boolean {
	return Object.values(result.qualification).every(Boolean);
}

export function adversaryBranchName(
	pullNumber: number,
	headSha: string,
): string {
	return `factory/adversary/pr-${pullNumber}-${headSha.slice(0, 12)}`;
}

export type AdversaryWorkflowOutcome =
	| {
			outcome: 'ignored' | 'stale' | 'unqualified' | 'not-selected';
			reason: string;
	  }
	| {
			outcome: 'published';
			branch: string;
			branchSha: string;
			pullRequestNumber: number;
			pullRequestUrl: string;
	  }
	| { outcome: 'failed'; reason: string };
