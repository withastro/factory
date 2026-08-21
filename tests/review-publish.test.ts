import { describe, expect, it, vi } from 'vitest';
import type { InstallationClient } from '../src/github/client.ts';
import type { ReviewResult } from '../src/review/contracts.ts';
import { REVIEW_DISCLOSURE, reviewMarker } from '../src/review/diff.ts';
import {
	type PublishReviewInput,
	publishReview,
} from '../src/review/publish.ts';

const input: PublishReviewInput = {
	owner: 'withastro',
	repo: 'astro',
	pullNumber: 123,
	headSha: 'b'.repeat(40),
	deliveryId: 'delivery-id',
};
const result: ReviewResult = {
	summary: 'One issue found.',
	addressedThreadIds: [],
	findings: [
		{
			path: 'src/example.ts',
			line: 2,
			side: 'RIGHT',
			severity: 'high',
			area: 'correctness',
			title: 'Wrong return value',
			body: 'Return the computed result instead.',
		},
	],
};

function createClient(options: { existingReview?: boolean } = {}) {
	const listReviews = vi.fn();
	const listFiles = vi.fn();
	const createReview = vi.fn(async () => ({
		data: {
			id: 42,
			html_url: 'https://github.com/withastro/astro/pull/123#review-42',
		},
	}));
	const client = {
		rest: {
			pulls: {
				get: vi.fn(async () => ({
					data: {
						state: 'open',
						head: { sha: input.headSha },
						labels: [],
					},
				})),
				listReviews,
				listFiles,
				createReview,
			},
		},
		paginate: vi.fn(async (method: unknown) => {
			if (method === listReviews) {
				return options.existingReview
					? [
							{
								id: 7,
								html_url:
									'https://github.com/withastro/astro/pull/123#review-7',
								body: reviewMarker(input.deliveryId, input.headSha),
							},
						]
					: [];
			}
			if (method === listFiles) {
				return [
					{
						filename: 'src/example.ts',
						patch: '@@ -1,1 +1,2 @@\n old\n+new',
					},
				];
			}
			throw new Error('Unexpected pagination method.');
		}),
	} as unknown as InstallationClient;
	return { client, createReview };
}

describe('review publication', () => {
	it('publishes against the reviewed commit after the trigger label is removed', async () => {
		const { client, createReview } = createClient();
		await expect(publishReview(client, input, result)).resolves.toEqual({
			outcome: 'published',
			reviewId: 42,
			reviewUrl: 'https://github.com/withastro/astro/pull/123#review-42',
			comments: 1,
		});
		expect(createReview).toHaveBeenCalledWith(
			expect.objectContaining({
				commit_id: input.headSha,
				body: expect.stringContaining(`*${REVIEW_DISCLOSURE}*`),
				comments: [
					expect.objectContaining({
						path: 'src/example.ts',
						line: 2,
						side: 'RIGHT',
						body: expect.stringContaining(
							'`[high][correctness]`: Wrong return value',
						),
					}),
				],
			}),
		);
	});

	it('does not republish a delivery marker that already exists', async () => {
		const { client, createReview } = createClient({ existingReview: true });
		await expect(publishReview(client, input, result)).resolves.toEqual({
			outcome: 'already-published',
			reviewId: 7,
			reviewUrl: 'https://github.com/withastro/astro/pull/123#review-7',
		});
		expect(createReview).not.toHaveBeenCalled();
	});
});
