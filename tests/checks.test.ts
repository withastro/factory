import { describe, expect, it, vi } from 'vitest';
import type { InstallationClient } from '../src/github/client.ts';
import {
	completeReviewCheck,
	REVIEW_CHECK_NAME,
	startReviewCheck,
	type ReviewCheckInput,
} from '../src/github/checks.ts';

const input: ReviewCheckInput = {
	owner: 'withastro',
	repo: 'astro',
	pullNumber: 123,
	headSha: 'a'.repeat(40),
	deliveryId: 'delivery-id',
};

function createClient(existingId?: number) {
	const listForRef = vi.fn(async () => ({
		data: {
			check_runs:
				existingId === undefined
					? []
					: [{ id: existingId, external_id: input.deliveryId }],
		},
	}));
	const create = vi.fn(async () => ({ data: { id: 42 } }));
	const update = vi.fn(async () => ({ data: { id: 42 } }));
	const client = {
		rest: { checks: { listForRef, create, update } },
	} as unknown as InstallationClient;
	return { client, listForRef, create, update };
}

describe('GitHub review checks', () => {
	it('creates an in-progress check tied to the delivery', async () => {
		const { client, create } = createClient();

		await expect(startReviewCheck(client, input)).resolves.toBe(42);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				name: REVIEW_CHECK_NAME,
				head_sha: input.headSha,
				status: 'in_progress',
				external_id: input.deliveryId,
				details_url: 'https://github.com/withastro/astro/pull/123',
			}),
		);
	});

	it('reuses a check already created for the delivery', async () => {
		const { client, create } = createClient(7);

		await expect(startReviewCheck(client, input)).resolves.toBe(7);
		expect(create).not.toHaveBeenCalled();
	});

	it('always completes the check successfully', async () => {
		const { client, update } = createClient();

		await completeReviewCheck(client, input, 42);
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({
				check_run_id: 42,
				status: 'completed',
				conclusion: 'success',
				external_id: input.deliveryId,
			}),
		);
	});
});
