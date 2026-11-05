/**
 * Merge risk: an assessment-only capability. After Factory's own code review
 * finishes on a pull request, it reads everything known about the pull
 * request (metadata, changed files, checks, reviews) and posts one scored
 * comment summarizing how risky merging it looks right now. It never blocks,
 * approves, or merges anything.
 */

import * as v from 'valibot';
import { thinkingLevelSchema } from '../thinking.ts';

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const nonNegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0));
const shaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i));

/**
 * One assessment per `check_run.completed` delivery for Factory's own review
 * check. The workflow re-reads the pull request when it runs, so it always
 * acts on live state rather than the webhook's snapshot.
 */
export const mergeRiskWorkflowParamsSchema = v.object({
	deliveryId: nonEmptyString,
	installationId: positiveInteger,
	repositoryId: positiveInteger,
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: positiveInteger,
	headSha: shaSchema,
});

export type MergeRiskWorkflowParams = v.InferOutput<
	typeof mergeRiskWorkflowParamsSchema
>;

export function mergeRiskCoordinatorKey(
	input: Pick<MergeRiskWorkflowParams, 'repositoryId' | 'pullNumber'>,
): string {
	return `${input.repositoryId}:${input.pullNumber}`;
}

export const MERGE_RISK_CATEGORIES = [
	'alignment',
	'impact',
	'verification',
	'rollbackCost',
	'errorDetection',
] as const;
export type MergeRiskCategory = (typeof MERGE_RISK_CATEGORIES)[number];

export const MERGE_RISK_CATEGORY_VERDICTS = ['good', 'ok', 'poor'] as const;
export type MergeRiskCategoryVerdict =
	(typeof MERGE_RISK_CATEGORY_VERDICTS)[number];

const categoryResultSchema = v.object({
	verdict: v.picklist(MERGE_RISK_CATEGORY_VERDICTS),
	notes: v.pipe(
		v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300))),
		v.maxLength(6),
	),
});

/** What the agent submits; the workflow computes the overall score from it. */
export const mergeRiskResultSchema = v.object({
	alignment: categoryResultSchema,
	impact: categoryResultSchema,
	verification: categoryResultSchema,
	rollbackCost: categoryResultSchema,
	errorDetection: categoryResultSchema,
	summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
});

export type MergeRiskResult = v.InferOutput<typeof mergeRiskResultSchema>;

const changedFileSchema = v.object({
	path: nonEmptyString,
	status: nonEmptyString,
	additions: nonNegativeInteger,
	deletions: nonNegativeInteger,
});

const checkRunSchema = v.object({
	name: nonEmptyString,
	status: nonEmptyString,
	conclusion: v.nullable(v.string()),
});

const reviewSchema = v.object({
	author: nonEmptyString,
	association: nonEmptyString,
	isBot: v.boolean(),
	state: nonEmptyString,
	bodySnippet: v.string(),
});

export const mergeRiskAgentInputSchema = v.object({
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: positiveInteger,
	headSha: shaSchema,
	baseRef: nonEmptyString,
	title: v.string(),
	body: v.string(),
	draft: v.boolean(),
	author: v.object({
		login: nonEmptyString,
		association: nonEmptyString,
		isBot: v.boolean(),
	}),
	labels: v.array(v.string()),
	additions: nonNegativeInteger,
	deletions: nonNegativeInteger,
	changedFilesCount: nonNegativeInteger,
	files: v.pipe(v.array(changedFileSchema), v.maxLength(300)),
	filesTruncated: v.boolean(),
	checkRuns: v.pipe(v.array(checkRunSchema), v.maxLength(50)),
	reviews: v.pipe(v.array(reviewSchema), v.maxLength(30)),
	model: nonEmptyString,
	thinkingLevel: v.optional(thinkingLevelSchema),
});

export type MergeRiskAgentInput = v.InferOutput<
	typeof mergeRiskAgentInputSchema
>;

export type MergeRiskWorkflowOutcome =
	| { outcome: 'ignored'; reason: string }
	| { outcome: 'stale'; reason: string }
	| { outcome: 'posted'; commentId: number; level: 'low' | 'medium' | 'high' };
