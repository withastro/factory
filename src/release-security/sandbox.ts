import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { WorkerEnv } from '../env.ts';
import type { ReleaseSecurityWorkflowParams } from './contracts.ts';
import type { ReleaseBaselines } from './release-baselines.ts';

export const RELEASE_REPO_DIR = '/repo';
export const RELEASE_CONTEXT_DIR = '/security-context';
export const RELEASE_BASELINES_PATH = `${RELEASE_CONTEXT_DIR}/release-baselines.json`;
export const RELEASE_DIFF_PATH = `${RELEASE_CONTEXT_DIR}/release.diff`;
export const RELEASE_ADVISORIES_PATH = `${RELEASE_CONTEXT_DIR}/published-advisories.json`;
export const RELEASE_PULL_REQUEST_PATH = `${RELEASE_CONTEXT_DIR}/pull-request.json`;
export const RELEASE_READY_PATH = `${RELEASE_CONTEXT_DIR}/ready`;

const MAX_DIFF_BYTES = 20 * 1_024 * 1_024;

export interface ReleaseCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	success: boolean;
}

export type ReleaseSandbox = Sandbox<unknown>;

export function getReleaseSecuritySandbox(
	env: Pick<WorkerEnv, 'RELEASE_SECURITY_SANDBOX'>,
	id: string,
): ReleaseSandbox {
	return getSandbox(env.RELEASE_SECURITY_SANDBOX, id, {
		sleepAfter: '1h',
		enableDefaultSession: false,
	});
}

export async function prepareReleaseSecurityWorkspace(
	sandbox: ReleaseSandbox,
): Promise<void> {
	await execReleaseCommand(
		sandbox,
		`rm -rf ${RELEASE_REPO_DIR} ${RELEASE_CONTEXT_DIR} && mkdir -p ${RELEASE_CONTEXT_DIR}`,
		30,
		undefined,
		'prepare workspace',
	);
}

export async function cloneReleaseRepository(
	sandbox: ReleaseSandbox,
	input: ReleaseSecurityWorkflowParams,
): Promise<void> {
	assertGitRef(input.baseRef);
	const clone = [
		'git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 clone',
		'--filter=blob:none --no-checkout --no-tags --single-branch',
		`--branch ${shellQuote(input.baseRef)}`,
		'https://github.com/withastro/astro.git',
		RELEASE_REPO_DIR,
	].join(' ');
	await execReleaseCommand(
		sandbox,
		[`rm -rf ${RELEASE_REPO_DIR}`, clone].join(' && '),
		600,
		undefined,
		'clone repository',
	);
}

export async function fetchReleasePullRequest(
	sandbox: ReleaseSandbox,
	input: ReleaseSecurityWorkflowParams,
): Promise<void> {
	const pullRef = `refs/remotes/origin/pull/${input.pullNumber}`;
	await execReleaseCommand(
		sandbox,
		`git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 fetch --progress --filter=blob:none --no-tags origin ${shellQuote(`+refs/pull/${input.pullNumber}/head:${pullRef}`)}`,
		240,
		RELEASE_REPO_DIR,
		'fetch pull request',
	);
	const actual = await execReleaseCommand(
		sandbox,
		`git rev-parse ${shellQuote(pullRef)}`,
		30,
		RELEASE_REPO_DIR,
		'verify pull request',
	);
	if (actual.stdout.trim() !== input.headSha) {
		throw new Error(
			'Fetched pull request head does not match the webhook SHA.',
		);
	}
}

export async function checkoutReleaseHead(
	sandbox: ReleaseSandbox,
	input: ReleaseSecurityWorkflowParams,
): Promise<void> {
	await execReleaseCommand(
		sandbox,
		`git checkout --progress --force --detach ${shellQuote(input.headSha)}`,
		600,
		RELEASE_REPO_DIR,
		'checkout release head',
	);
}

export async function stageReleaseSecurityContext(
	sandbox: ReleaseSandbox,
	input: ReleaseSecurityWorkflowParams,
	baselines: ReleaseBaselines,
	advisories: unknown[],
): Promise<void> {
	await sandbox.writeFile(
		RELEASE_PULL_REQUEST_PATH,
		JSON.stringify(input, null, 2),
	);
	await sandbox.writeFile(
		RELEASE_BASELINES_PATH,
		JSON.stringify(baselines, null, 2),
	);
	await sandbox.writeFile(RELEASE_ADVISORIES_PATH, JSON.stringify(advisories));
	await execReleaseCommand(
		sandbox,
		`git diff --no-ext-diff --binary ${shellQuote(input.baseSha)} ${shellQuote(input.headSha)} > ${shellQuote(RELEASE_DIFF_PATH)}`,
		300,
		RELEASE_REPO_DIR,
		'stage release diff',
	);
	const size = await execReleaseCommand(
		sandbox,
		`stat --format=%s ${shellQuote(RELEASE_DIFF_PATH)}`,
		30,
		undefined,
		'inspect release diff',
	);
	if (Number(size.stdout.trim()) > MAX_DIFF_BYTES) {
		throw new Error('Release diff exceeds the 20 MiB trusted input limit.');
	}
	await sandbox.writeFile(RELEASE_READY_PATH, workspaceMarker(input));
}

export async function releaseWorkspaceMatches(
	sandbox: ReleaseSandbox,
	input: ReleaseSecurityWorkflowParams,
): Promise<boolean> {
	const result = await execReleaseCommand(
		sandbox,
		[
			`test -d ${RELEASE_REPO_DIR}/.git`,
			`test "$(git -C ${RELEASE_REPO_DIR} rev-parse HEAD)" = ${shellQuote(input.headSha)}`,
			`test "$(git -C ${RELEASE_REPO_DIR} remote get-url origin)" = ${shellQuote('https://github.com/withastro/astro.git')}`,
			`git -C ${RELEASE_REPO_DIR} cat-file -e ${shellQuote(`${input.baseSha}^{commit}`)}`,
			`test -f ${shellQuote(RELEASE_PULL_REQUEST_PATH)}`,
			`test -f ${shellQuote(RELEASE_BASELINES_PATH)}`,
			`test -f ${shellQuote(RELEASE_ADVISORIES_PATH)}`,
			`test -f ${shellQuote(RELEASE_DIFF_PATH)}`,
			`test "$(cat ${shellQuote(RELEASE_READY_PATH)})" = ${shellQuote(workspaceMarker(input))}`,
		].join(' && '),
		30,
		undefined,
		'read release workspace head',
		false,
	);
	return result.success;
}

function workspaceMarker(input: ReleaseSecurityWorkflowParams): string {
	return `${input.deliveryId}:${input.baseSha}:${input.headSha}`;
}

export async function destroyReleaseSecuritySandbox(
	sandbox: ReleaseSandbox,
): Promise<void> {
	try {
		await Promise.race([
			sandbox.destroy(),
			new Promise((resolve) => setTimeout(resolve, 10_000)),
		]);
	} catch (error) {
		console.warn('Failed to destroy release security sandbox:', error);
	}
}

export async function execReleaseCommand(
	sandbox: Pick<ReleaseSandbox, 'exec'>,
	command: string,
	timeoutSeconds: number,
	cwd?: string,
	stage = 'command',
	throwOnFailure = true,
): Promise<ReleaseCommandResult> {
	const wrapped = `GIT_TERMINAL_PROMPT=0 timeout -k 5 ${timeoutSeconds} sh -c ${shellQuote(command)}`;
	const result = await sandbox.exec(wrapped, cwd ? { cwd } : undefined);
	const normalized = {
		exitCode: result.exitCode,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		success: result.exitCode === 0,
	};
	if (throwOnFailure && !normalized.success) {
		throw new Error(
			`Release sandbox ${stage} failed (exit ${normalized.exitCode}): ${tail(normalized.stderr || normalized.stdout)}`,
		);
	}
	return normalized;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertGitRef(value: string): void {
	if (
		!value ||
		value.startsWith('-') ||
		value.includes('..') ||
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
	) {
		throw new Error('Release base branch is invalid.');
	}
}

function tail(value: string): string {
	return value.length <= 4_000 ? value : value.slice(-4_000);
}
