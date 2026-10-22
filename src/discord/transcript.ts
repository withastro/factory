/**
 * Turning Discord messages into what the assistant reads, and recognizing
 * what a message asks of it.
 */

import type { DiscordMessage } from './client.ts';
import { type DiscordAssistantSettings, isAllowedMember } from './settings.ts';

/** Discord thread channel types: announcement, public, and private threads. */
export const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

/** Discord message types that carry something a person said. */
const CONVERSATIONAL_MESSAGE_TYPES: ReadonlySet<number> = new Set([
	0, // default
	19, // reply
	21, // thread starter message
]);

/** Longest single message passed through verbatim. */
const MESSAGE_CHARACTER_LIMIT = 4_000;

/** The part of a Gateway MESSAGE_CREATE event the assistant looks at. */
export interface GatewayMessage {
	id: string;
	channel_id: string;
	guild_id?: string;
	type?: number;
	content?: string;
	author: {
		id: string;
		username: string;
		global_name?: string | null;
		bot?: boolean;
	};
	member?: { roles?: string[]; nick?: string | null };
	mentions?: readonly { id: string }[];
	webhook_id?: string;
}

export type MentionDecision =
	| { handle: true; authorName: string }
	| { handle: false; reason: string; notify?: boolean };

/**
 * Whether a Gateway message is a mention the assistant should act on.
 *
 * Only a member holding an allowed role can start work; anyone else is
 * ignored silently, so the bot can't be used to spend tokens or spam the
 * channel. Bots, webhooks, and messages that merely reply to the bot
 * without mentioning it are ignored too.
 */
export function decideMention(
	message: GatewayMessage,
	botUserId: string,
	settings: Pick<DiscordAssistantSettings, 'guildId' | 'allowedRoleIds'>,
): MentionDecision {
	if (message.guild_id !== settings.guildId) {
		return { handle: false, reason: 'outside the configured server' };
	}
	if (message.author.bot || message.webhook_id) {
		return { handle: false, reason: 'from a bot or webhook' };
	}
	if (
		message.type !== undefined &&
		!CONVERSATIONAL_MESSAGE_TYPES.has(message.type)
	) {
		return { handle: false, reason: 'not a conversational message' };
	}
	if (!mentionsUser(message, botUserId)) {
		return { handle: false, reason: 'does not mention the bot' };
	}
	if (!isAllowedMember(settings, message.member?.roles)) {
		return { handle: false, reason: 'author lacks an allowed role' };
	}
	return { handle: true, authorName: displayName(message) };
}

/**
 * True when the message mentions the user by name in its text. A reply to the
 * user's message also lists them in `mentions`, but replying to the bot isn't
 * calling on it, so the text has to contain the mention.
 */
function mentionsUser(message: GatewayMessage, userId: string): boolean {
	const content = message.content ?? '';
	return content.includes(`<@${userId}>`) || content.includes(`<@!${userId}>`);
}

export function displayName(message: {
	author: { username: string; global_name?: string | null };
	member?: { nick?: string | null };
}): string {
	return (
		message.member?.nick?.trim() ||
		message.author.global_name?.trim() ||
		message.author.username
	);
}

/**
 * Render thread messages for the assistant, oldest first. The bot's own
 * messages are left out: the assistant's answers are already in its
 * conversation, and its progress notes are noise. Mentions of the bot become
 * `@Factory` so the model sees who is being addressed.
 */
export function renderTranscript(
	messages: readonly DiscordMessage[],
	botUserId: string,
): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.author.id === botUserId) continue;
		if (
			message.type !== undefined &&
			!CONVERSATIONAL_MESSAGE_TYPES.has(message.type)
		) {
			continue;
		}
		const name = displayName(message);
		const when = message.timestamp ? ` (${message.timestamp})` : '';
		const author = message.author.bot ? `${name} [bot]` : name;
		const content = cleanContent(message.content, botUserId);
		const attachments = (message.attachments ?? []).map(
			(attachment) => `[attachment: ${attachment.filename} ${attachment.url}]`,
		);
		const body = [content, ...attachments].filter(Boolean).join('\n');
		if (!body) continue;
		lines.push(`### ${author}${when}\n${body}`);
	}
	return lines.join('\n\n');
}

function cleanContent(content: string, botUserId: string): string {
	const replaced = content
		.replaceAll(`<@${botUserId}>`, '@Factory')
		.replaceAll(`<@!${botUserId}>`, '@Factory')
		.trim();
	if (replaced.length <= MESSAGE_CHARACTER_LIMIT) return replaced;
	return `${replaced.slice(0, MESSAGE_CHARACTER_LIMIT)}… [truncated]`;
}

/**
 * GitHub issues and pull requests of the assistant's repository referenced in
 * text: full URLs, `owner/repo#123`, and bare `#123`.
 */
export function findIssueReferences(
	text: string,
	owner: string,
	repo: string,
	limit = 5,
): number[] {
	const numbers = new Set<number>();
	const escapedRepo = `${escapeRegExp(owner)}/${escapeRegExp(repo)}`;
	const patterns = [
		new RegExp(`github\\.com/${escapedRepo}/(?:issues|pull)/(\\d{1,7})`, 'gi'),
		new RegExp(`(?:^|[^\\w/])${escapedRepo}#(\\d{1,7})\\b`, 'gi'),
		/(?:^|[\s(])#(\d{1,7})\b/g,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			const value = Number(match[1]);
			if (value > 0) numbers.add(value);
			if (numbers.size >= limit) return [...numbers];
		}
	}
	return [...numbers];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
