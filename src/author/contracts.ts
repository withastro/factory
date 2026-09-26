/**
 * Contracts for the code author capability: the workflow trigger, the agent's
 * creation data, the feedback snapshot the workflow hands it, the structured
 * result it must submit, and the ownership state kept on the pull request.
 */

import * as v from 'valibot';

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * What started an author run. `review` is a CHANGES_REQUESTED review.
 * `review-comment` and `comment` no longer start runs; they stay accepted so
 * runs queued before that change still parse.
 */
export const AUTHOR_TRIGGERS = [
	'adopted',
	'review',
	'check-failure',
	'review-comment',
	'comment',
] as const;

export type AuthorTrigger = (typeof AUTHOR_TRIGGERS)[number];

/**
 * One author workflow run per GitHub delivery. Like triage, the workflow
 * re-reads the pull request and all of its feedback when it runs, so a run
 * queued behind another acts on fresh state and several deliveries that
 * arrived while the persona was busy collapse into one round.
 */
export const authorWorkflowParamsSchema = v.object({
	deliveryId: nonEmptyString,
	installationId: positiveInteger,
	repositoryId: positiveInteger,
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: positiveInteger,
	defaultBranch: nonEmptyString,
	repoIsPrivate: v.optional(v.boolean(), false),
	trigger: v.picklist(AUTHOR_TRIGGERS),
	actor: v.optional(v.string()),
});

export type AuthorWorkflowParams = v.InferOutput<
	typeof authorWorkflowParamsSchema
>;

export function authorCoordinatorKey(
	input: Pick<AuthorWorkflowParams, 'repositoryId' | 'pullNumber'>,
): string {
	return `${input.repositoryId}:${input.pullNumber}`;
}

/**
 * The persona keeps one durable conversation per pull request it owns, so
 * each round of feedback lands in the same history and the agent remembers
 * what it already tried.
 */
export function authorAgentId(
	repositoryId: number,
	pullNumber: number,
): string {
	return `author:${repositoryId}:${pullNumber}`;
}

/**
 * One sandbox per pull request. Runs for a pull request are serialized by its
 * coordinator, and every run re-creates the checkout, so reusing the id is
 * safe. Sandbox ids become DNS labels: lowercase alphanumeric/hyphen.
 */
export function authorSandboxId(
	repositoryId: number,
	pullNumber: number,
): string {
	return `a-${repositoryId}-${pullNumber}`;
}

export const authorAgentInputSchema = v.object({
	sandboxId: nonEmptyString,
	owner: nonEmptyString,
	repo: nonEmptyString,
	pullNumber: positiveInteger,
	headRef: nonEmptyString,
	baseRef: nonEmptyString,
	skillName: nonEmptyString,
	skillDirectory: nonEmptyString,
	model: nonEmptyString,
	personaLogin: nonEmptyString,
});

export type AuthorAgentInput = v.InferOutput<typeof authorAgentInputSchema>;

// ---------- Feedback snapshot ----------

export interface FeedbackAuthor {
	login: string;
	association: string;
	/** Written by this Factory installation (e.g. the reviewer persona). */
	factory: boolean;
	bot: boolean;
}

export interface FeedbackComment {
	kind: 'comment' | 'review';
	author: FeedbackAuthor;
	/** Review state (`CHANGES_REQUESTED`, `COMMENTED`, ...) for reviews. */
	state: string | null;
	/**
	 * A review requesting changes: the CHANGES_REQUESTED state, or this
	 * installation's reviewer verdict posted as a comment where GitHub
	 * refuses the App a real "request changes" (pull requests it opened).
	 */
	requestsChanges?: boolean;
	body: string;
	createdAt: string;
	url: string;
}

export interface FeedbackThreadComment {
	author: FeedbackAuthor;
	body: string;
	createdAt: string;
}

export interface FeedbackThread {
	threadId: string;
	path: string;
	line: number | null;
	isOutdated: boolean;
	url: string;
	/** Who opened the thread. Only trusted threads reach the agent. */
	startedBy: FeedbackAuthor;
	comments: FeedbackThreadComment[];
	/** Comments from untrusted accounts, withheld from the agent. */
	omittedComments: number;
}

export interface FailingCheck {
	name: string;
	conclusion: string;
	title: string | null;
	summary: string | null;
	detailsUrl: string | null;
	/** GitHub Actions job id, when the check is an Actions job. */
	jobId: number | null;
}

export interface PullRequestSnapshot {
	title: string;
	body: string;
	state: string;
	/** Login of whoever opened the pull request; null for a deleted account. */
	author: string | null;
	headRef: string;
	headSha: string;
	baseRef: string;
	isCrossRepository: boolean;
	assignees: string[];
	/** Recent assignment events, oldest first. */
	assignments: Array<{ login: string; createdAt: string }>;
	comments: FeedbackComment[];
	threads: FeedbackThread[];
}

// ---------- Agent result ----------

export const MAX_THREAD_REPLIES = 50;

const threadReplySchema = v.object({
	threadId: nonEmptyString,
	body: v.pipe(nonEmptyString, v.maxLength(4_000)),
	resolve: v.pipe(
		v.boolean(),
		v.description('true only when your change fully addresses the thread.'),
	),
	declined: v.pipe(
		v.optional(v.boolean(), false),
		v.description(
			'true when you disagree with the finding and deliberately made no change for it; your reply must explain why. Never together with resolve.',
		),
	),
});

/**
 * What the agent submits. Structural only: the thread ids it may reply to
 * change every round while the agent's tools are fixed per conversation, so
 * the workflow checks ids with {@link createAuthorResultSchema}.
 */
export const authorSubmissionSchema = v.object({
	summary: v.pipe(
		nonEmptyString,
		v.maxLength(4_000),
		v.description(
			'What you changed (or why you changed nothing) this round, written for the pull request conversation.',
		),
	),
	commitMessage: v.pipe(
		v.nullable(v.pipe(nonEmptyString, v.maxLength(2_000))),
		v.description(
			'Conventional commit message for your working-tree changes, or null when you changed no files.',
		),
	),
	threadReplies: v.pipe(
		v.array(threadReplySchema),
		v.maxLength(MAX_THREAD_REPLIES),
	),
	needsHuman: v.pipe(
		v.nullable(v.pipe(nonEmptyString, v.maxLength(2_000))),
		v.description(
			'Set when a maintainer decision is needed before you can continue; null otherwise.',
		),
	),
});

/** {@link authorSubmissionSchema}, restricted to this round's threads. */
export function createAuthorResultSchema(threadIds: readonly string[]) {
	const allowed = new Set(threadIds);
	return v.object({
		...authorSubmissionSchema.entries,
		threadReplies: v.pipe(
			v.array(threadReplySchema),
			v.maxLength(MAX_THREAD_REPLIES),
			v.check(
				(replies) => replies.every((reply) => allowed.has(reply.threadId)),
				'Reply only to review threads supplied in the feedback.',
			),
			v.check(
				(replies) =>
					new Set(replies.map((reply) => reply.threadId)).size ===
					replies.length,
				'Reply to each review thread at most once.',
			),
		),
	});
}

export type AuthorResult = v.InferOutput<typeof authorSubmissionSchema>;

// ---------- Ownership state ----------

/**
 * Ownership bookkeeping kept in the persona's status comment on the pull
 * request: visible, and reset by reassigning the persona.
 */
export const authorStateSchema = v.object({
	version: v.literal(1),
	/**
	 * When the assignment this state belongs to happened. A newer assignment
	 * of the persona is a fresh adoption and resets the state, whatever
	 * delivery happens to observe it first.
	 */
	assignedAt: v.nullable(v.string()),
	/** Feedback rounds run since the persona was (re)assigned. */
	round: v.pipe(v.number(), v.integer(), v.minValue(0)),
	/** Feedback created at or before this instant has been handled. */
	lastHandledAt: v.nullable(v.string()),
	/** Head commit whose failing checks have already been attempted. */
	lastCheckSha: v.nullable(v.string()),
	/** The round budget ran out and the persona handed the pull request off. */
	parked: v.boolean(),
});

export type AuthorState = v.InferOutput<typeof authorStateSchema>;

export const INITIAL_AUTHOR_STATE: AuthorState = {
	version: 1,
	assignedAt: null,
	round: 0,
	lastHandledAt: null,
	lastCheckSha: null,
	parked: false,
};

export type AuthorWorkflowOutcome =
	| { outcome: 'ignored'; reason: string }
	| { outcome: 'idle'; reason: string }
	| { outcome: 'handed-off'; round: number }
	| {
			outcome: 'handled';
			round: number;
			pushedSha: string | null;
			replies: number;
			resolved: number;
	  }
	| { outcome: 'failed'; reason: string };
