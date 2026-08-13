import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewWorkflowParams } from '../src/contracts/review.ts';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		protected ctx: unknown;
		protected env: unknown;

		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

import { ReviewCoordinator } from '../src/review-coordinator.ts';

type WorkflowStatus =
	| 'queued'
	| 'running'
	| 'paused'
	| 'errored'
	| 'terminated'
	| 'complete'
	| 'waiting'
	| 'waitingForPause'
	| 'unknown';

function reviewParams(deliveryId: string): ReviewWorkflowParams {
	return {
		deliveryId,
		installationId: 123,
		repositoryId: 456,
		owner: 'withastro',
		repo: 'astro',
		pullNumber: 789,
		label: 'astro-review',
		baseSha: 'a'.repeat(40),
		configurationSha: 'c'.repeat(40),
		headSha: 'b'.repeat(40),
	};
}

function createHarness() {
	const statuses = new Map<string, WorkflowStatus>();
	const values = new Map<string, unknown>();
	let alarm: number | null = null;
	const create = vi.fn(async ({ id }: { id?: string }) => {
		if (!id) throw new Error('Expected a workflow id.');
		if (statuses.has(id)) throw new Error(`Workflow ${id} already exists.`);
		statuses.set(id, 'running');
		return { id };
	});
	const get = vi.fn(async (id: string) => ({
		status: async () => ({ status: statuses.get(id) ?? 'unknown' }),
	}));
	const storage = {
		get: vi.fn(async (key: string) => {
			const value = values.get(key);
			return value === undefined ? undefined : structuredClone(value);
		}),
		put: vi.fn(async (key: string, value: unknown) => {
			values.set(key, structuredClone(value));
		}),
		delete: vi.fn(async (key: string) => values.delete(key)),
		setAlarm: vi.fn(async (time: number) => {
			alarm = time;
		}),
		deleteAlarm: vi.fn(async () => {
			alarm = null;
		}),
	};
	const coordinator = new ReviewCoordinator(
		{ storage } as unknown as DurableObjectState,
		{ REVIEW_WORKFLOW: { create, get } as unknown as Workflow<ReviewWorkflowParams> },
	);
	return {
		coordinator,
		create,
		statuses,
		getAlarm: () => alarm,
		seedState: (state: unknown) => values.set('review-queue', structuredClone(state)),
	};
}

describe('review coordinator', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('starts the first review immediately', async () => {
		const { coordinator, create } = createHarness();

		await expect(coordinator.enqueue(reviewParams('delivery-1'))).resolves.toEqual({
			disposition: 'started',
			workflowId: 'delivery-1',
		});
		expect(create).toHaveBeenCalledWith({
			id: 'delivery-1',
			params: reviewParams('delivery-1'),
		});
	});

	it('queues one review while another review is active', async () => {
		const { coordinator, create, getAlarm } = createHarness();
		await coordinator.enqueue(reviewParams('delivery-1'));

		await expect(coordinator.enqueue(reviewParams('delivery-2'))).resolves.toEqual({
			disposition: 'queued',
			workflowId: 'delivery-2',
			activeWorkflowId: 'delivery-1',
		});
		expect(create).toHaveBeenCalledTimes(1);
		expect(getAlarm()).not.toBeNull();
	});

	it('starts the pending review when the active review completes', async () => {
		const { coordinator, create } = createHarness();
		await coordinator.enqueue(reviewParams('delivery-1'));
		await coordinator.enqueue(reviewParams('delivery-2'));

		await expect(coordinator.complete('delivery-1')).resolves.toEqual({
			completed: true,
			nextWorkflowId: 'delivery-2',
		});
		expect(create.mock.calls.map(([request]) => request.id)).toEqual([
			'delivery-1',
			'delivery-2',
		]);
	});

	it('coalesces repeated pending triggers to the latest delivery', async () => {
		const { coordinator, create } = createHarness();
		await coordinator.enqueue(reviewParams('delivery-1'));
		await coordinator.enqueue(reviewParams('delivery-2'));
		await coordinator.enqueue(reviewParams('delivery-3'));

		await coordinator.complete('delivery-1');
		expect(create.mock.calls.map(([request]) => request.id)).toEqual([
			'delivery-1',
			'delivery-3',
		]);
	});

	it('deduplicates repeated deliveries', async () => {
		const { coordinator, create } = createHarness();
		await coordinator.enqueue(reviewParams('delivery-1'));

		await expect(coordinator.enqueue(reviewParams('delivery-1'))).resolves.toEqual({
			disposition: 'deduplicated',
			workflowId: 'delivery-1',
		});
		expect(create).toHaveBeenCalledTimes(1);
	});

	it('recovers a pending review after an active workflow errors', async () => {
		const { coordinator, create, statuses } = createHarness();
		await coordinator.enqueue(reviewParams('delivery-1'));
		await coordinator.enqueue(reviewParams('delivery-2'));
		statuses.set('delivery-1', 'errored');

		await coordinator.alarm();
		expect(create.mock.calls.map(([request]) => request.id)).toEqual([
			'delivery-1',
			'delivery-2',
		]);
	});

	it('normalizes queued records created before configuration snapshots', async () => {
		const { coordinator, create, seedState, statuses } = createHarness();
		const { configurationSha: _activeSha, ...active } = reviewParams('delivery-1');
		const { configurationSha: _pendingSha, ...pending } = reviewParams('delivery-2');
		seedState({ active: { params: active, phase: 'running' }, pending });
		statuses.set('delivery-1', 'errored');

		await coordinator.alarm();
		expect(create).toHaveBeenCalledWith({
			id: 'delivery-2',
			params: { ...pending, configurationSha: pending.baseSha },
		});
	});
});
