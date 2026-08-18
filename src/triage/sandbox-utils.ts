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
	return `t-${repositoryId}-${issueNumber}-${cleanDelivery}`.slice(0, 63).replace(/-+$/, '');
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

export function existingFixFetchScript(
	branch: string,
	headSha: string,
	cloneToken?: string,
): string {
	assertGitRef(branch);
	assertGitCommit(headSha);
	const authConfig = cloneToken
		? `-c http.extraHeader=${shellQuote(`Authorization: basic ${btoa(`x-access-token:${cloneToken}`)}`)} `
		: '';
	return [
		`cd ${REPO_DIR}`,
		`git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 ${authConfig}fetch --no-tags origin ${shellQuote(`refs/heads/${branch}`)}`,
		`test "$(git rev-parse FETCH_HEAD)" = ${shellQuote(headSha)}`,
	].join(' && ');
}

export function fixBranchCheckoutCommand(branch: string, headSha?: string): string {
	assertGitRef(branch);
	if (headSha) assertGitCommit(headSha);
	return `git checkout -B ${shellQuote(branch)}${headSha ? ` ${shellQuote(headSha)}` : ''}`;
}

/**
 * Label a command for logs and failure messages: which stage, and where in the
 * stage it got to. Configured commands are the one part of a run a maintainer
 * wrote themselves, so "install 2/3" is the difference between a useful failure
 * comment and a mystery.
 */
export function commandStageLabel(stage: string, index: number, total: number): string {
	return total > 1 ? `${stage} ${index + 1}/${total}` : stage;
}

export function assertRepoIdentifier(value: string): void {
	if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
		throw new Error(`Unsafe repository identifier: ${JSON.stringify(value)}`);
	}
}

export function assertGitRef(value: string): void {
	if (value.startsWith('-') || !/^[A-Za-z0-9._\/-]+$/.test(value) || value.includes('..')) {
		throw new Error(`Unsafe git ref: ${JSON.stringify(value)}`);
	}
}

export function assertGitCommit(value: string): void {
	if (!/^[0-9a-f]{40,64}$/.test(value)) {
		throw new Error(`Unsafe git commit: ${JSON.stringify(value)}`);
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
