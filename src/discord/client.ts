/**
 * A minimal outbound Discord REST client: post a message, edit it, and start
 * a thread from it. Factory talks to Discord as a bot user with a bot token;
 * there is no Gateway connection.
 *
 * Every message disables mentions (`allowed_mentions: { parse: [] }`).
 * Factory posts text derived from untrusted input — security reports and
 * model output — and none of it should ever be able to ping `@everyone`, a
 * role, or a user.
 */

const DISCORD_API = 'https://discord.com/api/v10';

/** Discord's per-message content limit. */
export const DISCORD_MESSAGE_LIMIT = 2_000;

/** Discord's thread name limit. */
export const DISCORD_THREAD_NAME_LIMIT = 100;

/** `SUPPRESS_EMBEDS`: links in Factory's messages don't unfurl into previews. */
const SUPPRESS_EMBEDS = 1 << 2;

/** "A thread has already been created for this message." */
const THREAD_ALREADY_CREATED = 160_004;

export interface DiscordCredentials {
	botToken: string;
}

export interface DiscordFile {
	name: string;
	content: string;
	contentType?: string;
}

export interface DiscordMessageInput {
	content: string;
	files?: readonly DiscordFile[];
	/**
	 * Deduplicates a retried post: Discord returns the original message when
	 * the same nonce is reused shortly after. At most 25 characters.
	 */
	nonce?: string;
}

export class DiscordApiError extends Error {
	override readonly name = 'DiscordApiError';

	constructor(
		readonly status: number,
		readonly code: number | undefined,
		message: string,
	) {
		super(message);
	}
}

export type DiscordFetch = (
	input: string,
	init: RequestInit,
) => Promise<Response>;

export interface DiscordClient {
	postMessage(
		channelId: string,
		message: DiscordMessageInput,
	): Promise<{ id: string }>;
	editMessage(
		channelId: string,
		messageId: string,
		content: string,
	): Promise<void>;
	/** Start a public thread from a message; returns the thread (channel) id. */
	startThread(
		channelId: string,
		messageId: string,
		name: string,
	): Promise<string>;
}

export function createDiscordClient(
	credentials: DiscordCredentials,
	fetchImpl: DiscordFetch = fetch,
): DiscordClient {
	const request = async (
		method: string,
		path: string,
		body: BodyInit,
		contentType?: string,
	): Promise<unknown> => {
		const response = await fetchImpl(`${DISCORD_API}${path}`, {
			method,
			headers: {
				authorization: `Bot ${credentials.botToken}`,
				'user-agent': 'Factory (https://github.com/withastro/factory, 1.0)',
				...(contentType ? { 'content-type': contentType } : {}),
			},
			body,
		});
		const text = await response.text();
		const data = text ? safeJson(text) : undefined;
		if (!response.ok) {
			const code =
				typeof (data as { code?: unknown })?.code === 'number'
					? (data as { code: number }).code
					: undefined;
			const detail =
				typeof (data as { message?: unknown })?.message === 'string'
					? (data as { message: string }).message
					: response.statusText;
			throw new DiscordApiError(
				response.status,
				code,
				`Discord ${method} ${path} failed (${response.status}${code === undefined ? '' : `, code ${code}`}): ${detail}`,
			);
		}
		return data;
	};

	return {
		async postMessage(channelId, message) {
			const payload = {
				content: message.content,
				allowed_mentions: { parse: [] },
				flags: SUPPRESS_EMBEDS,
				...(message.nonce ? { nonce: message.nonce, enforce_nonce: true } : {}),
				...(message.files?.length
					? {
							attachments: message.files.map((file, index) => ({
								id: index,
								filename: file.name,
							})),
						}
					: {}),
			};
			const path = `/channels/${snowflake(channelId)}/messages`;
			const data = message.files?.length
				? await request('POST', path, multipartBody(payload, message.files))
				: await request(
						'POST',
						path,
						JSON.stringify(payload),
						'application/json',
					);
			return { id: readId(data) };
		},

		async editMessage(channelId, messageId, content) {
			await request(
				'PATCH',
				`/channels/${snowflake(channelId)}/messages/${snowflake(messageId)}`,
				JSON.stringify({ content, allowed_mentions: { parse: [] } }),
				'application/json',
			);
		},

		async startThread(channelId, messageId, name) {
			try {
				const data = await request(
					'POST',
					`/channels/${snowflake(channelId)}/messages/${snowflake(messageId)}/threads`,
					JSON.stringify({
						name: truncate(name, DISCORD_THREAD_NAME_LIMIT),
						auto_archive_duration: 10_080,
					}),
					'application/json',
				);
				return readId(data);
			} catch (error) {
				// A thread started from a message shares the message's id, so a
				// retry after a lost response can recover it without a lookup.
				if (
					error instanceof DiscordApiError &&
					error.code === THREAD_ALREADY_CREATED
				) {
					return messageId;
				}
				throw error;
			}
		},
	};
}

function multipartBody(
	payload: Record<string, unknown>,
	files: readonly DiscordFile[],
): FormData {
	const form = new FormData();
	form.append('payload_json', JSON.stringify(payload));
	for (const [index, file] of files.entries()) {
		form.append(
			`files[${index}]`,
			new Blob([file.content], {
				type: file.contentType ?? 'text/markdown; charset=utf-8',
			}),
			file.name,
		);
	}
	return form;
}

function readId(data: unknown): string {
	const id = (data as { id?: unknown } | undefined)?.id;
	if (typeof id !== 'string' || !/^\d+$/.test(id)) {
		throw new Error('Discord returned a response without an id.');
	}
	return id;
}

/** Discord ids are decimal snowflakes; anything else is a configuration error. */
function snowflake(id: string): string {
	if (!/^\d{1,25}$/.test(id)) {
		throw new Error(`Invalid Discord id: ${JSON.stringify(id)}.`);
	}
	return id;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Split text into Discord-sized messages, preferring paragraph and line
 * boundaries. A single line longer than the limit is cut hard.
 */
export function splitMessage(
	text: string,
	limit: number = DISCORD_MESSAGE_LIMIT,
): string[] {
	const chunks: string[] = [];
	let current = '';
	const flush = () => {
		if (current.trim()) chunks.push(current.trimEnd());
		current = '';
	};
	for (const line of text.split('\n')) {
		const candidate = current ? `${current}\n${line}` : line;
		if (candidate.length <= limit) {
			current = candidate;
			continue;
		}
		flush();
		let rest = line;
		while (rest.length > limit) {
			chunks.push(rest.slice(0, limit));
			rest = rest.slice(limit);
		}
		current = rest;
	}
	flush();
	return chunks;
}

/** A Discord nonce (≤ 25 characters) derived deterministically from a key. */
export async function discordNonce(key: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(key),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 25);
}
