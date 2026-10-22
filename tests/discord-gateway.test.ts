import { describe, expect, it, vi } from 'vitest';
import {
	GATEWAY_INTENTS,
	GATEWAY_URL,
	GatewayConnection,
	type GatewaySession,
	type GatewaySocket,
} from '../src/discord/gateway-connection.ts';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const { threadName } = await import('../src/discord/gateway.ts');

class FakeSocket implements GatewaySocket {
	sent: { op: number; d: unknown }[] = [];
	closed: { code?: number } | undefined;
	private listeners: Record<string, ((event: never) => void)[]> = {};

	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close(code?: number) {
		this.closed = { code };
	}
	addEventListener(type: string, listener: (event: never) => void) {
		this.listeners[type] = [...(this.listeners[type] ?? []), listener];
	}
	receive(payload: unknown) {
		for (const listener of this.listeners.message ?? []) {
			listener({ data: JSON.stringify(payload) } as never);
		}
	}
	serverClose(code: number) {
		for (const listener of this.listeners.close ?? []) {
			listener({ code, reason: '' } as never);
		}
	}
}

function harness(session?: GatewaySession) {
	const sockets: FakeSocket[] = [];
	const urls: string[] = [];
	const timers: { callback: () => void; ms: number }[] = [];
	const dispatched: [string, unknown][] = [];
	const sessions: (GatewaySession | undefined)[] = [];
	const fatal: number[] = [];
	const connection = new GatewayConnection({
		token: 'bot-token',
		session,
		connect: async (url) => {
			urls.push(url);
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		onDispatch: (type, data) => dispatched.push([type, data]),
		onSession: (next) => sessions.push(next),
		onFatal: (code) => fatal.push(code),
		setTimer: (callback, ms) => {
			const timer = { callback, ms };
			timers.push(timer);
			return timer;
		},
		clearTimer: (timer) => {
			const index = timers.indexOf(timer as (typeof timers)[number]);
			if (index >= 0) timers.splice(index, 1);
		},
		random: () => 0.5,
	});
	return { connection, sockets, urls, timers, dispatched, sessions, fatal };
}

const READY = {
	op: 0,
	s: 1,
	t: 'READY',
	d: {
		session_id: 'session-1',
		resume_gateway_url: 'wss://resume.discord.gg',
		user: { id: '42' },
	},
};

describe('GatewayConnection', () => {
	it('identifies after hello and records the session from READY', async () => {
		const h = harness();
		await h.connection.start();
		expect(h.urls).toEqual([GATEWAY_URL]);
		const socket = h.sockets[0] as FakeSocket;
		socket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
		expect(socket.sent[0]).toEqual({
			op: 2,
			d: {
				token: 'bot-token',
				intents: GATEWAY_INTENTS,
				properties: { os: 'linux', browser: 'factory', device: 'factory' },
			},
		});
		// The first heartbeat is jittered.
		expect(h.timers[0]?.ms).toBe(20_000);

		socket.receive(READY);
		expect(h.connection.state).toBe('open');
		expect(h.connection.botUserId).toBe('42');
		expect(h.sessions.at(-1)).toEqual({
			sessionId: 'session-1',
			resumeUrl: 'wss://resume.discord.gg',
			sequence: 1,
			botUserId: '42',
		});

		socket.receive({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: 'm' } });
		expect(h.dispatched.at(-1)).toEqual(['MESSAGE_CREATE', { id: 'm' }]);
		expect(h.connection.currentSession()?.sequence).toBe(2);
	});

	it('heartbeats with the sequence and reconnects when acks stop', async () => {
		const h = harness();
		await h.connection.start();
		const socket = h.sockets[0] as FakeSocket;
		socket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
		socket.receive(READY);

		h.timers.shift()?.callback();
		expect(socket.sent.at(-1)).toEqual({ op: 1, d: 1 });
		// No ack before the next beat: zombie connection.
		h.timers.shift()?.callback();
		expect(socket.closed?.code).toBe(4000);

		h.timers.shift()?.callback();
		await Promise.resolve();
		expect(h.urls.at(-1)).toBe('wss://resume.discord.gg/?v=10&encoding=json');
		const next = h.sockets[1] as FakeSocket;
		next.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
		expect(next.sent[0]).toEqual({
			op: 6,
			d: { token: 'bot-token', session_id: 'session-1', seq: 1 },
		});
	});

	it('answers a heartbeat request immediately', async () => {
		const h = harness();
		await h.connection.start();
		const socket = h.sockets[0] as FakeSocket;
		socket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
		socket.receive({ op: 1, d: null });
		expect(socket.sent.at(-1)).toEqual({ op: 1, d: null });
	});

	it('identifies again after a non-resumable invalid session', async () => {
		const h = harness();
		await h.connection.start();
		const socket = h.sockets[0] as FakeSocket;
		socket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
		socket.receive(READY);
		socket.receive({ op: 9, d: false });
		expect(h.sessions.at(-1)).toBeUndefined();
		h.timers.at(-1)?.callback();
		await Promise.resolve();
		expect(h.urls.at(-1)).toBe(GATEWAY_URL);
	});

	it('resumes a persisted session on start', async () => {
		const h = harness({
			sessionId: 'old',
			resumeUrl: 'wss://resume.discord.gg',
			sequence: 9,
			botUserId: '42',
		});
		await h.connection.start();
		const socket = h.sockets[0] as FakeSocket;
		socket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
		expect(socket.sent[0]).toEqual({
			op: 6,
			d: { token: 'bot-token', session_id: 'old', seq: 9 },
		});
	});

	it('stops for good on a fatal close code', async () => {
		const h = harness();
		await h.connection.start();
		(h.sockets[0] as FakeSocket).serverClose(4014);
		expect(h.connection.state).toBe('fatal');
		expect(h.fatal).toEqual([4014]);
		expect(h.timers).toEqual([]);
		await h.connection.start();
		expect(h.sockets).toHaveLength(1);
	});
});

describe('threadName', () => {
	it('names a thread from the mention text', () => {
		expect(threadName('<@123>   why is   this slow?')).toBe(
			'Factory: why is this slow?',
		);
		expect(threadName('<@123>')).toBe('Factory');
		expect(threadName('x'.repeat(200)).length).toBeLessThanOrEqual(90);
	});
});
