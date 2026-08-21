import * as v from 'valibot';
import { skillSnapshotSchema } from '../github/skill.ts';

const shaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i));
const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));
const nodeIdSchema = v.pipe(nonEmptyString, v.maxLength(200));
const lineSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

export const MAX_UNRESOLVED_REVIEW_THREADS = 50;
export const MAX_REVIEW_THREAD_BODY_LENGTH = 8_000;
export const MAX_REVIEW_THREAD_DIFF_LENGTH = 20_000;
// Leave headroom below Workflows' 1 MiB non-stream step-result limit.
export const MAX_REVIEW_THREAD_SNAPSHOT_BYTES = 768 * 1_024;

export const unresolvedReviewThreadSchema = v.object({
	threadId: nodeIdSchema,
	commentId: nodeIdSchema,
	reviewId: nodeIdSchema,
	reviewHeadSha: shaSchema,
	body: v.pipe(v.string(), v.maxLength(MAX_REVIEW_THREAD_BODY_LENGTH)),
	path: v.pipe(nonEmptyString, v.maxLength(4_096)),
	line: v.nullable(lineSchema),
	originalLine: v.nullable(lineSchema),
	diffSide: v.picklist(['LEFT', 'RIGHT']),
	startLine: v.nullable(lineSchema),
	originalStartLine: v.nullable(lineSchema),
	startDiffSide: v.nullable(v.picklist(['LEFT', 'RIGHT'])),
	subjectType: v.picklist(['LINE', 'FILE']),
	isOutdated: v.boolean(),
	diffHunk: v.pipe(v.string(), v.maxLength(MAX_REVIEW_THREAD_DIFF_LENGTH)),
	url: v.pipe(nonEmptyString, v.maxLength(2_048)),
	commentUpdatedAt: v.pipe(nonEmptyString, v.maxLength(100)),
	commentCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

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
	model: nonEmptyString,
	severities: v.pipe(v.array(nonEmptyString), v.minLength(1), v.maxLength(50)),
	areas: v.pipe(v.array(nonEmptyString), v.minLength(1), v.maxLength(50)),
	skill: skillSnapshotSchema,
	unresolvedReviewThreads: v.optional(
		v.pipe(
			v.array(unresolvedReviewThreadSchema),
			v.maxLength(MAX_UNRESOLVED_REVIEW_THREADS),
		),
		[],
	),
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
	addressableThreadIds: readonly string[] = [],
) {
	const allowedThreadIds = new Set(addressableThreadIds);
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
		addressedThreadIds: v.pipe(
			v.array(nodeIdSchema),
			v.maxLength(addressableThreadIds.length),
			v.check(
				(ids) => new Set(ids).size === ids.length,
				'Addressed review thread IDs must be unique.',
			),
			v.check(
				(ids) => ids.every((id) => allowedThreadIds.has(id)),
				'Only supplied unresolved review threads may be marked addressed.',
			),
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

export type ReviewWorkflowParams = v.InferOutput<
	typeof reviewWorkflowParamsSchema
>;
export type ReviewAgentInput = v.InferOutput<typeof reviewAgentInputSchema>;
export type UnresolvedReviewThread = v.InferOutput<
	typeof unresolvedReviewThreadSchema
>;
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
	| {
			outcome: 'published';
			reviewId: number;
			reviewUrl: string | null;
			comments: number;
	  }
	| {
			outcome: 'already-published';
			reviewId: number;
			reviewUrl: string | null;
	  };
