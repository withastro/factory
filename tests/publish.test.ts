import { describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '../src/contracts/review.ts';
import type { InstallationClient } from '../src/github/client.ts';
import { reviewMarker } from '../src/github/diff.ts';
import { publishReview, type PublishReviewInput } from '../src/github/publish.ts';

const input: PublishReviewInput = {
	owner: 'withastro',
	repo: 'astro',
	pullNumber: 123,
	headSha: 'b'.repeat(40),
	deliveryId: 'delivery-id',
	triggerLabel: 'astro-review',
};
const result: ReviewResult = {
	summary: 'One issue found.',
	findings: [
		{
			path: 'src/example.ts',
			line: 2,
			side: 'RIGHT',
			severity: 'high',
			title: 'Wrong return value',
			body: 'Return the computed result instead.',
		},
	],
};

function createClient(options: { existingReview?: boolean } = {}) {
	const listReviews = vi.fn();
	const listFiles = vi.fn();
	const createReview = vi.fn(async () => ({
		data: { id: 42, html_url: 'https://github.com/withastro/astro/pull/123#review-42' },
	}));
	const client = {
		rest: {
			pulls: {
				get: vi.fn(async () => ({
					data: {
						state: 'open',
						head: { sha: input.headSha },
						labels: [{ name: input.triggerLabel }],
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
								html_url: 'https://github.com/withastro/astro/pull/123#review-7',
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
	it('publishes validated inline comments against the reviewed commit', async () => {
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
				comments: [
					expect.objectContaining({
						path: 'src/example.ts',
						line: 2,
						side: 'RIGHT',
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

	it('does not publish after the label is removed', async () => {
		const { client, createReview } = createClient();
		vi.mocked(client.rest.pulls.get).mockResolvedValueOnce({
			data: { state: 'open', head: { sha: input.headSha }, labels: [] },
		} as never);

		await expect(publishReview(client, input, result)).resolves.toEqual({
			outcome: 'stale',
			reason: 'The trigger label was removed before publication.',
		});
		expect(createReview).not.toHaveBeenCalled();
	});
});
