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

interface ExistingCheck {
	id: number;
	external_id: string;
	status: string;
}

function createClient(existingChecks: ExistingCheck[] = []) {
	const listForRef = vi.fn(async () => ({
		data: { check_runs: existingChecks },
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
		const { client, create } = createClient([
			{ id: 7, external_id: input.deliveryId, status: 'in_progress' },
		]);

		await expect(startReviewCheck(client, input)).resolves.toBe(7);
		expect(create).not.toHaveBeenCalled();
	});

	it('creates a new check when a previous run for the delivery completed', async () => {
		const { client, create } = createClient([
			{ id: 7, external_id: input.deliveryId, status: 'completed' },
		]);

		await expect(startReviewCheck(client, input)).resolves.toBe(42);
		expect(create).toHaveBeenCalledOnce();
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

	it('reconciles every duplicate check when the created id is unavailable', async () => {
		const { client, update } = createClient([
			{ id: 7, external_id: input.deliveryId, status: 'in_progress' },
			{ id: 8, external_id: input.deliveryId, status: 'in_progress' },
			{ id: 9, external_id: 'another-delivery', status: 'in_progress' },
		]);

		await completeReviewCheck(client, input);
		expect(update).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({ check_run_id: 7 }));
		expect(update).toHaveBeenNthCalledWith(2, expect.objectContaining({ check_run_id: 8 }));
	});

	it('retries reconciliation when an ambiguous create is not visible yet', async () => {
		const { client } = createClient();

		await expect(completeReviewCheck(client, input)).rejects.toThrow(
			'No Astro Review check run exists for delivery delivery-id.',
		);
	});
});
