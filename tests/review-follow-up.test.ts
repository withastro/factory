import { describe, expect, it, vi } from "vitest";
import type { InstallationClient } from "../src/github/client.ts";
import {
	MAX_REVIEW_THREAD_SNAPSHOT_BYTES,
	type UnresolvedReviewThread,
} from "../src/review/contracts.ts";
import { reviewMarker } from "../src/review/diff.ts";
import {
	loadLatestUnresolvedReviewThreads,
	resolveAddressedReviewThreads,
} from "../src/review/follow-up.ts";

const REVIEW_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const input = { owner: "withastro", repo: "astro", pullNumber: 123 };

function review(
	id: string,
	options: { viewerDidAuthor?: boolean; marker?: boolean; commitSha?: string } = {},
) {
	const commitSha = options.commitSha ?? REVIEW_SHA;
	return {
		id,
		body:
			options.marker === false
				? "A review without a Factory marker."
				: reviewMarker(`delivery-${id}`, REVIEW_SHA),
		viewerDidAuthor: options.viewerDidAuthor ?? true,
		commit: { oid: commitSha },
	};
}

function thread(
	id: string,
	reviewId: string,
	options: {
		resolved?: boolean;
		canResolve?: boolean;
		body?: string;
		diffHunk?: string;
	} = {},
) {
	return {
		id,
		isResolved: options.resolved ?? false,
		isOutdated: false,
		viewerCanResolve: options.canResolve ?? true,
		path: "src/example.ts",
		line: 12,
		originalLine: 10,
		diffSide: "RIGHT",
		startLine: null,
		originalStartLine: null,
		startDiffSide: null,
		subjectType: "LINE",
		comments: {
			totalCount: 1,
			nodes: [
				{
					id: `comment-${id}`,
					body: options.body ?? "The returned value is incorrect.",
					diffHunk: options.diffHunk ?? "@@ -10,1 +12,1 @@\n-old\n+new",
					url: `https://github.com/withastro/astro/pull/123#discussion_${id}`,
					updatedAt: "2026-08-21T12:00:00Z",
					pullRequestReview: { id: reviewId },
				},
			],
		},
	};
}

function snapshot(overrides: Partial<UnresolvedReviewThread> = {}): UnresolvedReviewThread {
	return {
		threadId: "thread-latest",
		commentId: "comment-thread-latest",
		reviewId: "review-latest",
		reviewHeadSha: REVIEW_SHA,
		body: "The returned value is incorrect.",
		path: "src/example.ts",
		line: 12,
		originalLine: 10,
		diffSide: "RIGHT",
		startLine: null,
		originalStartLine: null,
		startDiffSide: null,
		subjectType: "LINE",
		isOutdated: false,
		diffHunk: "@@ -10,1 +12,1 @@\n-old\n+new",
		url: "https://github.com/withastro/astro/pull/123#discussion_latest",
		commentUpdatedAt: "2026-08-21T12:00:00Z",
		commentCount: 1,
		...overrides,
	};
}

function currentThread(
	expected: UnresolvedReviewThread,
	overrides: {
		isResolved?: boolean;
		viewerCanResolve?: boolean;
		commentUpdatedAt?: string;
		commentCount?: number;
		viewerDidAuthor?: boolean;
	} = {},
) {
	return {
		__typename: "PullRequestReviewThread",
		id: expected.threadId,
		isResolved: overrides.isResolved ?? false,
		viewerCanResolve: overrides.viewerCanResolve ?? true,
		repository: { nameWithOwner: "withastro/astro" },
		pullRequest: { number: 123 },
		comments: {
			totalCount: overrides.commentCount ?? expected.commentCount,
			nodes: [
				{
					id: expected.commentId,
					updatedAt: overrides.commentUpdatedAt ?? expected.commentUpdatedAt,
					pullRequestReview: {
						id: expected.reviewId,
						body: reviewMarker("delivery-old", expected.reviewHeadSha),
						viewerDidAuthor: overrides.viewerDidAuthor ?? true,
						commit: { oid: expected.reviewHeadSha },
					},
				},
			],
		},
	};
}

describe("review follow-up loading", () => {
	it("loads only unresolved threads from the latest prior Factory review", async () => {
		const graphql = vi.fn(async (query: string) => {
			if (query.includes("LatestFactoryReviews")) {
				return {
					repository: {
						pullRequest: {
							reviews: {
								nodes: [
									review("review-old"),
									review("review-latest"),
									review("app-review", { marker: false }),
									review("forged-review", { viewerDidAuthor: false }),
								],
								pageInfo: { hasPreviousPage: false, startCursor: null },
							},
						},
					},
				};
			}
			return {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [
								thread("thread-old", "review-old"),
								thread("thread-latest", "review-latest"),
								thread("thread-resolved", "review-latest", { resolved: true }),
							],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			};
		});
		const client = { graphql } as unknown as InstallationClient;

		await expect(loadLatestUnresolvedReviewThreads(client, input)).resolves.toEqual([
			expect.objectContaining({
				threadId: "thread-latest",
				commentId: "comment-thread-latest",
				reviewId: "review-latest",
				reviewHeadSha: REVIEW_SHA,
			}),
		]);
	});

	it("paginates backward for the latest Factory review and forward for its threads", async () => {
		const graphql = vi.fn(async (query: string, variables: { before?: string; after?: string }) => {
			if (query.includes("LatestFactoryReviews")) {
				return variables.before
					? {
							repository: {
								pullRequest: {
									reviews: {
										nodes: [review("review-latest")],
										pageInfo: { hasPreviousPage: false, startCursor: null },
									},
								},
							},
						}
					: {
							repository: {
								pullRequest: {
									reviews: {
										nodes: [review("human", { viewerDidAuthor: false })],
										pageInfo: { hasPreviousPage: true, startCursor: "reviews-page-1" },
									},
								},
							},
						};
			}
			return variables.after
				? {
						repository: {
							pullRequest: {
								reviewThreads: {
									nodes: [thread("thread-latest", "review-latest")],
									pageInfo: { hasNextPage: false, endCursor: null },
								},
							},
						},
					}
				: {
						repository: {
							pullRequest: {
								reviewThreads: {
									nodes: [thread("thread-other", "review-other")],
									pageInfo: { hasNextPage: true, endCursor: "threads-page-2" },
								},
							},
						},
					};
		});
		const client = { graphql } as unknown as InstallationClient;

		await expect(loadLatestUnresolvedReviewThreads(client, input)).resolves.toEqual([
			expect.objectContaining({ threadId: "thread-latest" }),
		]);
		expect(graphql).toHaveBeenCalledWith(
			expect.stringContaining("LatestFactoryReviews"),
			expect.objectContaining({ before: "reviews-page-1" }),
		);
		expect(graphql).toHaveBeenCalledWith(
			expect.stringContaining("FactoryReviewThreads"),
			expect.objectContaining({ after: "threads-page-2" }),
		);
	});

	it("does not fall back to an older review when the latest review has no open threads", async () => {
		const graphql = vi.fn(async (query: string) => {
			if (query.includes("LatestFactoryReviews")) {
				return {
					repository: {
						pullRequest: {
							reviews: {
								nodes: [review("review-old"), review("review-latest")],
								pageInfo: { hasPreviousPage: false, startCursor: null },
							},
						},
					},
				};
			}
			return {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [thread("thread-old", "review-old")],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			};
		});

		await expect(
			loadLatestUnresolvedReviewThreads({ graphql } as unknown as InstallationClient, input),
		).resolves.toEqual([]);
	});

	it("keeps the persisted thread snapshot below the Workflow step-result limit", async () => {
		const largeThreads = Array.from({ length: 20 }, (_, index) =>
			thread(`thread-${index}`, "review-latest", {
				body: "€".repeat(8_000),
				diffHunk: "€".repeat(20_000),
			}),
		);
		const graphql = vi.fn(async (query: string) => {
			if (query.includes("LatestFactoryReviews")) {
				return {
					repository: {
						pullRequest: {
							reviews: {
								nodes: [review("review-latest")],
								pageInfo: { hasPreviousPage: false, startCursor: null },
							},
						},
					},
				};
			}
			return {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: largeThreads,
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			};
		});

		const result = await loadLatestUnresolvedReviewThreads(
			{ graphql } as unknown as InstallationClient,
			input,
		);

		expect(result).toHaveLength(20);
		expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
			MAX_REVIEW_THREAD_SNAPSHOT_BYTES,
		);
		expect(result.some((item) => item.diffHunk.endsWith("[truncated]"))).toBe(true);
	});
});

describe("review follow-up resolution", () => {
	it("resolves only selected threads after revalidating their snapshots", async () => {
		const selected = snapshot();
		const unaddressed = snapshot({ threadId: "thread-unaddressed" });
		const graphql = vi.fn(async (query: string) => {
			if (query.includes("RevalidateFactoryReviewThreads")) {
				return { nodes: [currentThread(selected)] };
			}
			return {
				resolveReviewThread: {
					thread: { id: selected.threadId, isResolved: true },
				},
			};
		});
		const get = vi.fn(async () => ({
			data: { state: "open", head: { sha: HEAD_SHA } },
		}));
		const client = { graphql, rest: { pulls: { get } } } as unknown as InstallationClient;

		await expect(
			resolveAddressedReviewThreads(
				client,
				{ ...input, headSha: HEAD_SHA, deliveryId: "delivery-current" },
				[selected, unaddressed],
				[selected.threadId],
			),
		).resolves.toEqual({ resolved: 1, alreadyResolved: 0, skipped: 0, stale: false });
		expect(graphql).toHaveBeenCalledTimes(2);
		expect(graphql).toHaveBeenLastCalledWith(
			expect.stringContaining("ResolveFactoryReviewThread"),
			expect.objectContaining({ threadId: selected.threadId }),
		);
	});

	it("leaves every selected thread untouched when the pull request head changed", async () => {
		const selected = snapshot();
		const graphql = vi.fn();
		const client = {
			graphql,
			rest: {
				pulls: {
					get: vi.fn(async () => ({
						data: { state: "open", head: { sha: "c".repeat(40) } },
					})),
				},
			},
		} as unknown as InstallationClient;

		await expect(
			resolveAddressedReviewThreads(
				client,
				{ ...input, headSha: HEAD_SHA, deliveryId: "delivery-current" },
				[selected],
				[selected.threadId],
			),
		).resolves.toEqual({ resolved: 0, alreadyResolved: 0, skipped: 1, stale: true });
		expect(graphql).not.toHaveBeenCalled();
	});

	it("skips a thread whose discussion changed while the agent was running", async () => {
		const selected = snapshot();
		const graphql = vi.fn(async () => ({
			nodes: [currentThread(selected, { commentCount: 2 })],
		}));
		const client = {
			graphql,
			rest: {
				pulls: {
					get: vi.fn(async () => ({
						data: { state: "open", head: { sha: HEAD_SHA } },
					})),
				},
			},
		} as unknown as InstallationClient;

		await expect(
			resolveAddressedReviewThreads(
				client,
				{ ...input, headSha: HEAD_SHA, deliveryId: "delivery-current" },
				[selected],
				[selected.threadId],
			),
		).resolves.toEqual({ resolved: 0, alreadyResolved: 0, skipped: 1, stale: false });
		expect(graphql).toHaveBeenCalledOnce();
	});

	it("treats an already-resolved selected thread as an idempotent success", async () => {
		const selected = snapshot();
		const graphql = vi.fn(async () => ({
			nodes: [currentThread(selected, { isResolved: true })],
		}));
		const client = {
			graphql,
			rest: {
				pulls: {
					get: vi.fn(async () => ({
						data: { state: "open", head: { sha: HEAD_SHA } },
					})),
				},
			},
		} as unknown as InstallationClient;

		await expect(
			resolveAddressedReviewThreads(
				client,
				{ ...input, headSha: HEAD_SHA, deliveryId: "delivery-current" },
				[selected],
				[selected.threadId],
			),
		).resolves.toEqual({ resolved: 0, alreadyResolved: 1, skipped: 0, stale: false });
		expect(graphql).toHaveBeenCalledOnce();
	});

	it("rejects thread IDs that were not supplied to the agent", async () => {
		const selected = snapshot();
		const client = { graphql: vi.fn(), rest: { pulls: { get: vi.fn() } } } as unknown as InstallationClient;

		await expect(
			resolveAddressedReviewThreads(
				client,
				{ ...input, headSha: HEAD_SHA, deliveryId: "delivery-current" },
				[selected],
				["thread-unknown"],
			),
		).rejects.toThrow("Unknown addressed review thread thread-unknown.");
	});
});
