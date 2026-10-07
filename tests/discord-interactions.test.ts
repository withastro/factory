import { describe, expect, it, vi } from 'vitest';
import type { StoredProposal } from '../src/discord/contracts.ts';
import { proposalCustomId } from '../src/discord/contracts.ts';
import { handleInteraction } from '../src/discord/interactions.ts';
import type { WorkerEnv } from '../src/env.ts';

const GUILD = '2000000000000000002';
const ROLE = '3000000000000000003';
const THREAD = '4000000000000000004';
const PROPOSAL = 'abcdef012345';

function setup(proposal: StoredProposal['proposal']) {
	let stored: StoredProposal = {
		proposal,
		messageId: '9',
		status: { state: 'proposed' },
	};
	const coordinator = {
		claimProposal: vi.fn(async (_id: string, byId: string, byName: string) => {
			if (stored.status.state !== 'proposed') return null;
			stored = { ...stored, status: { state: 'claimed', byId, byName } };
			return stored;
		}),
		getProposal: vi.fn(async () => stored),
		settleProposal: vi.fn(
			async (_id: string, status: StoredProposal['status']) => {
				stored = { ...stored, status };
			},
		),
		enqueue: vi.fn(async () => ({ disposition: 'started', ahead: 0 })),
	};
	const env = {
		DISCORD_BOT_TOKEN: 'token',
		DISCORD_GUILD_ID: GUILD,
		DISCORD_ALLOWED_ROLE_IDS: ROLE,
		DISCORD_REPOSITORY: 'withastro/astro',
		DISCORD_THREAD_COORDINATOR: { getByName: () => coordinator },
	} as unknown as WorkerEnv;
	return { env, coordinator, current: () => stored };
}

function click(
	action: 'create-issue' | 'open-pr' | 'dismiss',
	roles: string[] = [ROLE],
) {
	return {
		type: 3,
		id: '1',
		application_id: '1000000000000000001',
		token: 'interaction-token',
		guild_id: GUILD,
		channel_id: THREAD,
		member: {
			roles,
			nick: null,
			user: {
				id: '6000000000000000006',
				username: 'fred',
				global_name: 'Fred',
			},
		},
		message: { id: '9' },
		data: {
			component_type: 2,
			custom_id: proposalCustomId(action, THREAD, PROPOSAL),
		},
	} as never;
}

const pullRequest = {
	kind: 'pull-request' as const,
	id: PROPOSAL,
	title: 'Keep the slash',
	plan: 'Change match.ts',
	issueNumber: null,
};

describe('Discord interactions', () => {
	it('turns away members without an allowed role', async () => {
		const { env, coordinator } = setup(pullRequest);
		const response = await handleInteraction(
			env,
			click('open-pr', ['9']),
			() => {},
		);
		expect(response).toMatchObject({
			type: 4,
			data: { content: 'Only maintainers can do that.', flags: 64 },
		});
		expect(coordinator.claimProposal).not.toHaveBeenCalled();
	});

	it('queues an approved pull request and disables the buttons', async () => {
		const { env, coordinator } = setup(pullRequest);
		const response = (await handleInteraction(
			env,
			click('open-pr'),
			() => {},
		)) as {
			type: number;
			data: {
				content: string;
				components: { components: { disabled?: boolean }[] }[];
			};
		};
		expect(coordinator.enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				threadId: THREAD,
				job: {
					kind: 'pull-request',
					proposalId: PROPOSAL,
					requestedById: '6000000000000000006',
					requestedByName: 'Fred',
				},
			}),
		);
		expect(response.type).toBe(7);
		expect(response.data.content).toContain('Approved by Fred. Working on it…');
		expect(
			response.data.components[0]?.components.every(
				(button) => button.disabled,
			),
		).toBe(true);
	});

	it('acts on a proposal once', async () => {
		const { env, coordinator } = setup(pullRequest);
		await handleInteraction(env, click('open-pr'), () => {});
		const second = await handleInteraction(env, click('open-pr'), () => {});
		expect(second).toMatchObject({
			type: 4,
			data: { content: 'Someone already acted on this.' },
		});
		expect(coordinator.enqueue).toHaveBeenCalledTimes(1);
	});

	it('dismisses a proposal', async () => {
		const { env, current } = setup(pullRequest);
		const response = (await handleInteraction(
			env,
			click('dismiss'),
			() => {},
		)) as {
			type: number;
			data: { content: string; components: unknown[] };
		};
		expect(response.type).toBe(7);
		expect(response.data.content).toContain('Dismissed by Fred.');
		expect(response.data.components).toEqual([]);
		expect(current().status).toEqual({ state: 'dismissed', byName: 'Fred' });
	});

	it('rejects a button that does not match the proposal', async () => {
		const { env, current } = setup(pullRequest);
		const response = await handleInteraction(
			env,
			click('create-issue'),
			() => {},
		);
		expect(response).toMatchObject({ type: 4 });
		expect(current().status).toEqual({ state: 'proposed' });
	});

	it('files an issue in the background', async () => {
		const { env } = setup({
			kind: 'issue',
			id: PROPOSAL,
			title: 'Slash lost',
			body: 'Steps',
		});
		// The background work fails without GitHub credentials, then reports the
		// failure to Discord; keep that off the network.
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const background: Promise<unknown>[] = [];
		const response = (await handleInteraction(env, click('create-issue'), (p) =>
			background.push(p),
		)) as { type: number; data: { content: string } };
		expect(response.type).toBe(7);
		expect(response.data.content).toContain('Creating the issue (Fred)');
		expect(background).toHaveLength(1);
		await Promise.allSettled(background);
		expect(errors).toHaveBeenCalled();
		vi.unstubAllGlobals();
		errors.mockRestore();
	});
});
