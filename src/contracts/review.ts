import * as v from 'valibot';

const shaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i));
const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));

export const reviewWorkflowParamsSchema = v.pipe(
	v.object({
		deliveryId: nonEmptyString,
		installationId: v.pipe(v.number(), v.integer(), v.minValue(1)),
		repositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
		owner: nonEmptyString,
		repo: nonEmptyString,
		pullNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
		label: nonEmptyString,
		baseSha: shaSchema,
		configurationSha: v.optional(shaSchema),
		headSha: shaSchema,
	}),
	v.transform((params) => ({
		...params,
		configurationSha: params.configurationSha ?? params.baseSha,
	})),
);

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
	severities: v.pipe(v.array(nonEmptyString), v.minLength(1), v.maxLength(50)),
	areas: v.pipe(v.array(nonEmptyString), v.minLength(1), v.maxLength(50)),
	skill: skillSnapshotSchema,
});

const findingShape = {
	path: nonEmptyString,
	line: v.pipe(v.number(), v.integer(), v.minValue(1)),
	side: v.picklist(['LEFT', 'RIGHT']),
	title: v.pipe(nonEmptyString, v.maxLength(160)),
	body: v.pipe(nonEmptyString, v.maxLength(4_000)),
};

export function createReviewResultSchema(
	severities: readonly string[],
	areas: readonly string[],
) {
	return v.object({
		summary: v.pipe(nonEmptyString, v.maxLength(8_000)),
		findings: v.pipe(
			v.array(
				v.object({
					...findingShape,
					severity: configuredValueSchema('severity', severities),
					area: configuredValueSchema('area', areas),
				}),
			),
			v.maxLength(50),
		),
	});
}

function configuredValueSchema(name: string, values: readonly string[]) {
	const [first, ...rest] = values;
	if (first === undefined) {
		throw new Error(`At least one review ${name} must be configured.`);
	}
	return v.picklist([first, ...rest]);
}

export type ReviewWorkflowParams = v.InferOutput<typeof reviewWorkflowParamsSchema>;
export type SkillSnapshot = v.InferOutput<typeof skillSnapshotSchema>;
export type ReviewAgentInput = v.InferOutput<typeof reviewAgentInputSchema>;
export type ReviewResultSchema = ReturnType<typeof createReviewResultSchema>;
export type ReviewResult = v.InferOutput<ReviewResultSchema>;
export type Finding = ReviewResult['findings'][number];

export function reviewCoordinatorKey(
	input: Pick<ReviewWorkflowParams, 'repositoryId' | 'pullNumber'>,
): string {
	return `${input.repositoryId}:${input.pullNumber}`;
}

export type ReviewWorkflowOutcome =
	| { outcome: 'ignored'; reason: string }
	| { outcome: 'stale'; reason: string }
	| { outcome: 'published'; reviewId: number; reviewUrl: string | null; comments: number }
	| { outcome: 'already-published'; reviewId: number; reviewUrl: string | null };
