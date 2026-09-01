import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseSecurityWorkflowParams } from '../src/release-security/contracts.ts';

const { abortAgent, finalizeFailure, liveHead, loadTarget } = vi.hoisted(
	() => ({
		abortAgent: vi.fn(async () => undefined),
		finalizeFailure: vi.fn(async () => ({ reportKey: 'private/report.md' })),
		liveHead: { value: 'b'.repeat(40) },
		loadTarget: vi.fn(async () => ({})),
	}),
);

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

vi.mock('@flue/runtime', () => ({
	init: () => ({ abort: abortAgent }),
}));

vi.mock('../src/github/client.ts', () => ({
	createInstallationClient: vi.fn(async () => ({})),
	credentialsFromWorkerEnv: vi.fn(() => ({})),
}));

vi.mock('../src/release-security/agents/reviewer.ts', () => ({
	ReleaseSecurityReviewer: () => undefined,
}));

vi.mock('../src/release-security/publication.ts', () => ({
	finalizeFailedReleaseSecurityReview: finalizeFailure,
}));

vi.mock('../src/release-security/github.ts', () => ({
	liveTargetMatches: vi.fn(
		(input: { headSha: string }) => input.headSha === liveHead.value,
	),
	loadLiveReleaseSecurityTarget: loadTarget,
}));

import { ReleaseSecurityCoordinator } from '../src/release-security/coordinator.ts';

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

function params(
	deliveryId: string,
	headSha = 'b'.repeat(40),
): ReleaseSecurityWorkflowParams {
	return {
		deliveryId,
		installationId: 1,
		repositoryId: 2,
		owner: 'withastro',
		repo: 'astro',
		pullNumber: 3,
		pullUrl: 'https://github.com/withastro/astro/pull/3',
		pullTitle: 'Release',
		pullBody: '',
		headRef: 'changeset-release/main',
		headSha,
		baseRef: 'main',
		baseSha: 'a'.repeat(40),
		mode: 'release',
		trigger: 'pull-request',
	};
}

function createHarness() {
	const values = new Map<string, unknown>();
	const statuses = new Map<string, WorkflowStatus>();
	const events: string[] = [];
	const terminate = vi.fn(async (_options?: { rollback?: boolean }) => {
		events.push('terminate');
	});
	const create = vi.fn(async ({ id }: { id?: string }) => {
		if (!id) throw new Error('Expected id.');
		if (statuses.has(id)) throw new Error('Already exists.');
		statuses.set(id, 'running');
		return { id };
	});
	const get = vi.fn(async (id: string) => ({
		status: async () => ({ status: statuses.get(id) ?? 'unknown' }),
		terminate: async (options: { rollback?: boolean }) => {
			await terminate(options);
			statuses.set(id, 'terminated');
		},
	}));
	let alarm: number | null = null;
	const storage = {
		get: vi.fn(async (key: string) => {
			const value = values.get(key);
			return value === undefined ? undefined : structuredClone(value);
		}),
		put: vi.fn(async (key: string, value: unknown) => {
			events.push('put');
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
	const coordinator = new ReleaseSecurityCoordinator(
		{ storage } as unknown as DurableObjectState,
		{
			RELEASE_SECURITY_WORKFLOW: { create, get },
		} as unknown as import('../src/env.ts').WorkerEnv,
	);
	return {
		coordinator,
		create,
		statuses,
		terminate,
		events,
		getAlarm: () => alarm,
	};
}

describe('release security coordinator', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		liveHead.value = 'b'.repeat(40);
		loadTarget.mockResolvedValue({});
	});

	it('starts work and keeps a reconciliation alarm while it runs', async () => {
		const { coordinator, create, getAlarm } = createHarness();
		await expect(coordinator.enqueue(params('delivery-1'))).resolves.toEqual({
			disposition: 'started',
			workflowId: 'delivery-1',
		});
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'delivery-1',
				params: params('delivery-1'),
			}),
		);
		expect(getAlarm()).not.toBeNull();
	});

	it('terminates an obsolete head and starts the newest pending review', async () => {
		const { coordinator, create, terminate, events } = createHarness();
		await coordinator.enqueue(params('delivery-1'));
		events.length = 0;
		liveHead.value = 'c'.repeat(40);
		await expect(
			coordinator.enqueue(params('delivery-2', 'c'.repeat(40))),
		).resolves.toMatchObject({
			disposition: 'queued',
			workflowId: 'delivery-2',
			activeWorkflowId: 'delivery-1',
		});
		expect(terminate).toHaveBeenCalledWith({ rollback: true });
		expect(events.indexOf('put')).toBeLessThan(events.indexOf('terminate'));

		await coordinator.alarm();
		expect(finalizeFailure).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ deliveryId: 'delivery-1' }),
			expect.objectContaining({ verdict: 'INCOMPLETE' }),
			undefined,
		);
		expect(create.mock.calls.map(([request]) => request.id)).toEqual([
			'delivery-1',
			'delivery-2',
		]);
	});

	it('rejects a delayed old-head delivery without terminating current work', async () => {
		liveHead.value = 'c'.repeat(40);
		const { coordinator, terminate } = createHarness();
		await coordinator.enqueue(params('delivery-new', liveHead.value));

		await expect(
			coordinator.enqueue(params('delivery-old', 'b'.repeat(40))),
		).resolves.toEqual({
			disposition: 'rejected',
			workflowId: 'delivery-old',
			reason: 'Release pull request no longer matches this delivery.',
		});
		expect(terminate).not.toHaveBeenCalled();
	});

	it('queues an explicit rerequest of the active target', async () => {
		const { coordinator, terminate } = createHarness();
		await coordinator.enqueue(params('delivery-1'));

		await expect(
			coordinator.enqueue({
				...params('delivery-2'),
				trigger: 'rerequest',
			}),
		).resolves.toEqual({
			disposition: 'queued',
			workflowId: 'delivery-2',
			activeWorkflowId: 'delivery-1',
		});
		expect(terminate).not.toHaveBeenCalled();
	});

	it('retains pending work when its live-target lookup temporarily fails', async () => {
		const { coordinator, create } = createHarness();
		await coordinator.enqueue(params('delivery-1'));
		liveHead.value = 'c'.repeat(40);
		await coordinator.enqueue(params('delivery-2', liveHead.value));
		loadTarget.mockRejectedValueOnce(new Error('GitHub unavailable'));

		await coordinator.alarm();
		expect(create).toHaveBeenCalledTimes(1);
		await coordinator.alarm();
		expect(create.mock.calls.map(([request]) => request.id)).toEqual([
			'delivery-1',
			'delivery-2',
		]);
	});

	it('does not start pending work until the superseded workflow is stopped', async () => {
		const error = vi
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const { coordinator, create, terminate } = createHarness();
		await coordinator.enqueue(params('delivery-1'));
		liveHead.value = 'c'.repeat(40);
		terminate.mockRejectedValueOnce(new Error('termination unavailable'));

		await coordinator.enqueue(params('delivery-2', liveHead.value));
		expect(create).toHaveBeenCalledTimes(1);
		await coordinator.alarm();
		expect(create.mock.calls.map(([request]) => request.id)).toEqual([
			'delivery-1',
			'delivery-2',
		]);
		error.mockRestore();
	});

	it('discards pending work that is definitively stale', async () => {
		const { coordinator, create, getAlarm } = createHarness();
		await coordinator.enqueue(params('delivery-1'));
		liveHead.value = 'c'.repeat(40);
		await coordinator.enqueue(params('delivery-2', liveHead.value));
		liveHead.value = 'd'.repeat(40);

		await coordinator.alarm();
		expect(create).toHaveBeenCalledTimes(1);
		expect(getAlarm()).toBeNull();
	});

	it('terminalizes a running workflow that stops reporting progress', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-31T00:00:00Z'));
		const { coordinator, terminate } = createHarness();
		await coordinator.enqueue(params('delivery-1'));
		await coordinator.track('delivery-1', {
			stage: 'security agent running',
			checkRunId: 42,
			agentId: 'release-security:agent',
		});
		vi.setSystemTime(new Date('2026-08-31T01:41:00Z'));

		await coordinator.alarm();
		expect(terminate).toHaveBeenCalledWith({ rollback: true });
		expect(abortAgent).toHaveBeenCalledOnce();
		expect(finalizeFailure).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ deliveryId: 'delivery-1' }),
			expect.objectContaining({ verdict: 'INCOMPLETE' }),
			42,
		);
	});
});
