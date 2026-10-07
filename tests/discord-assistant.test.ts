import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	discordJobId,
	parseProposalCustomId,
	proposalCustomId,
} from '../src/discord/contracts.ts';
import {
	formatProposalMessage,
	formatSettledProposal,
	proposalButtons,
} from '../src/discord/messages.ts';
import {
	CHECK_IN_AFTER_SECONDS,
	checkInMessage,
	withHeartbeat,
} from '../src/discord/progress.ts';
import {
	discordAssistantSettingsFromEnv,
	isAllowedMember,
} from '../src/discord/settings.ts';
import {
	decideMention,
	findIssueReferences,
	type GatewayMessage,
	renderTranscript,
} from '../src/discord/transcript.ts';
import { createSkillSnapshot } from '../src/github/skill.ts';

const BOT = '1000000000000000001';
const GUILD = '2000000000000000002';
const MAINTAINER_ROLE = '3000000000000000003';
const THREAD = '4000000000000000004';

const settings = {
	guildId: GUILD,
	allowedRoleIds: [MAINTAINER_ROLE],
};

function gatewayMessage(
	overrides: Partial<GatewayMessage> = {},
): GatewayMessage {
	return {
		id: '5000000000000000005',
		channel_id: THREAD,
		guild_id: GUILD,
		type: 0,
		content: `<@${BOT}> is this a bug?`,
		author: {
			id: '6000000000000000006',
			username: 'fred',
			global_name: 'Fred',
		},
		member: { roles: [MAINTAINER_ROLE] },
		...overrides,
	};
}

describe('Discord assistant settings', () => {
	const env = {
		DISCORD_BOT_TOKEN: 'token',
		DISCORD_GUILD_ID: GUILD,
		DISCORD_ALLOWED_ROLE_IDS: `${MAINTAINER_ROLE}, 7000000000000000007`,
		DISCORD_REPOSITORY: 'withastro/astro',
	};

	it('parses the Worker settings', () => {
		expect(discordAssistantSettingsFromEnv(env)).toEqual({
			botToken: 'token',
			guildId: GUILD,
			allowedRoleIds: [MAINTAINER_ROLE, '7000000000000000007'],
			channelIds: [],
			owner: 'withastro',
			repo: 'astro',
		});
	});

	it('is unconfigured without a role allowlist', () => {
		expect(
			discordAssistantSettingsFromEnv({ ...env, DISCORD_ALLOWED_ROLE_IDS: '' }),
		).toBeUndefined();
		expect(
			discordAssistantSettingsFromEnv({ ...env, DISCORD_GUILD_ID: '' }),
		).toBeUndefined();
	});

	it('rejects malformed ids and repositories', () => {
		expect(() =>
			discordAssistantSettingsFromEnv({
				...env,
				DISCORD_ALLOWED_ROLE_IDS: 'core',
			}),
		).toThrow();
		expect(() =>
			discordAssistantSettingsFromEnv({ ...env, DISCORD_REPOSITORY: 'astro' }),
		).toThrow();
	});

	it('requires an allowed role', () => {
		expect(isAllowedMember(settings, [MAINTAINER_ROLE])).toBe(true);
		expect(isAllowedMember(settings, ['9'])).toBe(false);
		expect(isAllowedMember(settings, undefined)).toBe(false);
	});
});

describe('decideMention', () => {
	it('handles a maintainer mentioning the bot', () => {
		expect(decideMention(gatewayMessage(), BOT, settings)).toEqual({
			handle: true,
			authorName: 'Fred',
		});
	});

	it('ignores members without an allowed role', () => {
		expect(
			decideMention(
				gatewayMessage({ member: { roles: ['9'] } }),
				BOT,
				settings,
			),
		).toMatchObject({ handle: false });
	});

	it('ignores other servers, bots, webhooks, and system messages', () => {
		for (const message of [
			gatewayMessage({ guild_id: '8' }),
			gatewayMessage({ author: { id: '1', username: 'bot', bot: true } }),
			gatewayMessage({ webhook_id: '1' }),
			gatewayMessage({ type: 18 }),
		]) {
			expect(decideMention(message, BOT, settings).handle).toBe(false);
		}
	});

	it('needs the mention in the text, not just a reply to the bot', () => {
		expect(
			decideMention(
				gatewayMessage({ content: 'thanks!', mentions: [{ id: BOT }] }),
				BOT,
				settings,
			).handle,
		).toBe(false);
		expect(
			decideMention(
				gatewayMessage({ content: `hey <@!${BOT}>` }),
				BOT,
				settings,
			).handle,
		).toBe(true);
	});
});

describe('renderTranscript', () => {
	it('renders people, drops the bot, and names the mention', () => {
		const transcript = renderTranscript(
			[
				{
					id: '1',
					type: 0,
					content: 'The trailing slash disappears',
					timestamp: '2026-10-05T10:00:00Z',
					author: { id: '2', username: 'sarah' },
					attachments: [
						{ filename: 'repro.zip', url: 'https://cdn/repro.zip' },
					],
				},
				{
					id: '3',
					type: 0,
					content: 'Still working on this…',
					author: { id: BOT, username: 'Factory', bot: true },
				},
				{
					id: '4',
					type: 19,
					content: `<@${BOT}> where does that happen?`,
					author: { id: '5', username: 'fred', global_name: 'Fred' },
				},
				{
					id: '6',
					type: 7,
					content: '',
					author: { id: '7', username: 'joiner' },
				},
			],
			BOT,
		);
		expect(transcript).toBe(
			[
				'### sarah (2026-10-05T10:00:00Z)\nThe trailing slash disappears\n[attachment: repro.zip https://cdn/repro.zip]',
				'### Fred\n@Factory where does that happen?',
			].join('\n\n'),
		);
	});
});

describe('findIssueReferences', () => {
	it('finds URLs, qualified, and bare references to the repository', () => {
		expect(
			findIssueReferences(
				'See https://github.com/withastro/astro/issues/123 and withastro/astro#456, also (#789). Not other/repo#1 or https://github.com/other/repo/issues/2 or abc#3.',
				'withastro',
				'astro',
			),
		).toEqual([123, 456, 789]);
	});

	it('caps the number of references', () => {
		expect(findIssueReferences('#1 #2 #3 #4', 'o', 'r', 2)).toEqual([1, 2]);
	});
});

describe('proposal ids and buttons', () => {
	it('round-trips button custom ids', () => {
		const id = proposalCustomId('open-pr', THREAD, 'abcdef012345');
		expect(id.length).toBeLessThanOrEqual(100);
		expect(parseProposalCustomId(id)).toEqual({
			action: 'open-pr',
			threadId: THREAD,
			proposalId: 'abcdef012345',
		});
		expect(
			parseProposalCustomId('factory:merge:1:abcdef012345'),
		).toBeUndefined();
		expect(
			parseProposalCustomId('other:open-pr:1:abcdef012345'),
		).toBeUndefined();
	});

	it('derives workflow-safe job ids', () => {
		const id = discordJobId(THREAD, {
			kind: 'mention',
			messageId: '5000000000000000005',
			authorId: '6',
			authorName: 'Fred',
		});
		expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});

	it('formats an issue proposal with buttons, attaching long drafts', () => {
		const short = formatProposalMessage(
			{
				kind: 'issue',
				id: 'abcdef012345',
				title: 'Slash lost',
				body: 'Steps…',
			},
			THREAD,
			'withastro',
			'astro',
		);
		expect(short.content).toBe(
			'**Issue draft for withastro/astro:** Slash lost\n\nSteps…',
		);
		expect(short.files).toEqual([]);
		expect(short.components[0]?.components.map((b) => b.label)).toEqual([
			'Create issue',
			'Dismiss',
		]);

		const long = formatProposalMessage(
			{
				kind: 'issue',
				id: 'abcdef012345',
				title: 'Slash lost',
				body: 'x'.repeat(5_000),
			},
			THREAD,
			'withastro',
			'astro',
		);
		expect(long.content.length).toBeLessThanOrEqual(1_800);
		expect(long.files[0]?.name).toBe('issue.md');
	});

	it('appends the outcome once a maintainer acts', () => {
		const proposal = {
			kind: 'pull-request' as const,
			id: 'abcdef012345',
			title: 'Keep the slash',
			plan: 'Change match.ts',
			issueNumber: 12,
		};
		expect(
			formatSettledProposal(
				proposal,
				{
					state: 'done',
					byName: 'Fred',
					number: 99,
					url: 'https://github.com/x/y/pull/99',
				},
				'withastro',
				'astro',
			),
		).toBe(
			'**Pull request plan for withastro/astro:** Keep the slash\nFixes withastro/astro#12\n\nChange match.ts\n\n✅ Opened #99 (approved by Fred): https://github.com/x/y/pull/99',
		);
		expect(
			proposalButtons(proposal, THREAD, {
				disabled: true,
			})[0]?.components.every((button) => button.disabled),
		).toBe(true);
	});

	it('bundles a valid assistant skill naming its tools', () => {
		// Read from disk: the `.md` import in default-skill.ts is resolved by
		// the Worker build's vite plugin and isn't available here.
		const skill = readFileSync('skills/discord-assistant/skill.md', 'utf8');
		expect(
			createSkillSnapshot('.agents/skills/discord-assistant', {
				'SKILL.md': skill,
			}).name,
		).toBe('discord-assistant');
		for (const tool of [
			'propose_issue',
			'propose_pull_request',
			'submit_pull_request',
		]) {
			expect(skill).toContain(tool);
		}
	});
});

describe('withHeartbeat', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('checks in once when work runs long, and keeps typing', async () => {
		const checkIn = vi.fn(async () => {});
		const typing = vi.fn(async () => {});
		let finish: () => void = () => {};
		const work = withHeartbeat(
			() => new Promise<string>((resolve) => (finish = () => resolve('done'))),
			{ checkIn, typing },
		);
		await vi.advanceTimersByTimeAsync(CHECK_IN_AFTER_SECONDS * 1000 * 4);
		expect(checkIn).toHaveBeenCalledTimes(1);
		expect(typing.mock.calls.length).toBeGreaterThan(10);
		finish();
		await expect(work).resolves.toBe('done');
		const typed = typing.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(typing.mock.calls.length).toBe(typed);
	});

	it('stays quiet for quick work and survives failed posts', async () => {
		const checkIn = vi.fn(async () => {});
		const typing = vi.fn(async () => {
			throw new Error('rate limited');
		});
		await expect(
			withHeartbeat(async () => 1, { checkIn, typing }),
		).resolves.toBe(1);
		await vi.advanceTimersByTimeAsync(CHECK_IN_AFTER_SECONDS * 1000 * 2);
		expect(checkIn).not.toHaveBeenCalled();
	});

	it('has a check-in for every stage', () => {
		expect(checkInMessage('sandbox')).toBe('Still waiting on the sandbox…');
	});
});
