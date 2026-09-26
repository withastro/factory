/**
 * GitHub reads and writes for the code author persona. Reads build the
 * snapshot the workflow selects feedback from; writes are the persona's
 * thread replies, thread resolutions, and status comment. All run with the
 * App installation client in trusted workflow code, never in the agent.
 */

import type { InstallationClient } from '../github/client.ts';
import { isGitHubStatus } from '../github/content.ts';
import type {
	FailingCheck,
	FeedbackAuthor,
	FeedbackComment,
	FeedbackThread,
	PullRequestSnapshot,
} from './contracts.ts';

const MAX_BODY = 4_000;
const MAX_CHECK_SUMMARY = 2_000;
export const MAX_FAILING_CHECKS = 5;
export const MAX_CHECK_LOG_BYTES = 30_000;

const PULL_REQUEST_QUERY = `
	query AuthorPullRequest($owner: String!, $repo: String!, $pullNumber: Int!) {
		repository(owner: $owner, name: $repo) {
			pullRequest(number: $pullNumber) {
				title
				body
				state
				headRefName
				headRefOid
				baseRefName
				isCrossRepository
				assignees(first: 20) { nodes { login } }
				timelineItems(last: 50, itemTypes: [ASSIGNED_EVENT]) {
					nodes {
						... on AssignedEvent {
							createdAt
							assignee { ... on User { login } }
						}
					}
				}
				comments(last: 50) {
					nodes {
						author { login __typename }
						authorAssociation
						viewerDidAuthor
						body
						createdAt
						url
					}
				}
				reviews(last: 30) {
					nodes {
						author { login __typename }
						authorAssociation
						viewerDidAuthor
						state
						body
						submittedAt
						url
					}
				}
				reviewThreads(first: 100) {
					nodes {
						id
						isResolved
						isOutdated
						path
						line
						opening: comments(first: 1) {
							nodes {
								author { login __typename }
								authorAssociation
								viewerDidAuthor
								url
							}
						}
						recent: comments(last: 15) {
							totalCount
							nodes {
								author { login __typename }
								authorAssociation
								viewerDidAuthor
								body
								createdAt
							}
						}
					}
				}
			}
		}
	}
`;

interface GraphqlAuthorFields {
	author: { login: string; __typename: string } | null;
	authorAssociation: string;
	viewerDidAuthor: boolean;
}

interface PullRequestResponse {
	repository: {
		pullRequest: {
			title: string;
			body: string;
			state: string;
			headRefName: string;
			headRefOid: string;
			baseRefName: string;
			isCrossRepository: boolean;
			assignees: { nodes: Array<{ login: string } | null> | null };
			timelineItems: {
				nodes: Array<{
					createdAt?: string;
					assignee?: { login?: string } | null;
				} | null> | null;
			};
			comments: {
				nodes: Array<
					| (GraphqlAuthorFields & {
							body: string;
							createdAt: string;
							url: string;
					  })
					| null
				> | null;
			};
			reviews: {
				nodes: Array<
					| (GraphqlAuthorFields & {
							state: string;
							body: string;
							submittedAt: string | null;
							url: string;
					  })
					| null
				> | null;
			};
			reviewThreads: {
				nodes: Array<{
					id: string;
					isResolved: boolean;
					isOutdated: boolean;
					path: string;
					line: number | null;
					opening: {
						nodes: Array<(GraphqlAuthorFields & { url: string }) | null> | null;
					};
					recent: {
						totalCount: number;
						nodes: Array<
							(GraphqlAuthorFields & { body: string; createdAt: string }) | null
						> | null;
					};
				} | null> | null;
			};
		} | null;
	} | null;
}

export async function loadPullRequestSnapshot(
	client: InstallationClient,
	input: { owner: string; repo: string; pullNumber: number },
): Promise<PullRequestSnapshot> {
	const response = await client.graphql<PullRequestResponse>(
		PULL_REQUEST_QUERY,
		input,
	);
	const pull = response.repository?.pullRequest;
	if (!pull)
		throw new Error(`Pull request #${input.pullNumber} was not found.`);

	const comments: FeedbackComment[] = [];
	for (const comment of pull.comments.nodes ?? []) {
		if (!comment) continue;
		comments.push({
			kind: 'comment',
			author: feedbackAuthor(comment),
			state: null,
			body: truncate(comment.body, MAX_BODY),
			createdAt: comment.createdAt,
			url: comment.url,
		});
	}
	for (const review of pull.reviews.nodes ?? []) {
		if (!review?.submittedAt) continue;
		comments.push({
			kind: 'review',
			author: feedbackAuthor(review),
			state: review.state,
			body: truncate(review.body, MAX_BODY),
			createdAt: review.submittedAt,
			url: review.url,
		});
	}
	comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

	const threads: FeedbackThread[] = [];
	for (const thread of pull.reviewThreads.nodes ?? []) {
		if (!thread || thread.isResolved) continue;
		const opening = thread.opening.nodes?.[0];
		if (!opening) continue;
		const recent = (thread.recent.nodes ?? []).filter(
			(comment) => comment !== null,
		);
		threads.push({
			threadId: thread.id,
			path: thread.path,
			line: thread.line,
			isOutdated: thread.isOutdated,
			url: opening.url,
			startedBy: feedbackAuthor(opening),
			comments: recent.map((comment) => ({
				author: feedbackAuthor(comment),
				body: truncate(comment.body, MAX_BODY),
				createdAt: comment.createdAt,
			})),
			// Untrusted comments are counted when feedback is selected. Comments
			// older than the recent window are simply not shown.
			omittedComments: 0,
		});
	}

	return {
		title: pull.title,
		body: truncate(pull.body, MAX_BODY),
		state: pull.state.toLowerCase(),
		headRef: pull.headRefName,
		headSha: pull.headRefOid.toLowerCase(),
		baseRef: pull.baseRefName,
		isCrossRepository: pull.isCrossRepository,
		assignees: (pull.assignees.nodes ?? [])
			.filter((node) => node !== null)
			.map((node) => node.login),
		assignments: (pull.timelineItems.nodes ?? []).flatMap((node) =>
			node?.createdAt && node.assignee?.login
				? [{ login: node.assignee.login, createdAt: node.createdAt }]
				: [],
		),
		comments,
		threads,
	};
}

function feedbackAuthor(fields: GraphqlAuthorFields): FeedbackAuthor {
	return {
		// A deleted account comes back as a null author.
		login: fields.author?.login ?? 'ghost',
		association: fields.authorAssociation,
		factory: fields.viewerDidAuthor,
		bot: fields.author?.__typename === 'Bot',
	};
}

/** Latest failing check runs on a commit, capped to keep the snapshot small. */
export async function loadFailingChecks(
	client: InstallationClient,
	input: { owner: string; repo: string; sha: string },
): Promise<FailingCheck[]> {
	const runs = await client.paginate(client.rest.checks.listForRef, {
		owner: input.owner,
		repo: input.repo,
		ref: input.sha,
		filter: 'latest',
		per_page: 100,
	});
	return runs
		.filter(
			(run) => run.conclusion === 'failure' || run.conclusion === 'timed_out',
		)
		.slice(0, MAX_FAILING_CHECKS)
		.map((run) => ({
			name: run.name,
			conclusion: run.conclusion ?? 'failure',
			title: run.output?.title ?? null,
			summary: run.output?.summary
				? truncate(run.output.summary, MAX_CHECK_SUMMARY)
				: null,
			detailsUrl: run.details_url ?? run.html_url ?? null,
			jobId: run.app?.slug === 'github-actions' ? run.id : null,
		}));
}

/**
 * Tail of a GitHub Actions job log, or null when it can't be read (expired,
 * not an Actions job, missing permission). Logs are agent context, not a
 * reason to fail the round.
 */
export async function loadCheckLogTail(
	client: InstallationClient,
	input: { owner: string; repo: string; jobId: number },
): Promise<string | null> {
	try {
		const response = await client.rest.actions.downloadJobLogsForWorkflowRun({
			owner: input.owner,
			repo: input.repo,
			job_id: input.jobId,
		});
		const text =
			typeof response.data === 'string'
				? response.data
				: new TextDecoder().decode(response.data as ArrayBuffer);
		return text.length <= MAX_CHECK_LOG_BYTES
			? text
			: text.slice(-MAX_CHECK_LOG_BYTES);
	} catch (error) {
		console.warn(
			`Could not read logs for Actions job ${input.jobId}:`,
			error instanceof Error ? error.message : String(error),
		);
		return null;
	}
}

// ---------- Status comment ----------

export interface StatusComment {
	id: number;
	body: string;
}

/**
 * The persona's status comment, identified by marker *and* by having been
 * written by this GitHub App. The marker alone is not enough: anyone can post
 * a comment containing it, and the state it carries gates the round budget.
 */
export async function findStatusComment(
	client: InstallationClient,
	input: { owner: string; repo: string; pullNumber: number },
	marker: string,
	appId: number,
): Promise<StatusComment | null> {
	const comments = await client.paginate(client.rest.issues.listComments, {
		owner: input.owner,
		repo: input.repo,
		issue_number: input.pullNumber,
		per_page: 100,
	});
	const found = comments.find(
		(comment) =>
			comment.performed_via_github_app?.id === appId &&
			comment.body?.includes(marker),
	);
	return found ? { id: found.id, body: found.body ?? '' } : null;
}

/**
 * Create or update the persona's status comment. Without a known id it looks
 * the comment up first, so a retried step never posts a second one, and it
 * recreates the comment if a maintainer deleted it.
 */
export async function saveStatusComment(
	client: InstallationClient,
	input: { owner: string; repo: string; pullNumber: number },
	existingId: number | null,
	body: string,
	marker: string,
	appId: number,
): Promise<number> {
	const id =
		existingId ?? (await findStatusComment(client, input, marker, appId))?.id;
	if (id !== undefined) {
		try {
			await client.rest.issues.updateComment({
				owner: input.owner,
				repo: input.repo,
				comment_id: id,
				body,
			});
			return id;
		} catch (error) {
			if (!isGitHubStatus(error, 404)) throw error;
		}
	}
	const created = await client.rest.issues.createComment({
		owner: input.owner,
		repo: input.repo,
		issue_number: input.pullNumber,
		body,
	});
	return created.data.id;
}

// ---------- Review threads ----------

const REPLY_MUTATION = `
	mutation ReplyToReviewThread($threadId: ID!, $body: String!) {
		addPullRequestReviewThreadReply(input: {
			pullRequestReviewThreadId: $threadId
			body: $body
		}) {
			comment { id }
		}
	}
`;

const RESOLVE_MUTATION = `
	mutation ResolveAuthorReviewThread($threadId: ID!) {
		resolveReviewThread(input: { threadId: $threadId }) {
			thread { id isResolved }
		}
	}
`;

export async function replyToReviewThread(
	client: InstallationClient,
	threadId: string,
	body: string,
): Promise<void> {
	await client.graphql(REPLY_MUTATION, { threadId, body });
}

/**
 * Resolve a thread, tolerating GitHub refusing the installation (the same
 * permission gap the review capability tolerates): the reply already says
 * the thread is addressed.
 */
export async function resolveReviewThread(
	client: InstallationClient,
	threadId: string,
): Promise<boolean> {
	try {
		await client.graphql(RESOLVE_MUTATION, { threadId });
		return true;
	} catch (error) {
		console.warn(
			`Factory could not resolve review thread ${threadId}:`,
			error instanceof Error ? error.message : String(error),
		);
		return false;
	}
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	const suffix = '\n[truncated]';
	return `${value.slice(0, max - suffix.length)}${suffix}`;
}
