/**
 * A Discord Gateway client: one WebSocket that receives the server's message
 * events, with heartbeats, session resume, and reconnects.
 *
 * Discord only delivers ordinary messages (and so @mentions) over the
 * Gateway; the HTTP interactions endpoint carries slash commands and button
 * clicks only. This class holds the protocol and nothing Cloudflare-specific,
 * so it can be tested with a fake socket; `gateway.ts` hosts it in a Durable
 * Object.
 *
 * See https://discord.com/developers/docs/events/gateway.
 */

export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

/** GUILD_MESSAGES | MESSAGE_CONTENT. */
export const GATEWAY_INTENTS = (1 << 9) | (1 << 15);

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/** Close codes after which reconnecting can't help. */
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
	4004, // authentication failed
	4010, // invalid shard
	4011, // sharding required
	4012, // invalid API version
	4013, // invalid intents
	4014, // disallowed intents (enable Message Content in the developer portal)
]);

/** Close codes after which the session can't be resumed. */
const NON_RESUMABLE_CLOSE_CODES: ReadonlySet<number> = new Set([4007, 4009]);

/** The subset of WebSocket this client uses. */
export interface GatewaySocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: unknown }) => void,
	): void;
	addEventListener(
		type: 'close',
		listener: (event: { code: number; reason: string }) => void,
	): void;
	addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

export interface GatewaySession {
	sessionId: string;
	resumeUrl: string;
	sequence: number | null;
	botUserId: string;
}

export interface GatewayConnectionOptions {
	token: string;
	intents?: number;
	connect: (url: string) => Promise<GatewaySocket>;
	/** A session to resume, from a previous connection. */
	session?: GatewaySession;
	onDispatch: (type: string, data: unknown) => void;
	/** Called when the session changes, so it can be persisted. */
	onSession?: (session: GatewaySession | undefined) => void;
	onFatal?: (code: number, reason: string) => void;
	log?: (message: string, details?: Record<string, unknown>) => void;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	random?: () => number;
}

export type GatewayState = 'idle' | 'connecting' | 'open' | 'closed' | 'fatal';

export class GatewayConnection {
	private socket: GatewaySocket | undefined;
	private session: GatewaySession | undefined;
	private sequence: number | null = null;
	private heartbeatTimer: unknown;
	private heartbeatIntervalMs = 0;
	private awaitingAck = false;
	private lastAckAt = 0;
	private stateValue: GatewayState = 'idle';
	private readonly setTimer: (callback: () => void, ms: number) => unknown;
	private readonly clearTimer: (timer: unknown) => void;
	private readonly random: () => number;

	constructor(private readonly options: GatewayConnectionOptions) {
		this.session = options.session;
		this.sequence = options.session?.sequence ?? null;
		this.setTimer =
			options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimer =
			options.clearTimer ??
			((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
		this.random = options.random ?? Math.random;
	}

	get state(): GatewayState {
		return this.stateValue;
	}

	get botUserId(): string | undefined {
		return this.session?.botUserId;
	}

	/** The current session, with the latest sequence number. */
	currentSession(): GatewaySession | undefined {
		return this.session
			? { ...this.session, sequence: this.sequence }
			: undefined;
	}

	/** Milliseconds since the last heartbeat acknowledgement, or undefined. */
	msSinceAck(now = Date.now()): number | undefined {
		return this.lastAckAt ? now - this.lastAckAt : undefined;
	}

	async start(): Promise<void> {
		if (this.stateValue === 'connecting' || this.stateValue === 'open') return;
		if (this.stateValue === 'fatal') return;
		this.stateValue = 'connecting';
		const url = this.session?.resumeUrl
			? withGatewayQuery(this.session.resumeUrl)
			: GATEWAY_URL;
		let socket: GatewaySocket;
		try {
			socket = await this.options.connect(url);
		} catch (error) {
			this.stateValue = 'closed';
			throw error;
		}
		this.socket = socket;
		socket.addEventListener('message', (event) =>
			this.onMessage(socket, event.data),
		);
		socket.addEventListener('close', (event) =>
			this.onClose(socket, event.code, event.reason),
		);
		socket.addEventListener('error', () => {
			this.log('gateway socket error');
		});
	}

	/** Close the connection; with `resume`, the session is kept for next time. */
	stop(code = 1000, options: { resume?: boolean } = {}): void {
		const socket = this.socket;
		this.teardown();
		if (!options.resume) this.setSession(undefined);
		this.stateValue = 'closed';
		try {
			// A non-1000 code keeps the session resumable on Discord's side.
			socket?.close(options.resume ? 4000 : code, 'closing');
		} catch {
			// Already closed.
		}
	}

	private onMessage(socket: GatewaySocket, data: unknown): void {
		if (socket !== this.socket) return;
		const payload = parsePayload(data);
		if (!payload) return;
		if (typeof payload.s === 'number') this.sequence = payload.s;

		switch (payload.op) {
			case OP_HELLO: {
				const interval = (payload.d as { heartbeat_interval?: unknown })
					?.heartbeat_interval;
				this.heartbeatIntervalMs =
					typeof interval === 'number' && interval > 0 ? interval : 41_250;
				this.awaitingAck = false;
				this.lastAckAt = Date.now();
				// The first heartbeat is jittered, per Discord's guidance.
				this.scheduleHeartbeat(this.heartbeatIntervalMs * this.random());
				this.identifyOrResume();
				return;
			}
			case OP_HEARTBEAT:
				this.sendHeartbeat();
				return;
			case OP_HEARTBEAT_ACK:
				this.awaitingAck = false;
				this.lastAckAt = Date.now();
				return;
			case OP_RECONNECT:
				this.log('gateway requested a reconnect');
				this.reconnect(true);
				return;
			case OP_INVALID_SESSION: {
				const resumable = payload.d === true;
				this.log('gateway session invalidated', { resumable });
				if (!resumable) this.setSession(undefined);
				this.reconnect(resumable);
				return;
			}
			case OP_DISPATCH:
				this.onDispatch(payload.t ?? '', payload.d);
				return;
		}
	}

	private onDispatch(type: string, data: unknown): void {
		if (type === 'READY') {
			const ready = data as {
				session_id?: unknown;
				resume_gateway_url?: unknown;
				user?: { id?: unknown };
			};
			if (
				typeof ready.session_id === 'string' &&
				typeof ready.resume_gateway_url === 'string' &&
				typeof ready.user?.id === 'string'
			) {
				this.setSession({
					sessionId: ready.session_id,
					resumeUrl: ready.resume_gateway_url,
					sequence: this.sequence,
					botUserId: ready.user.id,
				});
			}
			this.stateValue = 'open';
			this.log('gateway ready');
		} else if (type === 'RESUMED') {
			this.stateValue = 'open';
			this.log('gateway resumed');
		}
		try {
			this.options.onDispatch(type, data);
		} catch (error) {
			this.log('gateway dispatch handler threw', { error: String(error) });
		}
	}

	private onClose(socket: GatewaySocket, code: number, reason: string): void {
		if (socket !== this.socket) return;
		this.teardown();
		if (FATAL_CLOSE_CODES.has(code)) {
			this.stateValue = 'fatal';
			this.log('gateway closed with a fatal code', { code, reason });
			this.options.onFatal?.(code, reason);
			return;
		}
		if (NON_RESUMABLE_CLOSE_CODES.has(code)) this.setSession(undefined);
		this.stateValue = 'closed';
		this.log('gateway closed', { code, reason });
		// Reconnect promptly; the host's watchdog retries if this fails.
		this.setTimer(
			() => {
				this.start().catch((error) =>
					this.log('gateway reconnect failed', { error: String(error) }),
				);
			},
			1_000 + this.random() * 4_000,
		);
	}

	private identifyOrResume(): void {
		if (this.session) {
			this.send({
				op: OP_RESUME,
				d: {
					token: this.options.token,
					session_id: this.session.sessionId,
					seq: this.sequence,
				},
			});
			return;
		}
		this.send({
			op: OP_IDENTIFY,
			d: {
				token: this.options.token,
				intents: this.options.intents ?? GATEWAY_INTENTS,
				properties: { os: 'linux', browser: 'factory', device: 'factory' },
			},
		});
	}

	private scheduleHeartbeat(delayMs: number): void {
		if (this.heartbeatTimer !== undefined) this.clearTimer(this.heartbeatTimer);
		this.heartbeatTimer = this.setTimer(() => {
			if (this.awaitingAck) {
				// No ack since the last heartbeat: the connection is a zombie.
				this.log('gateway heartbeat not acknowledged; reconnecting');
				this.reconnect(true);
				return;
			}
			this.sendHeartbeat();
			this.scheduleHeartbeat(this.heartbeatIntervalMs);
		}, delayMs);
	}

	private sendHeartbeat(): void {
		this.awaitingAck = true;
		this.send({ op: OP_HEARTBEAT, d: this.sequence });
	}

	private reconnect(resume: boolean): void {
		const socket = this.socket;
		this.teardown();
		if (!resume) this.setSession(undefined);
		this.stateValue = 'closed';
		try {
			socket?.close(4000, 'reconnecting');
		} catch {
			// Already closed.
		}
		this.setTimer(
			() => {
				this.start().catch((error) =>
					this.log('gateway reconnect failed', { error: String(error) }),
				);
			},
			resume ? 500 : 1_000 + this.random() * 4_000,
		);
	}

	private teardown(): void {
		if (this.heartbeatTimer !== undefined) this.clearTimer(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.awaitingAck = false;
		this.socket = undefined;
	}

	private setSession(session: GatewaySession | undefined): void {
		this.session = session;
		if (!session) this.sequence = null;
		this.options.onSession?.(this.currentSession());
	}

	private send(payload: unknown): void {
		try {
			this.socket?.send(JSON.stringify(payload));
		} catch (error) {
			this.log('gateway send failed', { error: String(error) });
		}
	}

	private log(message: string, details?: Record<string, unknown>): void {
		this.options.log?.(message, details);
	}
}

interface GatewayPayload {
	op: number;
	d: unknown;
	s: number | null;
	t: string | null;
}

function parsePayload(data: unknown): GatewayPayload | undefined {
	if (typeof data !== 'string') return undefined;
	try {
		const payload = JSON.parse(data) as GatewayPayload;
		return typeof payload?.op === 'number' ? payload : undefined;
	} catch {
		return undefined;
	}
}

function withGatewayQuery(url: string): string {
	const parsed = new URL(url);
	parsed.searchParams.set('v', '10');
	parsed.searchParams.set('encoding', 'json');
	return parsed.toString();
}
