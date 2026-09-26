import type { InstallationClient } from '../github/client.ts';
import { AUTHOR_DECLINED_MARKER } from '../personas/personas.ts';
import {
	MAX_REVIEW_THREAD_BODY_LENGTH,
	MAX_REVIEW_THREAD_DIFF_LENGTH,
	MAX_REVIEW_THREAD_SNAPSHOT_BYTES,
	MAX_UNRESOLVED_REVIEW_THREADS,
	type UnresolvedReviewThread,
} from './contracts.ts';
import { parseFindingSeverity, parseReviewMarker } from './diff.ts';

const utf8Encoder = new TextEncoder();

const LATEST_REVIEWS_QUERY = `
	query LatestFactoryReviews(
		$owner: String!
		$repo: String!
		$pullNumber: Int!
		$before: String
	) {
		repository(owner: $owner, name: $repo) {
			pullRequest(number: $pullNumber) {
				reviews(last: 100, before: $before) {
					nodes {
						id
						body
						viewerDidAuthor
						commit { oid }
					}
					pageInfo {
						hasPreviousPage
						startCursor
					}
				}
			}
		}
	}
`;

const REVIEW_THREADS_QUERY = `
	query FactoryReviewThreads(
		$owner: String!
		$repo: String!
		$pullNumber: Int!
		$after: String
	) {
		repository(owner: $owner, name: $repo) {
			pullRequest(number: $pullNumber) {
				reviewThreads(first: 100, after: $after) {
					nodes {
						id
						isResolved
						isOutdated
						path
						line
						originalLine
						diffSide
						startLine
						originalStartLine
						startDiffSide
						subjectType
						comments(first: 1) {
							totalCount
							nodes {
								id
								body
								diffHunk
								url
								updatedAt
								pullRequestReview { id }
							}
						}
						latest: comments(last: 1) {
							nodes {
								body
								viewerDidAuthor
							}
						}
					}
					pageInfo {
						hasNextPage
						endCursor
					}
				}
			}
		}
	}
`;

const REVALIDATE_THREADS_QUERY = `
	query RevalidateFactoryReviewThreads($threadIds: [ID!]!) {
		nodes(ids: $threadIds) {
			__typename
			... on PullRequestReviewThread {
				id
				isResolved
				repository { nameWithOwner }
				pullRequest { number }
				comments(first: 1) {
					totalCount
					nodes {
						id
						updatedAt
						pullRequestReview {
							id
							body
							viewerDidAuthor
							commit { oid }
						}
					}
				}
			}
		}
	}
`;

const RESOLVE_THREAD_MUTATION = `
	mutation ResolveFactoryReviewThread(
		$threadId: ID!
		$clientMutationId: String!
	) {
		resolveReviewThread(input: {
			threadId: $threadId
			clientMutationId: $clientMutationId
		}) {
			thread {
				id
				isResolved
			}
		}
	}
`;

export interface ReviewFollowUpInput {
	owner: string;
	repo: string;
	pullNumber: number;
}

export interface ResolveReviewFollowUpInput extends ReviewFollowUpInput {
	headSha: string;
	deliveryId: string;
}

export interface ResolveReviewFollowUpOutcome {
	resolved: number;
	alreadyResolved: number;
	skipped: number;
	stale: boolean;
}

interface FactoryReview {
	id: string;
	headSha: string;
}

interface ReviewPageResponse {
	repository: {
		pullRequest: {
			reviews: {
				nodes: Array<{
					id: string;
					body: string;
					viewerDidAuthor: boolean;
					commit: { oid: string } | null;
				} | null> | null;
				pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
			};
		} | null;
	} | null;
}

interface ThreadPageResponse {
	repository: {
		pullRequest: {
			reviewThreads: {
				nodes: Array<ReviewThreadNode | null> | null;
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
			};
		} | null;
	} | null;
}

type ReviewConnection = NonNullable<
	NonNullable<ReviewPageResponse['repository']>['pullRequest']
>['reviews'];
type ThreadConnection = NonNullable<
	NonNullable<ThreadPageResponse['repository']>['pullRequest']
>['reviewThreads'];

interface ReviewThreadNode {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	path: string;
	line: number | null;
	originalLine: number | null;
	diffSide: 'LEFT' | 'RIGHT';
	startLine: number | null;
	originalStartLine: number | null;
	startDiffSide: 'LEFT' | 'RIGHT' | null;
	subjectType: 'LINE' | 'FILE';
	comments: {
		totalCount: number;
		nodes: Array<{
			id: string;
			body: string;
			diffHunk: string;
			url: string;
			updatedAt: string;
			pullRequestReview: { id: string } | null;
		} | null> | null;
	};
	latest?: {
		nodes: Array<{ body: string; viewerDidAuthor: boolean } | null> | null;
	};
}

interface RevalidateThreadsResponse {
	nodes: Array<{
		__typename: string;
		id?: string;
		isResolved?: boolean;
		repository?: { nameWithOwner: string };
		pullRequest?: { number: number };
		comments?: {
			totalCount: number;
			nodes: Array<{
				id: string;
				updatedAt: string;
				pullRequestReview: {
					id: string;
					body: string;
					viewerDidAuthor: boolean;
					commit: { oid: string } | null;
				} | null;
			} | null> | null;
		};
	} | null>;
}

interface ResolveThreadResponse {
	resolveReviewThread: {
		thread: { id: string; isResolved: boolean } | null;
	} | null;
}

/**
 * Unresolved inline threads opened by any of this installation's reviews.
 *
 * Every Factory review counts, not only the latest: a re-review doesn't
 * repeat findings that still stand, so a finding from an earlier round stays
 * open in its original thread and must still weigh on the verdict.
 */
export async function loadUnresolvedFactoryReviewThreads(
	client: InstallationClient,
	input: ReviewFollowUpInput,
): Promise<UnresolvedReviewThread[]> {
	const reviews = await findFactoryReviews(client, input);
	if (reviews.size === 0) return [];

	const threads: UnresolvedReviewThread[] = [];
	let after: string | null = null;
	while (true) {
		const response: ThreadPageResponse =
			await client.graphql<ThreadPageResponse>(REVIEW_THREADS_QUERY, {
				...input,
				after,
			});
		const connection: ThreadConnection | undefined =
			response.repository?.pullRequest?.reviewThreads;
		if (!connection)
			throw new Error(
				'The pull request was not found while loading review threads.',
			);

		for (const thread of connection.nodes ?? []) {
			if (!thread || thread.isResolved) continue;
			const comment = thread.comments.nodes?.[0];
			const reviewId = comment?.pullRequestReview?.id;
			const review = reviewId ? reviews.get(reviewId) : undefined;
			if (!comment || !review) continue;
			const latest = thread.latest?.nodes?.[0];
			// The author persona's declining reply is the thread's last word, and
			// only a reply this installation wrote can carry the marker.
			const disputed =
				thread.comments.totalCount > 1 &&
				latest?.viewerDidAuthor === true &&
				latest.body.includes(AUTHOR_DECLINED_MARKER);
			threads.push({
				threadId: thread.id,
				commentId: comment.id,
				reviewId: review.id,
				reviewHeadSha: review.headSha,
				body: truncate(comment.body, MAX_REVIEW_THREAD_BODY_LENGTH),
				path: thread.path,
				line: thread.line,
				originalLine: thread.originalLine,
				diffSide: thread.diffSide,
				startLine: thread.startLine,
				originalStartLine: thread.originalStartLine,
				startDiffSide: thread.startDiffSide,
				subjectType: thread.subjectType,
				isOutdated: thread.isOutdated,
				diffHunk: truncate(comment.diffHunk, MAX_REVIEW_THREAD_DIFF_LENGTH),
				url: comment.url,
				commentUpdatedAt: comment.updatedAt,
				commentCount: thread.comments.totalCount,
				severity: parseFindingSeverity(comment.body) ?? null,
				authorDisputed: disputed,
				authorReply:
					disputed && latest
						? truncate(
								latest.body.replace(AUTHOR_DECLINED_MARKER, '').trim(),
								MAX_REVIEW_THREAD_BODY_LENGTH,
							)
						: null,
			});
			if (threads.length > MAX_UNRESOLVED_REVIEW_THREADS) {
				throw new Error(
					`Factory reviews have more than ${MAX_UNRESOLVED_REVIEW_THREADS} unresolved threads.`,
				);
			}
		}

		if (!connection.pageInfo.hasNextPage) {
			return fitThreadsToSnapshotBudget(threads);
		}
		after = connection.pageInfo.endCursor;
		if (!after)
			throw new Error('GitHub omitted the next review-thread cursor.');
	}
}

export async function resolveAddressedReviewThreads(
	client: InstallationClient,
	input: ResolveReviewFollowUpInput,
	threads: readonly UnresolvedReviewThread[],
	addressedThreadIds: readonly string[],
): Promise<ResolveReviewFollowUpOutcome> {
	if (addressedThreadIds.length === 0) {
		return { resolved: 0, alreadyResolved: 0, skipped: 0, stale: false };
	}

	const candidates = new Map(
		threads.map((thread) => [thread.threadId, thread] as const),
	);
	const selected = new Set(addressedThreadIds);
	if (selected.size !== addressedThreadIds.length) {
		throw new Error('Addressed review thread IDs must be unique.');
	}
	for (const id of selected) {
		if (!candidates.has(id))
			throw new Error(`Unknown addressed review thread ${id}.`);
	}

	const pull = await client.rest.pulls.get({
		owner: input.owner,
		repo: input.repo,
		pull_number: input.pullNumber,
	});
	if (pull.data.state !== 'open' || pull.data.head.sha !== input.headSha) {
		return {
			resolved: 0,
			alreadyResolved: 0,
			skipped: addressedThreadIds.length,
			stale: true,
		};
	}

	const response = await client.graphql<RevalidateThreadsResponse>(
		REVALIDATE_THREADS_QUERY,
		{
			threadIds: addressedThreadIds,
		},
	);
	const currentById = new Map(
		response.nodes
			.filter(
				(node) => node?.__typename === 'PullRequestReviewThread' && node.id,
			)
			.map((node) => [node?.id as string, node] as const),
	);
	let resolved = 0;
	let alreadyResolved = 0;
	let skipped = 0;

	for (const threadId of addressedThreadIds) {
		const expected = candidates.get(threadId) as UnresolvedReviewThread;
		const current = currentById.get(threadId);
		const comment = current?.comments?.nodes?.[0];
		const review = comment?.pullRequestReview;
		const marker = review ? parseReviewMarker(review.body) : undefined;
		if (
			!current ||
			current.repository?.nameWithOwner.toLowerCase() !==
				`${input.owner}/${input.repo}`.toLowerCase() ||
			current.pullRequest?.number !== input.pullNumber ||
			!comment ||
			comment.id !== expected.commentId ||
			comment.updatedAt !== expected.commentUpdatedAt ||
			current.comments?.totalCount !== expected.commentCount ||
			!review ||
			review.id !== expected.reviewId ||
			!review.viewerDidAuthor ||
			!marker ||
			marker.headSha !== expected.reviewHeadSha ||
			(review.commit !== null &&
				review.commit.oid.toLowerCase() !== marker.headSha)
		) {
			skipped += 1;
			continue;
		}
		if (current.isResolved) {
			alreadyResolved += 1;
			continue;
		}
		let mutation: ResolveThreadResponse;
		try {
			mutation = await client.graphql<ResolveThreadResponse>(
				RESOLVE_THREAD_MUTATION,
				{
					threadId,
					clientMutationId: `${input.deliveryId}:${threadId}`,
				},
			);
		} catch (error) {
			if (!isForbiddenGraphqlResponse(error)) throw error;
			console.warn(
				`Factory cannot resolve review thread ${threadId}; leaving it unresolved.`,
			);
			skipped += 1;
			continue;
		}
		if (
			mutation.resolveReviewThread?.thread?.id !== threadId ||
			mutation.resolveReviewThread.thread.isResolved !== true
		) {
			throw new Error(`GitHub did not resolve review thread ${threadId}.`);
		}
		resolved += 1;
	}

	return { resolved, alreadyResolved, skipped, stale: false };
}

function isForbiddenGraphqlResponse(error: unknown): boolean {
	if (!error || typeof error !== 'object' || !('errors' in error)) return false;
	const errors = error.errors;
	return (
		Array.isArray(errors) &&
		errors.some(
			(entry) =>
				entry !== null &&
				typeof entry === 'object' &&
				'type' in entry &&
				entry.type === 'FORBIDDEN',
		)
	);
}

/** This installation's reviews on the pull request, by id, with their head. */
async function findFactoryReviews(
	client: InstallationClient,
	input: ReviewFollowUpInput,
): Promise<Map<string, FactoryReview>> {
	const found = new Map<string, FactoryReview>();
	let before: string | null = null;
	while (true) {
		const response: ReviewPageResponse =
			await client.graphql<ReviewPageResponse>(LATEST_REVIEWS_QUERY, {
				...input,
				before,
			});
		const connection: ReviewConnection | undefined =
			response.repository?.pullRequest?.reviews;
		if (!connection)
			throw new Error('The pull request was not found while loading reviews.');
		for (const review of connection.nodes ?? []) {
			if (!review?.viewerDidAuthor) continue;
			const marker = parseReviewMarker(review.body);
			if (!marker) continue;
			if (review.commit && review.commit.oid.toLowerCase() !== marker.headSha)
				continue;
			found.set(review.id, { id: review.id, headSha: marker.headSha });
		}

		if (!connection.pageInfo.hasPreviousPage) return found;
		before = connection.pageInfo.startCursor;
		if (!before) throw new Error('GitHub omitted the previous review cursor.');
	}
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	const suffix = '\n[truncated]';
	return `${value.slice(0, maxLength - suffix.length)}${suffix}`;
}

function fitThreadsToSnapshotBudget(
	threads: readonly UnresolvedReviewThread[],
): UnresolvedReviewThread[] {
	if (serializedBytes(threads) <= MAX_REVIEW_THREAD_SNAPSHOT_BYTES) {
		return [...threads];
	}

	const fitted = threads.map((thread) => ({
		...thread,
		body: '',
		diffHunk: '',
	}));
	let remainingBytes =
		MAX_REVIEW_THREAD_SNAPSHOT_BYTES - serializedBytes(fitted);
	if (remainingBytes < 0) {
		throw new Error(
			'The unresolved review-thread metadata exceeds the Workflow step-result limit.',
		);
	}

	let remainingFields = fitted.length * 2;
	for (let index = 0; index < fitted.length; index += 1) {
		for (const field of ['body', 'diffHunk'] as const) {
			const fieldBudget = Math.floor(remainingBytes / remainingFields);
			const value = truncateJsonString(threads[index][field], fieldBudget);
			fitted[index][field] = value;
			remainingBytes -= jsonStringContentBytes(value);
			remainingFields -= 1;
		}
	}

	return fitted;
}

function truncateJsonString(value: string, maxBytes: number): string {
	if (jsonStringContentBytes(value) <= maxBytes) return value;

	const suffix = '\n[truncated]';
	if (jsonStringContentBytes(suffix) > maxBytes) return '';

	const codePoints = Array.from(value);
	let low = 0;
	let high = codePoints.length;
	let result = suffix;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = `${codePoints.slice(0, middle).join('')}${suffix}`;
		if (jsonStringContentBytes(candidate) <= maxBytes) {
			result = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return result;
}

function jsonStringContentBytes(value: string): number {
	return serializedBytes(value) - 2;
}

function serializedBytes(value: unknown): number {
	return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}
