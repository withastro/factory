/**
 * Triage pipeline sandbox: a Cloudflare Sandbox container holding a real
 * checkout of the target repository so the pipeline agent can build, test,
 * and edit code.
 *
 * Security model:
 * - Public repositories clone anonymously (blobless), so the
 *   sandbox holds no credentials while the agent runs; lazy blob fetches
 *   from origin stay anonymous too.
 * - Private repositories clone and fetch with a short-lived contents-read
 *   token passed as an ephemeral `http.extraHeader` — never written to git
 *   config — and get a full checkout so nothing needs the network afterward;
 *   the origin remote is then removed entirely. Either way, the agent runs
 *   with zero usable GitHub credentials.
 * - The push step injects a short-lived, contents-only installation token
 *   into a single git command and never persists it to git config.
 * - Every git command runs with GIT_TERMINAL_PROMPT=0 under a hard timeout
 *   so a hung network operation fails fast instead of eating the run.
 */

import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { WorkerEnv } from '../env.ts';
import type { SkillSnapshot } from '../github/skill.ts';
import {
	assertGitRef,
	assertRepoIdentifier,
	checkoutCommandScript,
	commandStageLabel,
	existingFixFetchScript,
	fixBranchCheckoutCommand,
	redactToken,
	REPO_DIR,
	shellQuote,
	tail,
	triageSandboxId,
	TRIAGE_DIR,
} from './sandbox-utils.ts';

export { REPO_DIR, shellQuote, triageSandboxId, TRIAGE_DIR };

/**
 * Directories the pipeline writes that must never be committed or pushed.
 *
 * Scratch now lives outside the checkout, so this is belt-and-braces for an
 * agent that writes `triage/` inside the repo anyway.
 */
const GIT_EXCLUDES = ['/triage/'];

type TriageSandbox = Sandbox<unknown>;

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	success: boolean;
}

export function getTriageSandbox(env: WorkerEnv, id: string): TriageSandbox {
	return getSandbox(env.TRIAGE_SANDBOX, id, {
		sleepAfter: '1h',
		enableDefaultSession: false,
	});
}

export interface WorkspaceSetup {
	owner: string;
	repo: string;
	defaultBranch: string;
	fixBranch: string;
	/** Existing fix commit to extend instead of starting from the default branch. */
	fixBranchHead?: string;
	skill: SkillSnapshot;
	/**
	 * Contents-read installation token; required for private repositories.
	 * Used during checkout via `http.extraHeader` and never persisted.
	 */
	cloneToken?: string;
}

/**
 * Prepare `/repo`: staged hardened clone, git identity, the requested fix
 * branch checked out, skill files seeded, and scratch paths excluded from git.
 */
export async function setupTriageWorkspace(
	sandbox: TriageSandbox,
	setup: WorkspaceSetup,
): Promise<void> {
	assertRepoIdentifier(setup.owner);
	assertRepoIdentifier(setup.repo);
	assertGitRef(setup.defaultBranch);
	assertGitRef(setup.fixBranch);

	await execOrThrow(
		sandbox,
		'prepare',
		`rm -rf ${REPO_DIR} ${TRIAGE_DIR} && mkdir -p ${REPO_DIR} ${TRIAGE_DIR}`,
		30,
	);

	// Public: blobless default-branch clone — full history for git blame/diff,
	// blobs fetched anonymously on demand.
	// Private: full default-branch clone with ephemeral header auth, so the
	// checkout is self-contained and no credential outlives this step.
	const cloneUrl = `https://github.com/${setup.owner}/${setup.repo}.git`;
	const authConfig = setup.cloneToken
		? `-c http.extraHeader=${shellQuote(`Authorization: basic ${btoa(`x-access-token:${setup.cloneToken}`)}`)} `
		: '';
	const filterFlags = setup.cloneToken ? '' : '--filter=blob:none ';
	await execOrThrow(
		sandbox,
		'clone',
		[
			`git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 ${authConfig}`.trimEnd(),
			`clone ${filterFlags}--single-branch --no-tags`.trimEnd(),
			`--branch ${shellQuote(setup.defaultBranch)}`,
			shellQuote(cloneUrl),
			REPO_DIR,
		].join(' '),
		900,
	);

	if (setup.fixBranchHead) {
		await execOrThrow(
			sandbox,
			'fetch existing fix',
			existingFixFetchScript(setup.fixBranch, setup.fixBranchHead, setup.cloneToken),
			900,
		);
	}

	await execOrThrow(
		sandbox,
		'configure',
		[
			`cd ${REPO_DIR}`,
			`git config user.name ${shellQuote('factory[bot]')}`,
			`git config user.email ${shellQuote('factory[bot]@users.noreply.github.com')}`,
			fixBranchCheckoutCommand(setup.fixBranch, setup.fixBranchHead),
			// A private checkout is self-contained; remove the remote so the
			// agent has nothing to fetch from or push to.
			...(setup.cloneToken ? ['git remote remove origin'] : []),
		].join(' && '),
		60,
	);

	// Keep pipeline scratch out of git without touching tracked files.
	const excludes = [...GIT_EXCLUDES, `/${setup.skill.directory}/`].join('\n');
	await sandbox.writeFile(`${REPO_DIR}/.git/info/exclude`, `${excludes}\n`);

	for (const [path, content] of Object.entries(setup.skill.files)) {
		await sandbox.writeFile(`${REPO_DIR}/${setup.skill.directory}/${path}`, content);
	}
}

/** Recreate the ephemeral checkout when the container was replaced between steps. */
export async function ensureTriageWorkspace(
	sandbox: Pick<TriageSandbox, 'exec'>,
	setup: () => Promise<void>,
): Promise<boolean> {
	const checkout = await exec(sandbox, 'check workspace', `test -d ${REPO_DIR}/.git`, 30);
	if (checkout.success) return false;

	await setup();
	return true;
}

/**
 * Run the repository's configured commands in the checkout, in order, before
 * the agent starts.
 *
 * A repository whose dependencies aren't installed, or whose packages resolve
 * through built output, can't reproduce anything, and the agent shouldn't have
 * to discover that from its skill. Failure throws, and stops the remaining
 * commands: a checkout that won't bootstrap is an environment problem, so
 * triage parks the issue in the re-triageable `failed` state with the failing
 * command's output in the failure comment, rather than reporting "could not
 * reproduce" about its own broken workspace.
 *
 * Commands should avoid modifying tracked files, or their edits become part of
 * whatever the agent later commits as the fix.
 */
export async function runCheckoutCommands(
	sandbox: TriageSandbox,
	stage: string,
	commands: readonly string[],
	timeoutSeconds: number,
): Promise<void> {
	for (const [index, command] of commands.entries()) {
		await execOrThrow(
			sandbox,
			commandStageLabel(stage, index, commands.length),
			checkoutCommandScript(command),
			timeoutSeconds,
		);
	}
}

/**
 * True when the working tree differs from `baseRef` or is dirty.
 *
 * `baseRef` is the default branch for a fresh run, and the candidate commit
 * the run started from when continuing an existing fix — comparing that one
 * against the default branch would report the previous fix as a change.
 */
export async function workspaceHasChanges(
	sandbox: TriageSandbox,
	baseRef: string,
): Promise<{ diff: boolean; dirty: boolean }> {
	assertGitRef(baseRef);
	const status = await execOrThrow(
		sandbox,
		'status',
		`cd ${REPO_DIR} && git status --porcelain`,
		60,
	);
	const diff = await execOrThrow(
		sandbox,
		'diff',
		`cd ${REPO_DIR} && git diff ${shellQuote(baseRef)} --stat`,
		120,
	);
	return { diff: diff.stdout.trim().length > 0, dirty: status.stdout.trim().length > 0 };
}

/**
 * Stage everything, commit (if the tree is dirty), and force-push the fix
 * branch. The commit message is written to a file so LLM-authored content
 * can't be interpreted by the shell; the token appears only in this one
 * command's remote URL and is never stored in git config.
 */
export async function commitAndPush(
	sandbox: TriageSandbox,
	options: {
		owner: string;
		repo: string;
		branch: string;
		message: string;
		token: string;
		dirty: boolean;
	},
): Promise<{ pushed: boolean; detail: string }> {
	assertRepoIdentifier(options.owner);
	assertRepoIdentifier(options.repo);
	assertGitRef(options.branch);

	if (options.dirty) {
		await sandbox.writeFile('/tmp/factory-commit-message.txt', options.message);
		const commit = await exec(
			sandbox,
			'commit',
			`cd ${REPO_DIR} && git add -A && git commit -F /tmp/factory-commit-message.txt`,
			120,
		);
		if (!commit.success) {
			return { pushed: false, detail: `git commit failed: ${tail(commit.stderr)}` };
		}
	}

	const remote = `https://x-access-token:${options.token}@github.com/${options.owner}/${options.repo}.git`;
	const push = await exec(
		sandbox,
		'push',
		`cd ${REPO_DIR} && git push -f ${shellQuote(remote)} ${shellQuote(options.branch)}`,
		300,
	);
	if (!push.success) {
		return { pushed: false, detail: `git push failed: ${redactToken(tail(push.stderr))}` };
	}
	return { pushed: true, detail: 'pushed' };
}

/** Destroy the sandbox, tolerating failures — it sleeps on its own anyway. */
export async function destroyTriageSandbox(sandbox: TriageSandbox): Promise<void> {
	try {
		await Promise.race([
			sandbox.destroy(),
			new Promise((resolve) => setTimeout(resolve, 10_000)),
		]);
	} catch (error) {
		console.warn('Failed to destroy triage sandbox:', error);
	}
}

async function exec(
	sandbox: Pick<TriageSandbox, 'exec'>,
	_stage: string,
	command: string,
	timeoutSeconds: number,
): Promise<ExecResult> {
	const wrapped = `GIT_TERMINAL_PROMPT=0 timeout -k 5 ${timeoutSeconds} sh -c ${shellQuote(command)}`;
	const result = await sandbox.exec(wrapped);
	return {
		exitCode: result.exitCode,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		success: result.exitCode === 0,
	};
}

async function execOrThrow(
	sandbox: TriageSandbox,
	stage: string,
	command: string,
	timeoutSeconds: number,
): Promise<ExecResult> {
	const result = await exec(sandbox, stage, command, timeoutSeconds);
	if (!result.success) {
		throw new Error(
			`Sandbox ${stage} failed (exit ${result.exitCode}): ${redactToken(tail(result.stderr || result.stdout))}`,
		);
	}
	return result;
}
