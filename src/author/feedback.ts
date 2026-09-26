/**
 * Pure feedback selection for the code author persona: which of a pull
 * request's comments, reviews, review threads, and failing checks it should
 * act on this round, and how that is presented to the agent.
 *
 * Trust is the core concern. Anything the agent reads can steer the code it
 * pushes, so only maintainers (OWNER, MEMBER, COLLABORATOR) and this Factory
 * installation's own reviewer count as feedback; everything else is withheld
 * from the agent entirely rather than merely labelled untrusted.
 */

import * as v from 'valibot';
import {
	type AuthorState,
	authorStateSchema,
	type FailingCheck,
	type FeedbackAuthor,
	type FeedbackComment,
	type FeedbackThread,
	type PullRequestSnapshot,
} from './contracts.ts';

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export const MAX_FEEDBACK_COMMENTS = 20;

/** A maintainer, or this Factory installation itself. */
export function isTrustedAuthor(author: FeedbackAuthor): boolean {
	if (author.factory) return true;
	return !author.bot && TRUSTED_ASSOCIATIONS.has(author.association);
}

export interface AuthorWork {
	/** Trusted top-level comments and review bodies new since the last round. */
	comments: FeedbackComment[];
	/** Unresolved trusted review threads, with untrusted replies withheld. */
	threads: FeedbackThread[];
	/** Failing checks on a head the persona hasn't attempted yet. */
	failingChecks: FailingCheck[];
	/**
	 * Who requested changes since the last round: the reviews this round
	 * answers, and whose review to request again when it is done.
	 */
	changeRequests: ChangeRequester[];
	/** Whether there is anything to act on: requested changes or failing checks. */
	hasNewActivity: boolean;
}

export interface ChangeRequester {
	login: string;
	/** This Factory installation, i.e. the reviewer persona. */
	factory: boolean;
}

/**
 * Select this round's work. A round starts only for requested changes (a
 * trusted CHANGES_REQUESTED review) or failing checks; comments and threads
 * are the context the round reads, never a trigger on their own. That keeps
 * the persona from feeding on its own replies and gives maintainers one
 * deliberate gesture — "Request changes" — to put it to work.
 *
 * `state.lastHandledAt === null` (a fresh adoption) treats all outstanding
 * feedback as new.
 */
export function selectAuthorWork(
	snapshot: PullRequestSnapshot,
	state: AuthorState,
	failingChecks: readonly FailingCheck[],
): AuthorWork {
	const since = state.lastHandledAt;
	const isNew = (createdAt: string) => since === null || createdAt > since;

	const trustedNew = snapshot.comments
		.filter((comment) => isTrustedAuthor(comment.author))
		.filter((comment) => isNew(comment.createdAt));

	const changeRequests: ChangeRequester[] = [];
	for (const review of trustedNew) {
		if (review.kind !== 'review' || !requestsChanges(review)) {
			continue;
		}
		const requester = {
			login: review.author.login,
			factory: review.author.factory,
		};
		if (
			!changeRequests.some(
				(existing) =>
					existing.login.toLowerCase() === requester.login.toLowerCase(),
			)
		) {
			changeRequests.push(requester);
		}
	}

	const comments = trustedNew
		// Factory's own top-level comments are its status and reports, not
		// feedback. Its reviews (the reviewer persona) are feedback.
		.filter(
			(comment) => !(comment.kind === 'comment' && comment.author.factory),
		)
		// An empty review body is just the container for inline comments, which
		// arrive as threads.
		.filter((comment) => comment.body.trim().length > 0)
		.slice(-MAX_FEEDBACK_COMMENTS);

	const threads = snapshot.threads
		.filter((thread) => isTrustedAuthor(thread.startedBy))
		.map((thread) => {
			const trusted = thread.comments.filter((comment) =>
				isTrustedAuthor(comment.author),
			);
			return {
				...thread,
				comments: trusted,
				omittedComments:
					thread.omittedComments + thread.comments.length - trusted.length,
			};
		})
		.filter((thread) => thread.comments.length > 0);

	const checks =
		state.lastCheckSha !== null &&
		state.lastCheckSha.toLowerCase() === snapshot.headSha.toLowerCase()
			? []
			: [...failingChecks];

	return {
		comments,
		threads,
		failingChecks: checks,
		changeRequests,
		hasNewActivity: changeRequests.length > 0 || checks.length > 0,
	};
}

function requestsChanges(review: FeedbackComment): boolean {
	return review.requestsChanges ?? review.state === 'CHANGES_REQUESTED';
}

/**
 * Whose review to request once a round is done, or an empty list for none.
 *
 * Everyone whose requested changes the round answered is asked again, even
 * when the author pushed nothing because it disagreed, so each reviewer can
 * accept the reasoning or stand firm. The reviewer persona is asked through
 * its persona account. Any push also asks the reviewer persona, since the
 * code it last judged has changed; a round that pushed nothing for failing
 * checks asks no one, so a flaky check never triggers a review of unchanged
 * code.
 */
export function reviewersToRequest(input: {
	changeRequests: readonly ChangeRequester[];
	pushed: boolean;
	reviewerLogin: string | undefined;
	pullAuthor: string | undefined;
}): string[] {
	const logins: string[] = [];
	const add = (login: string | undefined) => {
		if (!login) return;
		const normalized = login.toLowerCase();
		// GitHub refuses a review request from a pull request's own author.
		if (input.pullAuthor?.toLowerCase() === normalized) return;
		if (logins.some((existing) => existing.toLowerCase() === normalized)) {
			return;
		}
		logins.push(login);
	};
	for (const requester of input.changeRequests) {
		add(requester.factory ? input.reviewerLogin : requester.login);
	}
	if (input.pushed) add(input.reviewerLogin);
	return logins;
}

// ---------- Ownership state marker ----------

const STATE_MARKER_PREFIX = '<!-- factory:author-state ';
const STATE_MARKER_SUFFIX = ' -->';

/** Identifies the persona's status comment on a pull request. */
export const AUTHOR_STATUS_MARKER = '<!-- factory:author-status -->';

export function formatAuthorStateMarker(state: AuthorState): string {
	return `${STATE_MARKER_PREFIX}${JSON.stringify(state)}${STATE_MARKER_SUFFIX}`;
}

/**
 * Read ownership state from a status comment body. Anything malformed reads
 * as absent, which restarts the budget rather than wedging the persona.
 */
export function parseAuthorState(body: string): AuthorState | undefined {
	const start = body.lastIndexOf(STATE_MARKER_PREFIX);
	if (start === -1) return undefined;
	const end = body.indexOf(
		STATE_MARKER_SUFFIX,
		start + STATE_MARKER_PREFIX.length,
	);
	if (end === -1) return undefined;
	try {
		const json = JSON.parse(
			body.slice(start + STATE_MARKER_PREFIX.length, end),
		) as unknown;
		const parsed = v.safeParse(authorStateSchema, json);
		return parsed.success ? parsed.output : undefined;
	} catch {
		return undefined;
	}
}

// ---------- Agent message ----------

export interface CheckLogFile {
	name: string;
	path: string;
}

/**
 * Render this round's feedback as the signal body the agent receives. All of
 * it is untrusted data from the agent's point of view: the system prompt says
 * so, and nothing here can change the tools it has.
 */
export function formatAuthorFeedback(
	snapshot: Pick<PullRequestSnapshot, 'headRef' | 'headSha'>,
	work: AuthorWork,
	round: number,
	maxRounds: number,
	logFiles: readonly CheckLogFile[],
): string {
	const sections: string[] = [
		`Feedback round ${round} of at most ${maxRounds}. The branch \`${snapshot.headRef}\` is checked out fresh (last seen at ${snapshot.headSha}).`,
	];

	if (work.threads.length > 0) {
		sections.push(
			'## Unresolved review threads',
			'Reply to a thread with its threadId. Resolve it only when your change fully addresses it. If you disagree and change nothing for it, set declined: true and explain why; the reviewer will reconsider.',
		);
		for (const thread of work.threads) {
			const location = `${thread.path}${thread.line ? `:${thread.line}` : ''}${thread.isOutdated ? ' (outdated)' : ''}`;
			const lines = [`### threadId: ${thread.threadId} — ${location}`];
			for (const comment of thread.comments) {
				lines.push(
					`**${describeAuthor(comment.author)}** (${comment.createdAt}):`,
					comment.body,
				);
			}
			if (thread.omittedComments > 0) {
				lines.push(
					`_${thread.omittedComments} comment(s) from accounts without write access were withheld._`,
				);
			}
			sections.push(lines.join('\n\n'));
		}
	}

	if (work.comments.length > 0) {
		sections.push('## New comments and reviews');
		for (const comment of work.comments) {
			const state = requestsChanges(comment)
				? 'CHANGES_REQUESTED'
				: comment.state;
			const kind =
				comment.kind === 'review'
					? `review${state ? ` (${state})` : ''}`
					: 'comment';
			sections.push(
				`**${describeAuthor(comment.author)}** — ${kind}, ${comment.createdAt}:\n\n${comment.body}`,
			);
		}
	}

	if (work.failingChecks.length > 0) {
		sections.push('## Failing checks on the current head');
		for (const check of work.failingChecks) {
			const log = logFiles.find((file) => file.name === check.name);
			sections.push(
				[
					`- **${check.name}**: ${check.conclusion}${check.title ? ` — ${check.title}` : ''}`,
					check.summary ? `  ${check.summary.replaceAll('\n', '\n  ')}` : '',
					log ? `  Log tail: \`${log.path}\`` : '  No log was available.',
				]
					.filter(Boolean)
					.join('\n'),
			);
		}
	}

	sections.push(
		'Address what is actionable, verify it with the repository tooling, then call submit_author_result exactly once.',
	);
	return sections.join('\n\n');
}

function describeAuthor(author: FeedbackAuthor): string {
	if (author.factory) return `@${author.login} (Factory)`;
	return `@${author.login} (${author.association.toLowerCase()})`;
}

/** When `login` was most recently assigned, or null if no event is visible. */
export function latestAssignmentAt(
	snapshot: Pick<PullRequestSnapshot, 'assignments'>,
	login: string,
): string | null {
	const normalized = login.toLowerCase();
	let latest: string | null = null;
	for (const event of snapshot.assignments) {
		if (event.login.toLowerCase() !== normalized) continue;
		if (latest === null || event.createdAt > latest) latest = event.createdAt;
	}
	return latest;
}

const utf8 = new TextEncoder();

/**
 * Shrink comment bodies until the work fits a Workflow step result (1 MiB,
 * with headroom). Bodies are truncated evenly rather than items dropped, so
 * the agent still sees every thread it may reply to.
 */
export function fitAuthorWork(work: AuthorWork, maxBytes: number): AuthorWork {
	const size = (value: unknown) =>
		utf8.encode(JSON.stringify(value)).byteLength;
	if (size(work) <= maxBytes) return work;
	for (const limit of [2_000, 1_000, 500, 200]) {
		const cut = (body: string) =>
			body.length <= limit ? body : `${body.slice(0, limit)}\n[truncated]`;
		const fitted: AuthorWork = {
			...work,
			comments: work.comments.map((comment) => ({
				...comment,
				body: cut(comment.body),
			})),
			threads: work.threads.map((thread) => ({
				...thread,
				comments: thread.comments.map((comment) => ({
					...comment,
					body: cut(comment.body),
				})),
			})),
			failingChecks: work.failingChecks.map((check) => ({
				...check,
				summary: check.summary === null ? null : cut(check.summary),
			})),
		};
		if (size(fitted) <= maxBytes) return fitted;
	}
	throw new Error('The pull request feedback is too large to process.');
}
