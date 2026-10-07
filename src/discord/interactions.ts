/**
 * Discord's HTTP interactions endpoint, for the buttons under the assistant's
 * proposals. Discord only sends button clicks here (never ordinary messages,
 * which arrive over the Gateway).
 *
 * A click is checked again here, independently of the Gateway: it must come
 * from the configured server and from a member holding an allowed role, so a
 * proposal posted in a public thread can't be confirmed by anyone else. Each
 * proposal is claimed in the thread's coordinator before acting, so two
 * clicks act once.
 */

import { createDiscordChannel, type DiscordChannel } from '@flue/discord';
import type {
	APIInteraction,
	APIInteractionResponse,
	APIMessageComponentInteraction,
} from 'discord-api-types/v10';
import type { AppHonoEnv, WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
} from '../github/client.ts';
import { formatErrorWithCauses } from '../triage/failure.ts';
import { createDiscordClient } from './client.ts';
import {
	type DiscordThreadWorkflowParams,
	discordJobId,
	discordThreadUrl,
	type ProposalStatus,
	parseProposalCustomId,
	type StoredProposal,
} from './contracts.ts';
import { createIssue, findAssistantRepository } from './github.ts';
import {
	formatFailure,
	formatSettledProposal,
	proposalButtons,
} from './messages.ts';
import {
	type DiscordAssistantSettings,
	discordAssistantSettingsFromEnv,
	isAllowedMember,
} from './settings.ts';
import { displayName } from './transcript.ts';

const EPHEMERAL = 1 << 6;
const INTERACTION_PING = 1;
const INTERACTION_MESSAGE_COMPONENT = 3;
const RESPONSE_CHANNEL_MESSAGE = 4;
const RESPONSE_UPDATE_MESSAGE = 7;

let cached:
	| { publicKey: string; channel: DiscordChannel<AppHonoEnv> }
	| undefined;

/**
 * The interactions channel for the Worker's public key, or undefined when the
 * key isn't configured. Built lazily because the key comes from `env`.
 */
export function discordInteractionsChannel(
	publicKey: string | undefined,
): DiscordChannel<AppHonoEnv> | undefined {
	const key = publicKey?.trim();
	if (!key) return undefined;
	if (cached?.publicKey === key) return cached.channel;
	const channel = createDiscordChannel<AppHonoEnv>({
		publicKey: key,
		interactions: ({ c, interaction }) =>
			handleInteraction(c.env, interaction, (promise) =>
				c.executionCtx.waitUntil(promise),
			),
	});
	cached = { publicKey: key, channel };
	return channel;
}

export async function handleInteraction(
	env: WorkerEnv,
	interaction: APIInteraction,
	waitUntil: (promise: Promise<unknown>) => void,
): Promise<APIInteractionResponse> {
	if ((interaction.type as number) === INTERACTION_PING) {
		return { type: INTERACTION_PING };
	}
	if ((interaction.type as number) !== INTERACTION_MESSAGE_COMPONENT) {
		return ephemeral("Factory doesn't handle that kind of interaction.");
	}
	const component = interaction as APIMessageComponentInteraction;
	const settings = discordAssistantSettingsFromEnv(env);
	if (!settings) return ephemeral('The Factory assistant is not configured.');

	const action = parseProposalCustomId(component.data.custom_id);
	if (!action) return ephemeral("Factory doesn't recognize that button.");
	if (component.guild_id !== settings.guildId || !component.member) {
		return ephemeral('Factory only works in its configured server.');
	}
	if (!isAllowedMember(settings, component.member.roles)) {
		return ephemeral('Only maintainers can do that.');
	}
	if (component.channel_id !== action.threadId) {
		return ephemeral("That button doesn't belong to this thread.");
	}

	const user = component.member.user;
	const byName = displayName({ author: user, member: component.member });
	const coordinator = env.DISCORD_THREAD_COORDINATOR.getByName(action.threadId);
	const claimed = await coordinator.claimProposal(
		action.proposalId,
		user.id,
		byName,
	);
	if (!claimed) {
		const existing = await coordinator.getProposal(action.proposalId);
		return ephemeral(
			existing
				? 'Someone already acted on this.'
				: "I can't find that proposal anymore.",
		);
	}
	const proposal = claimed.proposal;
	const render = (status: ProposalStatus) =>
		formatSettledProposal(proposal, status, settings.owner, settings.repo);

	if (action.action === 'dismiss') {
		const status = { state: 'dismissed', byName } as const;
		await coordinator.settleProposal(proposal.id, status);
		return updateMessage(render(status), []);
	}

	if (action.action === 'create-issue' && proposal.kind === 'issue') {
		waitUntil(
			fileIssue(env, settings, action.threadId, claimed, byName).catch(
				(error) =>
					console.error('Failed to file a Discord issue proposal:', error),
			),
		);
		return updateMessage(
			render(claimed.status),
			proposalButtons(proposal, action.threadId, { disabled: true }),
		);
	}

	if (action.action === 'open-pr' && proposal.kind === 'pull-request') {
		const botUserId = component.application_id;
		const job = {
			kind: 'pull-request' as const,
			proposalId: proposal.id,
			requestedById: user.id,
			requestedByName: byName,
		};
		const params: DiscordThreadWorkflowParams = {
			deliveryId: discordJobId(action.threadId, job),
			guildId: settings.guildId,
			threadId: action.threadId,
			botUserId,
			job,
		};
		const admission = await coordinator.enqueue(params);
		if (admission.ahead > 0) {
			waitUntil(
				createDiscordClient({ botToken: settings.botToken })
					.postMessage(action.threadId, {
						content:
							"I'll start on the pull request as soon as I finish what I'm working on in this thread.",
					})
					.catch(() => undefined),
			);
		}
		return updateMessage(
			render(claimed.status),
			proposalButtons(proposal, action.threadId, { disabled: true }),
		);
	}

	// The button doesn't match the proposal's kind; put it back.
	await coordinator.settleProposal(proposal.id, { state: 'proposed' });
	return ephemeral("That button doesn't match this proposal.");
}

async function fileIssue(
	env: WorkerEnv,
	settings: DiscordAssistantSettings,
	threadId: string,
	stored: StoredProposal,
	byName: string,
): Promise<void> {
	const proposal = stored.proposal;
	if (proposal.kind !== 'issue') return;
	const coordinator = env.DISCORD_THREAD_COORDINATOR.getByName(threadId);
	const discord = createDiscordClient({ botToken: settings.botToken });
	try {
		const credentials = credentialsFromWorkerEnv(env);
		const repository = await findAssistantRepository(
			credentials,
			settings.owner,
			settings.repo,
		);
		const api = await createInstallationClient(
			credentials,
			repository.installationId,
		);
		const issue = await createIssue(api, repository.owner, repository.repo, {
			title: proposal.title,
			body: `${proposal.body}\n\n---\nFiled by ${byName} from a [Discord discussion](${discordThreadUrl(settings.guildId, threadId)}).`,
		});
		const status = {
			state: 'done',
			byName,
			url: issue.url,
			number: issue.number,
		} as const;
		await coordinator.settleProposal(proposal.id, status);
		if (stored.messageId) {
			await discord.editMessage(
				threadId,
				stored.messageId,
				formatSettledProposal(proposal, status, settings.owner, settings.repo),
				{ components: [] },
			);
		}
		await discord.postMessage(threadId, {
			content: `Filed ${repository.owner}/${repository.repo}#${issue.number}: ${issue.url}`,
		});
	} catch (error) {
		await coordinator.settleProposal(proposal.id, { state: 'proposed' });
		if (stored.messageId) {
			await discord
				.editMessage(
					threadId,
					stored.messageId,
					formatSettledProposal(
						proposal,
						{ state: 'proposed' },
						settings.owner,
						settings.repo,
					),
					{ components: proposalButtons(proposal, threadId) },
				)
				.catch(() => undefined);
		}
		await discord
			.postMessage(threadId, {
				content: formatFailure(
					'creating the issue',
					formatErrorWithCauses(error),
				),
			})
			.catch(() => undefined);
		throw error;
	}
}

function ephemeral(content: string): APIInteractionResponse {
	return {
		type: RESPONSE_CHANNEL_MESSAGE,
		data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
	} as APIInteractionResponse;
}

function updateMessage(
	content: string,
	components: ReturnType<typeof proposalButtons>,
): APIInteractionResponse {
	return {
		type: RESPONSE_UPDATE_MESSAGE,
		data: { content, components, allowed_mentions: { parse: [] } },
	} as unknown as APIInteractionResponse;
}
