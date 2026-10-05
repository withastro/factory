import { describe, expect, it, vi } from 'vitest';
import {
	createDiscordClient,
	DiscordApiError,
	discordNonce,
	splitMessage,
} from '../src/discord/client.ts';

function recorder(responses: Array<{ status: number; body: unknown }>) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const next = responses.shift() ?? { status: 200, body: { id: '1' } };
		return new Response(JSON.stringify(next.body), { status: next.status });
	});
	return { calls, fetchImpl };
}

describe('discord client', () => {
	it('posts JSON messages with mentions disabled', async () => {
		const { calls, fetchImpl } = recorder([
			{ status: 200, body: { id: '111' } },
		]);
		const client = createDiscordClient({ botToken: 'token' }, fetchImpl);

		const result = await client.postMessage('222', {
			content: '@everyone hello',
			nonce: 'abc',
		});

		expect(result).toEqual({ id: '111' });
		expect(calls[0]?.url).toBe(
			'https://discord.com/api/v10/channels/222/messages',
		);
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bot token');
		expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
			content: '@everyone hello',
			allowed_mentions: { parse: [] },
			flags: 4,
			nonce: 'abc',
			enforce_nonce: true,
		});
	});

	it('uploads files as multipart attachments', async () => {
		const { calls, fetchImpl } = recorder([]);
		const client = createDiscordClient({ botToken: 'token' }, fetchImpl);

		await client.postMessage('222', {
			content: 'see attached',
			files: [{ name: 'report.md', content: '# Report' }],
		});

		const form = calls[0]?.init.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		const payload = JSON.parse(form.get('payload_json') as string);
		expect(payload.attachments).toEqual([{ id: 0, filename: 'report.md' }]);
		expect(payload.allowed_mentions).toEqual({ parse: [] });
		const file = form.get('files[0]') as File;
		expect(file.name).toBe('report.md');
		expect(await file.text()).toBe('# Report');
	});

	it('recovers a thread that was already created from the message', async () => {
		const { fetchImpl } = recorder([
			{
				status: 400,
				body: { code: 160004, message: 'A thread has already been created' },
			},
		]);
		const client = createDiscordClient({ botToken: 'token' }, fetchImpl);
		await expect(client.startThread('222', '333', 'name')).resolves.toBe('333');
	});

	it('truncates thread names to 100 characters', async () => {
		const { calls, fetchImpl } = recorder([{ status: 201, body: { id: '9' } }]);
		const client = createDiscordClient({ botToken: 'token' }, fetchImpl);
		await client.startThread('222', '333', 'x'.repeat(150));
		const body = JSON.parse(calls[0]?.init.body as string);
		expect(body.name).toHaveLength(100);
	});

	it('surfaces API errors with status and code', async () => {
		const { fetchImpl } = recorder([
			{ status: 403, body: { code: 50013, message: 'Missing Permissions' } },
		]);
		const client = createDiscordClient({ botToken: 'token' }, fetchImpl);
		const error = await client
			.postMessage('222', { content: 'x' })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DiscordApiError);
		expect(error).toMatchObject({ status: 403, code: 50013 });
		expect((error as Error).message).toContain('Missing Permissions');
	});

	it('rejects ids that are not snowflakes', async () => {
		const { fetchImpl } = recorder([]);
		const client = createDiscordClient({ botToken: 'token' }, fetchImpl);
		await expect(
			client.postMessage('../users/@me', { content: 'x' }),
		).rejects.toThrow('Invalid Discord id');
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('splitMessage', () => {
	it('keeps short text in one message', () => {
		expect(splitMessage('hello\nworld')).toEqual(['hello\nworld']);
	});

	it('splits on line boundaries within the limit', () => {
		const chunks = splitMessage('aaaa\nbbbb\ncccc', 9);
		expect(chunks).toEqual(['aaaa\nbbbb', 'cccc']);
	});

	it('hard-splits a line longer than the limit', () => {
		const chunks = splitMessage('x'.repeat(25), 10);
		expect(chunks).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
		for (const chunk of splitMessage('y'.repeat(5_000))) {
			expect(chunk.length).toBeLessThanOrEqual(2_000);
		}
	});
});

describe('discordNonce', () => {
	it('is deterministic and at most 25 characters', async () => {
		const first = await discordNonce('delivery:announce');
		expect(first).toHaveLength(25);
		expect(await discordNonce('delivery:announce')).toBe(first);
		expect(await discordNonce('delivery:summary')).not.toBe(first);
	});
});
