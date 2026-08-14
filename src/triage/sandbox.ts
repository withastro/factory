/**
 * Triage pipeline sandbox: a Cloudflare Sandbox container holding a real
 * checkout of the target repository so the pipeline agent can build, test,
 * and edit code.
 *
 * Security model:
 * - Only public repositories are triaged; the clone is anonymous, so the
 *   sandbox holds no credentials while the agent runs.
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
	redactToken,
	shellQuote,
	tail,
	triageSandboxId,
} from './sandbox-utils.ts';

export { shellQuote, triageSandboxId };

export const REPO_DIR = '/repo';

/** Directories the pipeline writes that must never be committed or pushed. */
const GIT_EXCLUDES = ['/triage/', '/preview-release.json'];

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
	skill: SkillSnapshot;
}

/**
 * Prepare `/repo`: staged hardened clone of the default branch, git identity,
 * the fix branch checked out, skill files seeded, and scratch paths excluded
 * from git.
 */
export async function setupTriageWorkspace(
	sandbox: TriageSandbox,
	setup: WorkspaceSetup,
): Promise<void> {
	assertRepoIdentifier(setup.owner);
	assertRepoIdentifier(setup.repo);
	assertGitRef(setup.defaultBranch);
	assertGitRef(setup.fixBranch);

	await execOrThrow(sandbox, 'prepare', `rm -rf ${REPO_DIR} && mkdir -p ${REPO_DIR}`, 30);

	// Blobless single-branch clone: full history for git blame/diff, blobs
	// fetched on demand. Public repositories only, so no credentials.
	const cloneUrl = `https://github.com/${setup.owner}/${setup.repo}.git`;
	await execOrThrow(
		sandbox,
		'clone',
		[
			'git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30',
			`clone --filter=blob:none --single-branch --no-tags`,
			`--branch ${shellQuote(setup.defaultBranch)}`,
			shellQuote(cloneUrl),
			REPO_DIR,
		].join(' '),
		600,
	);

	await execOrThrow(
		sandbox,
		'configure',
		[
			`cd ${REPO_DIR}`,
			`git config user.name ${shellQuote('factory[bot]')}`,
			`git config user.email ${shellQuote('factory[bot]@users.noreply.github.com')}`,
			`git checkout -B ${shellQuote(setup.fixBranch)}`,
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

/** True when the working tree differs from the default branch or is dirty. */
export async function workspaceHasChanges(
	sandbox: TriageSandbox,
	defaultBranch: string,
): Promise<{ diff: boolean; dirty: boolean }> {
	assertGitRef(defaultBranch);
	const status = await execOrThrow(
		sandbox,
		'status',
		`cd ${REPO_DIR} && git status --porcelain`,
		60,
	);
	const diff = await execOrThrow(
		sandbox,
		'diff',
		`cd ${REPO_DIR} && git diff ${shellQuote(defaultBranch)} --stat`,
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
	sandbox: TriageSandbox,
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

