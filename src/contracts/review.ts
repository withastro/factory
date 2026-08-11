import * as v from 'valibot';

const shaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i));
const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));

export const reviewWorkflowParamsSchema = v.object({
	deliveryId: nonEmptyString,
	installationId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	repositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	label: nonEmptyString,
	baseSha: shaSchema,
	headSha: shaSchema,
});

export const skillSnapshotSchema = v.object({
	name: v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
	directory: nonEmptyString,
	files: v.record(v.string(), v.string()),
});

export const reviewAgentInputSchema = v.object({
	deliveryId: nonEmptyString,
	installationId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	repositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	baseSha: shaSchema,
	headSha: shaSchema,
	title: v.string(),
	body: v.string(),
	triggerLabel: nonEmptyString,
	skill: skillSnapshotSchema,
});

export const findingSchema = v.object({
	path: nonEmptyString,
	line: v.pipe(v.number(), v.integer(), v.minValue(1)),
	side: v.picklist(['LEFT', 'RIGHT']),
	severity: v.picklist(['critical', 'high', 'medium', 'low']),
	title: v.pipe(nonEmptyString, v.maxLength(160)),
	body: v.pipe(nonEmptyString, v.maxLength(4_000)),
});

export const reviewResultSchema = v.object({
	summary: v.pipe(nonEmptyString, v.maxLength(8_000)),
	findings: v.pipe(v.array(findingSchema), v.maxLength(50)),
});

export type ReviewWorkflowParams = v.InferOutput<typeof reviewWorkflowParamsSchema>;
export type SkillSnapshot = v.InferOutput<typeof skillSnapshotSchema>;
export type ReviewAgentInput = v.InferOutput<typeof reviewAgentInputSchema>;
export type Finding = v.InferOutput<typeof findingSchema>;
export type ReviewResult = v.InferOutput<typeof reviewResultSchema>;

export type ReviewWorkflowOutcome =
	| { outcome: 'ignored'; reason: string }
	| { outcome: 'stale'; reason: string }
	| { outcome: 'published'; reviewId: number; reviewUrl: string | null; comments: number }
	| { outcome: 'already-published'; reviewId: number; reviewUrl: string | null };
