/**
 * Pure helpers for the triage sandbox: workspace paths, id derivation, shell
 * quoting, and input validation. Kept free of workerd-only imports so they are
 * unit testable under node.
 */

/** The repository checkout the agent edits and the orchestrator commits from. */
export const REPO_DIR = '/repo';

/**
 * Pipeline scratch space: reproduction projects and report.md.
 *
 * Deliberately a sibling of the checkout, not a directory inside it. The
 * reproduce skill sets up throwaway projects here and cleans them up, and one
 * of those cleanups is `rm -rf` on a path the agent substitutes itself. When
 * this lived at `/repo/triage/...` a mis-resolved path could — and did — take
 * `/repo/.git` with it, destroying the checkout after the fix was already
 * written and losing the whole run at push time.
 */
export const TRIAGE_DIR = '/triage';

/**
 * One sandbox per issue+delivery. Sandbox ids become DNS labels, so keep
 * them lowercase alphanumeric/hyphen and at most 63 characters.
 */
export function triageSandboxId(
	repositoryId: number,
	issueNumber: number,
	deliveryId: string,
): string {
	const cleanDelivery = deliveryId.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
	return `t-${repositoryId}-${issueNumber}-${cleanDelivery}`
		.slice(0, 63)
		.replace(/-+$/, '');
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Seconds each configured command gets before it is killed. Installing a large
 * monorepo from cold is slow and building it is slower; past these budgets a
 * command is stuck rather than slow.
 */
export const INSTALL_TIMEOUT_SECONDS = 900;
export const BUILD_TIMEOUT_SECONDS = 1_800;

/**
 * Seconds an agent command gets when the agent doesn't ask for a timeout, and
 * the most it can ask for. A command past the default is almost always stuck
 * (a lazy blob fetch, a watch-mode test runner, an interactive prompt), and
 * without a ceiling one such command silently consumes the whole run. Long
 * builds and test suites can still request up to the ceiling.
 */
export const AGENT_COMMAND_TIMEOUT_SECONDS = 600;
export const AGENT_COMMAND_MAX_TIMEOUT_SECONDS = BUILD_TIMEOUT_SECONDS;

/** Seconds the adapter waits past the in-sandbox `timeout`, so it can report exit 124. */
const AGENT_COMMAND_GRACE_SECONDS = 15;

/**
 * Bound an agent command: the requested timeout (clamped to
 * {@link AGENT_COMMAND_MAX_TIMEOUT_SECONDS}), or
 * {@link AGENT_COMMAND_TIMEOUT_SECONDS} when none was requested. The command
 * runs under coreutils `timeout` so the process is killed inside the sandbox.
 * It is re-run with `bash -c` because Cloudflare Sandbox sessions are bash
 * and agents write bash; `/bin/sh` is dash in the image. The in-sandbox kill
 * gives the agent a normal exit 124, and the adapter deadline trails it so
 * that kill always wins.
 */
export function boundAgentCommand(
	command: string,
	requestedTimeoutMs: number | undefined,
): { command: string; seconds: number; timeoutMs: number } {
	const requestedSeconds =
		requestedTimeoutMs === undefined
			? AGENT_COMMAND_TIMEOUT_SECONDS
			: Math.ceil(requestedTimeoutMs / 1_000);
	const seconds = Math.min(
		Math.max(requestedSeconds, 1),
		AGENT_COMMAND_MAX_TIMEOUT_SECONDS,
	);
	return {
		command: `timeout -k 5 ${seconds} bash -c ${shellQuote(command)}`,
		seconds,
		timeoutMs: (seconds + AGENT_COMMAND_GRACE_SECONDS) * 1_000,
	};
}

/** Explain an in-sandbox timeout kill to the agent. */
export function agentCommandTimeoutNote(seconds: number): string {
	return `[factory] Command timed out after ${seconds} seconds and was killed. Commands default to ${AGENT_COMMAND_TIMEOUT_SECONDS} seconds; pass a longer timeout (up to ${AGENT_COMMAND_MAX_TIMEOUT_SECONDS} seconds) for builds or test suites that need it.`;
}

/**
 * Git config applied to every triage checkout.
 *
 * Automatic gc/maintenance are disabled because public checkouts are blobless:
 * history commands like `git blame` fetch blobs on demand, and each batch can
 * trigger a foreground auto-pack of the growing object store. In production a
 * single `git blame` spent 26 minutes auto-packing. The sandbox is ephemeral,
 * so repository housekeeping has no value there.
 */
export const CHECKOUT_GIT_CONFIG: readonly (readonly [string, string])[] = [
	['user.name', 'factory[bot]'],
	['user.email', 'factory[bot]@users.noreply.github.com'],
	['gc.auto', '0'],
	['maintenance.auto', 'false'],
];

/** Commands that configure a fresh checkout and create the fix branch. */
export function configureCheckoutScript(options: {
	fixBranch: string;
	removeOrigin: boolean;
}): string {
	return [
		`cd ${REPO_DIR}`,
		...CHECKOUT_GIT_CONFIG.map(
			([key, value]) => `git config ${key} ${shellQuote(value)}`,
		),
		`git checkout -B ${shellQuote(options.fixBranch)}`,
		// A private checkout is self-contained; remove the remote so the agent
		// has nothing to fetch from or push to.
		...(options.removeOrigin ? ['git remote remove origin'] : []),
	].join(' && ');
}

/**
 * Compose one configured command into a script: change into the checkout, then
 * run the command.
 *
 * The command is interpolated rather than quoted on purpose. It is a shell
 * command, not an argument — `pnpm install || echo nope` has to keep working —
 * and the caller passes the whole composed script to a single `sh -c`, so the
 * operators are interpreted there and nowhere else. Quoting it would silently
 * turn every command containing an operator into one unfindable executable
 * name.
 */
export function checkoutCommandScript(command: string): string {
	return `cd ${REPO_DIR} && ${command}`;
}

/**
 * Label a command for logs and failure messages: which stage, and where in the
 * stage it got to. Configured commands are the one part of a run a maintainer
 * wrote themselves, so "install 2/3" is the difference between a useful failure
 * comment and a mystery.
 */
export function commandStageLabel(
	stage: string,
	index: number,
	total: number,
): string {
	return total > 1 ? `${stage} ${index + 1}/${total}` : stage;
}

export function assertRepoIdentifier(value: string): void {
	if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
		throw new Error(`Unsafe repository identifier: ${JSON.stringify(value)}`);
	}
}

export function assertGitRef(value: string): void {
	if (
		value.startsWith('-') ||
		!/^[A-Za-z0-9._/-]+$/.test(value) ||
		value.includes('..')
	) {
		throw new Error(`Unsafe git ref: ${JSON.stringify(value)}`);
	}
}

export function tail(value: string, max = 2_000): string {
	return value.length <= max ? value : value.slice(-max);
}

export function redactToken(value: string): string {
	return value
		.replace(/x-access-token:[^@\s]+/g, 'x-access-token:***')
		.replace(/(authorization:\s*basic\s+)[A-Za-z0-9+/=]+/gi, '$1***');
}
