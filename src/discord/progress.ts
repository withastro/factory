/**
 * Keeping a thread informed while the assistant works.
 *
 * The bot should feel like a participant without filling the thread. It says
 * what it's doing when it starts something new ("Starting up a sandbox…"),
 * keeps the typing indicator up while it works, and, if a stage runs long,
 * says once that it's still on it. After that it's fine to go quiet until
 * there's something to say.
 */

/** How long a stage runs before its single "still working" note. */
export const CHECK_IN_AFTER_SECONDS = 90;

/** Discord's typing indicator lasts about ten seconds per trigger. */
export const TYPING_INTERVAL_MS = 8_000;

export interface HeartbeatOptions {
	/** Refresh the typing indicator. */
	typing?: () => Promise<void>;
	/** Post the one check-in, if the work is still running after the delay. */
	checkIn?: () => Promise<void>;
	checkInAfterSeconds?: number;
	typingIntervalMs?: number;
}

/**
 * Run `work` with the typing indicator up and, if it runs long, one check-in.
 * Failures to post are logged and ignored: progress is a courtesy and must
 * never fail the work itself.
 */
export async function withHeartbeat<T>(
	work: () => Promise<T>,
	options: HeartbeatOptions,
): Promise<T> {
	let stopped = false;
	let checkInTimer: ReturnType<typeof setTimeout> | undefined;
	let typingTimer: ReturnType<typeof setInterval> | undefined;

	const quietly = (operation: (() => Promise<void>) | undefined) => {
		if (!operation || stopped) return;
		operation().catch((error) => {
			console.warn('Discord progress update failed:', error);
		});
	};

	if (options.typing) {
		quietly(options.typing);
		typingTimer = setInterval(
			() => quietly(options.typing),
			options.typingIntervalMs ?? TYPING_INTERVAL_MS,
		);
	}
	if (options.checkIn) {
		checkInTimer = setTimeout(
			() => quietly(options.checkIn),
			(options.checkInAfterSeconds ?? CHECK_IN_AFTER_SECONDS) * 1000,
		);
	}

	try {
		return await work();
	} finally {
		stopped = true;
		if (checkInTimer) clearTimeout(checkInTimer);
		if (typingTimer) clearInterval(typingTimer);
	}
}

export type WorkStage =
	| 'sandbox'
	| 'install'
	| 'build'
	| 'thinking'
	| 'pull-request';

const CHECK_INS: Record<WorkStage, string> = {
	sandbox: 'Still waiting on the sandbox…',
	install: 'Still installing dependencies…',
	build: 'Still building. This repo takes a bit.',
	thinking: 'Still digging into this…',
	'pull-request': 'Still working on the fix…',
};

/** The single check-in for a stage that is running long. */
export function checkInMessage(stage: WorkStage): string {
	return CHECK_INS[stage];
}
