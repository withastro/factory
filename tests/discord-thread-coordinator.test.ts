import { describe, expect, it, vi } from 'vitest';
import type {
	DiscordJob,
	DiscordThreadWorkflowParams,
} from '../src/discord/contracts.ts';
import { discordJobId } from '../src/discord/contracts.ts';

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

const { DiscordThreadCoordinator } = await import(
	'../src/discord/thread-coordinator.ts'
);

const THREAD = '4000000000000000004';

function mention(messageId: string): DiscordThreadWorkflowParams {
	const job: DiscordJob = {
		kind: 'mention',
		messageId,
		authorId: '6',
		authorName: 'Fred',
	};
	return {
		deliveryId: discordJobId(THREAD, job),
		guildId: '2',
		threadId: THREAD,
		botUserId: '1',
		job,
	};
}

function pullRequest(proposalId: string): DiscordThreadWorkflowParams {
	const job: DiscordJob = {
		kind: 'pull-request',
		proposalId,
		requestedById: '6',
		requestedByName: 'Fred',
	};
	return {
		deliveryId: discordJobId(THREAD, job),
		guildId: '2',
		threadId: THREAD,
		botUserId: '1',
		job,
	};
}

function createHarness() {
	const statuses = new Map<string, string>();
	const values = new Map<string, unknown>();
	const create = vi.fn(async ({ id }: { id: string }) => {
		if (statuses.has(id)) throw new Error('exists');
		statuses.set(id, 'running');
		return { id };
	});
	const get = vi.fn(async (id: string) => ({
		status: async () => ({ status: statuses.get(id) ?? 'unknown' }),
	}));
	const storage = {
		get: vi.fn(async (key: string) => structuredClone(values.get(key))),
		put: vi.fn(async (key: string, value: unknown) => {
			values.set(key, structuredClone(value));
		}),
		delete: vi.fn(async (key: string) => values.delete(key)),
		setAlarm: vi.fn(async () => {}),
		deleteAlarm: vi.fn(async () => {}),
	};
	const coordinator = new DiscordThreadCoordinator(
		{ storage } as unknown as DurableObjectState,
		{ DISCORD_THREAD_WORKFLOW: { create, get } } as never,
	);
	const started = () => create.mock.calls.map(([request]) => request.id);
	return { coordinator, statuses, started };
}

describe('DiscordThreadCoordinator', () => {
	it('runs jobs one at a time, in order, without dropping pull requests', async () => {
		const { coordinator, started } = createHarness();
		expect(await coordinator.enqueue(mention('11'))).toEqual({
			disposition: 'started',
			ahead: 0,
		});
		expect(await coordinator.enqueue(pullRequest('aaaaaaaa'))).toEqual({
			disposition: 'queued',
			ahead: 1,
		});
		expect(await coordinator.enqueue(pullRequest('bbbbbbbb'))).toEqual({
			disposition: 'queued',
			ahead: 2,
		});
		expect(started()).toEqual([mention('11').deliveryId]);

		await coordinator.complete(mention('11').deliveryId);
		await coordinator.complete(pullRequest('aaaaaaaa').deliveryId);
		expect(started()).toEqual([
			mention('11').deliveryId,
			pullRequest('aaaaaaaa').deliveryId,
			pullRequest('bbbbbbbb').deliveryId,
		]);
	});

	it('coalesces waiting mentions, since one run answers them all', async () => {
		const { coordinator, started } = createHarness();
		await coordinator.enqueue(mention('11'));
		await coordinator.enqueue(mention('12'));
		expect(await coordinator.enqueue(mention('13'))).toEqual({
			disposition: 'coalesced',
			ahead: 1,
		});
		await coordinator.complete(mention('11').deliveryId);
		expect(started()).toEqual([
			mention('11').deliveryId,
			mention('13').deliveryId,
		]);
	});

	it('deduplicates redelivered and recently finished jobs', async () => {
		const { coordinator } = createHarness();
		await coordinator.enqueue(mention('11'));
		expect((await coordinator.enqueue(mention('11'))).disposition).toBe(
			'deduplicated',
		);
		await coordinator.complete(mention('11').deliveryId);
		expect((await coordinator.enqueue(mention('11'))).disposition).toBe(
			'deduplicated',
		);
	});

	it('moves past a workflow that ended without reporting back', async () => {
		const { coordinator, statuses, started } = createHarness();
		await coordinator.enqueue(mention('11'));
		await coordinator.enqueue(pullRequest('aaaaaaaa'));
		statuses.set(mention('11').deliveryId, 'errored');
		await coordinator.alarm();
		expect(started().at(-1)).toBe(pullRequest('aaaaaaaa').deliveryId);
	});

	it('lets exactly one click claim a proposal', async () => {
		const { coordinator } = createHarness();
		await coordinator.saveProposal({
			kind: 'issue',
			id: 'abcdef012345',
			title: 'Slash lost',
			body: 'Steps',
		});
		const first = await coordinator.claimProposal('abcdef012345', '6', 'Fred');
		const second = await coordinator.claimProposal(
			'abcdef012345',
			'7',
			'Sarah',
		);
		expect(first?.status).toEqual({
			state: 'claimed',
			byId: '6',
			byName: 'Fred',
		});
		expect(second).toBeNull();

		await coordinator.settleProposal('abcdef012345', { state: 'proposed' });
		expect(
			await coordinator.claimProposal('abcdef012345', '7', 'Sarah'),
		).not.toBeNull();
	});

	it('only moves the read cursor forward', async () => {
		const { coordinator } = createHarness();
		await coordinator.advanceCursor('200');
		await coordinator.advanceCursor('100');
		expect(await coordinator.getCursor()).toBe('200');
	});

	it('remembers linked issues', async () => {
		const { coordinator } = createHarness();
		await coordinator.addLinkedIssues([1, 2]);
		expect(await coordinator.addLinkedIssues([2, 3])).toEqual([1, 2, 3]);
	});
});
