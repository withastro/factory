/**
 * The Durable Object that keeps Factory connected to the Discord Gateway and
 * turns maintainers' @mentions into thread jobs.
 *
 * There is one instance, `default`. A Worker cron trigger calls
 * {@link DiscordGateway.ensureConnected} every minute, and the object's own
 * alarm checks the connection every 30 seconds, so a deploy, an eviction, or
 * a dropped socket is repaired within a minute. The session is persisted so a
 * restart resumes it instead of identifying again (Discord limits identifies).
 *
 * The connection receives every message in the server. Almost all of them are
 * dropped after a few field checks in {@link decideMention}; only a mention of
 * the bot by a member with an allowed role starts work.
 */

import { DurableObject } from 'cloudflare:workers';
import type { WorkerEnv } from '../env.ts';
import { createDiscordClient, type DiscordClient, truncate } from './client.ts';
import {
	type DiscordJob,
	type DiscordThreadWorkflowParams,
	discordJobId,
} from './contracts.ts';
import {
	GatewayConnection,
	type GatewaySession,
	type GatewaySocket,
} from './gateway-connection.ts';
import {
	type DiscordAssistantSettings,
	discordAssistantSettingsFromEnv,
} from './settings.ts';
import {
	decideMention,
	type GatewayMessage,
	THREAD_CHANNEL_TYPES,
} from './transcript.ts';

const SESSION_KEY = 'session';
const WATCHDOG_INTERVAL_MS = 30_000;
/** Reconnect when heartbeats have gone unacknowledged this long. */
const STALE_ACK_MS = 3 * 60_000;

/** Text channel types a thread can be started in: text and announcement. */
const THREADABLE_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5]);

export interface GatewayStatus {
	configured: boolean;
	state: string;
	botUserId: string | undefined;
	msSinceAck: number | undefined;
	fatal: { code: number; reason: string } | undefined;
}

export class DiscordGateway extends DurableObject<WorkerEnv> {
	private connection: GatewayConnection | undefined;
	private fatal: { code: number; reason: string } | undefined;

	/** Connect if not connected; safe to call as often as you like. */
	async ensureConnected(): Promise<GatewayStatus> {
		const settings = discordAssistantSettingsFromEnv(this.env);
		if (!settings) {
			this.connection?.stop();
			this.connection = undefined;
			return this.status(false);
		}
		await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
		if (!this.connection) {
			const session = await this.ctx.storage.get<GatewaySession>(SESSION_KEY);
			this.connection = this.createConnection(settings, session);
		}
		const connection = this.connection;
		const sinceAck = connection.msSinceAck();
		if (
			connection.state === 'open' &&
			sinceAck !== undefined &&
			sinceAck > STALE_ACK_MS
		) {
			console.warn('Discord gateway heartbeats are stale; reconnecting.');
			connection.stop(4000, { resume: true });
		}
		if (connection.state === 'idle' || connection.state === 'closed') {
			try {
				await connection.start();
			} catch (error) {
				console.error('Discord gateway connection failed:', error);
			}
		}
		return this.status(true);
	}

	async getStatus(): Promise<GatewayStatus> {
		return this.status(Boolean(discordAssistantSettingsFromEnv(this.env)));
	}

	override async alarm(): Promise<void> {
		const session = this.connection?.currentSession();
		if (session) await this.ctx.storage.put(SESSION_KEY, session);
		await this.ensureConnected();
	}

	private status(configured: boolean): GatewayStatus {
		return {
			configured,
			state: this.connection?.state ?? 'idle',
			botUserId: this.connection?.botUserId,
			msSinceAck: this.connection?.msSinceAck(),
			fatal: this.fatal,
		};
	}

	private createConnection(
		settings: DiscordAssistantSettings,
		session: GatewaySession | undefined,
	): GatewayConnection {
		return new GatewayConnection({
			token: settings.botToken,
			session,
			connect: connectWebSocket,
			onSession: (next) => {
				const write = next
					? this.ctx.storage.put(SESSION_KEY, next)
					: this.ctx.storage.delete(SESSION_KEY);
				write.catch((error) =>
					console.warn('Failed to persist the Discord gateway session:', error),
				);
			},
			onFatal: (code, reason) => {
				this.fatal = { code, reason };
				console.error(
					JSON.stringify({ event: 'discord_gateway_fatal', code, reason }),
				);
			},
			onDispatch: (type, data) => {
				if (type !== 'MESSAGE_CREATE') return;
				this.onMessage(data as GatewayMessage);
			},
			log: (message, details) =>
				console.info(
					JSON.stringify({ event: 'discord_gateway', message, ...details }),
				),
		});
	}

	private onMessage(message: GatewayMessage): void {
		const botUserId = this.connection?.botUserId;
		if (!botUserId) return;
		const settings = discordAssistantSettingsFromEnv(this.env);
		if (!settings) return;
		const decision = decideMention(message, botUserId, settings);
		if (!decision.handle) return;
		const job: DiscordJob = {
			kind: 'mention',
			messageId: message.id,
			authorId: message.author.id,
			authorName: decision.authorName,
		};
		this.ctx.waitUntil(
			this.admitMention(settings, botUserId, message, job).catch((error) => {
				console.error('Failed to admit a Discord mention:', error);
			}),
		);
	}

	private async admitMention(
		settings: DiscordAssistantSettings,
		botUserId: string,
		message: GatewayMessage,
		job: DiscordJob,
	): Promise<void> {
		const discord = createDiscordClient({ botToken: settings.botToken });
		// Instant feedback, before any slower work.
		discord.triggerTyping(message.channel_id).catch(() => undefined);

		const threadId = await resolveThread(discord, settings, message);
		if (!threadId) return;

		const params: DiscordThreadWorkflowParams = {
			deliveryId: discordJobId(threadId, job),
			guildId: settings.guildId,
			threadId,
			botUserId,
			job,
		};
		const coordinator = this.env.DISCORD_THREAD_COORDINATOR.getByName(threadId);
		const admission = await coordinator.enqueue(params);
		console.info(
			JSON.stringify({
				event: 'discord_mention_admitted',
				threadId,
				messageId: message.id,
				...admission,
			}),
		);
		if (admission.ahead > 0) {
			await discord.postMessage(threadId, {
				content:
					"Got it. I'm still working on something in this thread, so I'll pick this up right after.",
				replyTo: threadId === message.channel_id ? message.id : undefined,
			});
		}
	}
}

/**
 * The thread a mention belongs to. A mention inside a thread uses it; a
 * mention in a text channel starts a thread from the message, so the
 * conversation has a home. Returns undefined when the assistant doesn't
 * answer in that channel.
 */
async function resolveThread(
	discord: DiscordClient,
	settings: DiscordAssistantSettings,
	message: GatewayMessage,
): Promise<string | undefined> {
	const channel = await discord.getChannel(message.channel_id);
	const isThread = THREAD_CHANNEL_TYPES.has(channel.type);
	const homeChannel = isThread ? channel.parentId : channel.id;
	if (
		settings.channelIds.length > 0 &&
		(!homeChannel || !settings.channelIds.includes(homeChannel))
	) {
		return undefined;
	}
	if (isThread) return channel.id;
	if (!THREADABLE_CHANNEL_TYPES.has(channel.type)) return undefined;
	return discord.startThread(
		channel.id,
		message.id,
		threadName(message.content),
	);
}

export function threadName(content: string | undefined): string {
	const text = (content ?? '')
		.replace(/<@!?\d+>/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return truncate(text ? `Factory: ${text}` : 'Factory', 90);
}

async function connectWebSocket(url: string): Promise<GatewaySocket> {
	const response = await fetch(url.replace(/^wss:/, 'https:'), {
		headers: { Upgrade: 'websocket' },
	});
	const socket = response.webSocket;
	if (!socket) {
		throw new Error(
			`Discord gateway did not upgrade the connection (${response.status}).`,
		);
	}
	socket.accept();
	return socket as unknown as GatewaySocket;
}
