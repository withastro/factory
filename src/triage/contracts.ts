import * as v from 'valibot';
import { skillSnapshotSchema } from '../github/skill.ts';
import { prContentSchema } from './pipeline-contracts.ts';

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));

/**
 * One triage workflow run per GitHub delivery. The workflow re-reads the
 * issue's current labels when it runs and routes through the FSM there, so
 * queued events always act on fresh state.
 */
export const triageWorkflowParamsSchema = v.object({
	deliveryId: nonEmptyString,
	installationId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	repositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
	owner: nonEmptyString,
	repo: nonEmptyString,
	issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	defaultBranch: nonEmptyString,
	issueAction: v.picklist(['opened', 'reopened', 'closed', 'comment']),
	commentAuthor: v.optional(v.string()),
	/** Private repositories get an authenticated, self-contained clone. */
	repoIsPrivate: v.optional(v.boolean(), false),
});

export type TriageWorkflowParams = v.InferOutput<
	typeof triageWorkflowParamsSchema
>;

export function triageCoordinatorKey(
	input: Pick<TriageWorkflowParams, 'repositoryId' | 'issueNumber'>,
): string {
	return `${input.repositoryId}:${input.issueNumber}`;
}

/** Branch that carries a candidate fix for an issue. */
export function fixBranchName(issueNumber: number): string {
	return `factory/fix-${issueNumber}`;
}

/** Branch names used by earlier generations of the triage bot. */
export function legacyFixBranchNames(issueNumber: number): string[] {
	return [`triagebot/fix-${issueNumber}`, `flue/fix-${issueNumber}`];
}

export type TriageWorkflowOutcome =
	| { outcome: 'ignored'; reason: string }
	| { outcome: 'skipped'; reason: string }
	| { outcome: 'cleaned-up'; deletedBranch: string | null }
	| {
			outcome: 'triaged';
			label: string;
			branchPushed: boolean;
			pullRequestUrl: string | null;
	  }
	| { outcome: 'failed'; reason: string }
	| { outcome: 'fix-rejected' }
	| { outcome: 'fix-inconclusive'; reason: string }
	| { outcome: 'fix-verified'; pullRequestUrl: string }
	| { outcome: 'no-retriage'; reason: string };

// ---------- Classifier agent contracts ----------

const conversationEntrySchema = v.object({
	author: nonEmptyString,
	association: v.string(),
	isBot: v.boolean(),
	body: v.string(),
});

export const fixVerifierInputSchema = v.object({
	owner: nonEmptyString,
	repo: nonEmptyString,
	issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	issueTitle: v.string(),
	issueBody: v.string(),
	branch: nonEmptyString,
	defaultBranch: nonEmptyString,
	conversation: v.array(conversationEntrySchema),
	latestComment: conversationEntrySchema,
	prWriterSkill: v.optional(skillSnapshotSchema),
	model: nonEmptyString,
});

export type FixVerifierInput = v.InferOutput<typeof fixVerifierInputSchema>;

export const fixVerdictSchema = v.object({
	status: v.picklist(['confirmed', 'rejected', 'inconclusive']),
	reasoning: v.pipe(v.string(), v.maxLength(2_000)),
	pr: v.nullable(prContentSchema),
});

export type FixVerdict = v.InferOutput<typeof fixVerdictSchema>;

export const retriageJudgeInputSchema = v.object({
	owner: nonEmptyString,
	repo: nonEmptyString,
	issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
	issueTitle: v.string(),
	issueBody: v.string(),
	conversation: v.array(conversationEntrySchema),
	model: nonEmptyString,
});

export type RetriageJudgeInput = v.InferOutput<typeof retriageJudgeInputSchema>;

export const retriageDecisionSchema = v.object({
	retriage: v.boolean(),
	reasoning: v.pipe(v.string(), v.maxLength(2_000)),
});

export type RetriageDecision = v.InferOutput<typeof retriageDecisionSchema>;
