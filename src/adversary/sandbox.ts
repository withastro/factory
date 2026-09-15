import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { SandboxFactory } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { adversaryBranchName } from './contracts.ts';

export const BLUE_DIR = '/blue';
export const RED_DIR = '/red';
export const ADVERSARY_ARTIFACT_DIR = '/adversary-artifacts';
export const BLUE_PATCH_PATH = `${ADVERSARY_ARTIFACT_DIR}/blue.patch`;
export const MAX_PATCH_BYTES = 20 * 1_024 * 1_024;

const COMMAND_TIMEOUT_SECONDS = 1_800;
const OUTPUT_LIMIT = 4_000;

export type AdversarySandbox = Sandbox<unknown>;

export interface AdversarySandboxEnv {
	ADVERSARY_SANDBOX: DurableObjectNamespace<Sandbox<unknown>>;
}

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	success: boolean;
}

interface RepositoryRef {
	owner: string;
	repo: string;
	baseSha: string;
}

interface PullRequestRef extends RepositoryRef {
	pullNumber: number;
	headSha: string;
}

export interface CapturedPatch {
	path: string;
	size: number;
	sha256: string;
}

export function getAdversarySandbox(
	env: AdversarySandboxEnv,
	id: string,
): AdversarySandbox {
	return getSandbox(env.ADVERSARY_SANDBOX, id, {
		sleepAfter: '1h',
		enableDefaultSession: false,
	});
}

/** Flue's normal Cloudflare tools, with a non-optional ceiling on every process. */
export function adversaryAgentSandbox(
	sandbox: AdversarySandbox,
	cwd: string,
	mountedSkillName: string,
): SandboxFactory {
	const base = cloudflareSandbox(sandbox, { cwd });
	const workspaceSkillsDir = `${cwd}/.agents/skills`;
	return {
		...base,
		async createSandbox(options) {
			const environment = await base.createSandbox(options);
			return {
				...environment,
				async readdir(path) {
					const entries = await environment.readdir(path);
					// The pinned snapshot is mounted with useSkill; hide its checkout
					// copy from Flue's workspace discovery to avoid a name collision.
					return path === workspaceSkillsDir
						? entries.filter((entry) => entry !== mountedSkillName)
						: entries;
				},
				exec(command, execOptions) {
					const requested =
						execOptions?.timeoutMs ?? COMMAND_TIMEOUT_SECONDS * 1_000;
					const timeoutMs = Math.min(
						Math.max(requested, 1_000),
						COMMAND_TIMEOUT_SECONDS * 1_000,
					);
					const seconds = Math.ceil(timeoutMs / 1_000);
					return environment.exec(
						`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 timeout -k 5 ${seconds} sh -c ${shellQuote(command)}`,
						{ ...execOptions, timeoutMs },
					);
				},
			};
		},
	};
}

/** Give blue only an anonymous detached checkout of the immutable base commit. */
export async function setupBlueWorkspace(
	sandbox: AdversarySandbox,
	input: RepositoryRef,
): Promise<void> {
	await prepareDirectories(sandbox, [BLUE_DIR, ADVERSARY_ARTIFACT_DIR]);
	await cloneExactCommit(sandbox, input, BLUE_DIR);
}

/** Stage tracked and untracked edits and encode them as a size-bounded binary patch. */
export async function captureBluePatch(
	sandbox: AdversarySandbox,
	baseSha: string,
): Promise<CapturedPatch> {
	assertSha(baseSha);
	await verifyHead(sandbox, BLUE_DIR, baseSha);
	await execOrThrow(
		sandbox,
		'capture blue changes',
		[
			`mkdir -p ${shellQuote(ADVERSARY_ARTIFACT_DIR)}`,
			`git -C ${shellQuote(BLUE_DIR)} add -A`,
			// POSIX ulimit -f is in 512-byte blocks. Leave one block of headroom.
			`(ulimit -f ${Math.floor(MAX_PATCH_BYTES / 512)}; git -C ${shellQuote(BLUE_DIR)} diff --cached --binary --full-index --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ ${shellQuote(baseSha)} -- > ${shellQuote(BLUE_PATCH_PATH)})`,
		].join(' && '),
		300,
	);
	return inspectPatch(sandbox, BLUE_PATCH_PATH);
}

/** Build exact, independent red and blue trees for a disposable comparison run. */
export async function setupPurpleWorkspace(
	sandbox: AdversarySandbox,
	input: PullRequestRef,
	patchPath = BLUE_PATCH_PATH,
): Promise<void> {
	assertPullNumber(input.pullNumber);
	assertSha(input.headSha);
	await prepareDirectories(sandbox, [BLUE_DIR, RED_DIR]);
	await clonePullHead(sandbox, input, RED_DIR);
	await cloneExactCommit(sandbox, input, BLUE_DIR);
	await applyPatch(sandbox, BLUE_DIR, patchPath);
	await verifyHead(sandbox, RED_DIR, input.headSha);
	await verifyHead(sandbox, BLUE_DIR, input.baseSha);
	await execOrThrow(
		sandbox,
		'protect source artifact',
		`chmod 0444 ${shellQuote(patchPath)}`,
		30,
	);
}

/** Prepare a credential-free publisher tree and deterministic commit. */
export async function setupPublisherWorkspace(
	sandbox: AdversarySandbox,
	input: PullRequestRef,
	patchPath = BLUE_PATCH_PATH,
): Promise<{ branch: string; branchSha: string }> {
	assertPullNumber(input.pullNumber);
	assertSha(input.headSha);
	await prepareDirectories(sandbox, [BLUE_DIR]);
	await cloneExactCommit(sandbox, input, BLUE_DIR);
	const branch = adversaryBranchName(input.pullNumber, input.headSha);
	assertGitRef(branch);
	await execOrThrow(
		sandbox,
		'apply publisher patch',
		[
			`git -C ${shellQuote(BLUE_DIR)} checkout -B ${shellQuote(branch)} ${shellQuote(input.baseSha)}`,
			`git -C ${shellQuote(BLUE_DIR)} apply --index --binary --whitespace=nowarn -- ${shellQuote(patchPath)}`,
			`test -n "$(git -C ${shellQuote(BLUE_DIR)} diff --cached --name-only)"`,
			`GIT_AUTHOR_NAME=${shellQuote('factory[bot]')} GIT_AUTHOR_EMAIL=${shellQuote('factory[bot]@users.noreply.github.com')} GIT_COMMITTER_NAME=${shellQuote('factory[bot]')} GIT_COMMITTER_EMAIL=${shellQuote('factory[bot]@users.noreply.github.com')} GIT_AUTHOR_DATE=${shellQuote('2000-01-01T00:00:00Z')} GIT_COMMITTER_DATE=${shellQuote('2000-01-01T00:00:00Z')} git -C ${shellQuote(BLUE_DIR)} commit --no-gpg-sign -m ${shellQuote(`Adversary alternative for PR #${input.pullNumber}`)}`,
		].join(' && '),
		300,
	);
	const commit = await execOrThrow(
		sandbox,
		'read publisher commit',
		`git -C ${shellQuote(BLUE_DIR)} rev-parse HEAD`,
		30,
	);
	return { branch, branchSha: commit.stdout.trim() };
}

/** Use the write token in exactly one command after all untrusted inputs are inert. */
export async function pushPublisherBranch(
	sandbox: AdversarySandbox,
	options: {
		owner: string;
		repo: string;
		branch: string;
		branchSha: string;
		token: string;
	},
): Promise<void> {
	assertRepoIdentifier(options.owner);
	assertRepoIdentifier(options.repo);
	assertGitRef(options.branch);
	assertSha(options.branchSha);
	if (!options.token) throw new Error('A publisher token is required.');

	await verifyHead(sandbox, BLUE_DIR, options.branchSha);
	const remote = `https://x-access-token:${options.token}@github.com/${options.owner}/${options.repo}.git`;
	const result = await execCommand(
		sandbox,
		`git -C ${shellQuote(BLUE_DIR)} push --force ${shellQuote(remote)} ${shellQuote(`HEAD:refs/heads/${options.branch}`)}`,
		300,
	);
	if (!result.success) {
		throw new Error(
			`Adversary publisher push failed (exit ${result.exitCode}): ${redactToken(tail(result.stderr || result.stdout))}`,
		);
	}
}

export async function inspectPatch(
	sandbox: AdversarySandbox,
	path: string,
): Promise<CapturedPatch> {
	const result = await execOrThrow(
		sandbox,
		'inspect patch',
		`test -f ${shellQuote(path)} && stat --format=%s ${shellQuote(path)} && sha256sum ${shellQuote(path)}`,
		30,
	);
	const [sizeLine, digestLine] = result.stdout.trim().split('\n');
	const size = Number(sizeLine);
	const sha256 = digestLine?.split(/\s+/)[0] ?? '';
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PATCH_BYTES) {
		throw new Error('Blue patch exceeds the 20 MiB artifact limit.');
	}
	if (!/^[0-9a-f]{64}$/.test(sha256)) {
		throw new Error('Unable to determine the blue patch digest.');
	}
	return { path, size, sha256 };
}

export async function destroyAdversarySandbox(
	sandbox: AdversarySandbox,
): Promise<void> {
	try {
		await Promise.race([
			sandbox.destroy(),
			new Promise((resolve) => setTimeout(resolve, 10_000)),
		]);
	} catch (error) {
		console.warn('Failed to destroy adversary sandbox:', error);
	}
}

async function prepareDirectories(
	sandbox: AdversarySandbox,
	directories: string[],
): Promise<void> {
	await execOrThrow(
		sandbox,
		'prepare workspace',
		`rm -rf ${directories.map(shellQuote).join(' ')} && mkdir -p ${shellQuote(ADVERSARY_ARTIFACT_DIR)}`,
		30,
	);
}

async function cloneExactCommit(
	sandbox: AdversarySandbox,
	input: RepositoryRef,
	directory: string,
): Promise<void> {
	assertRepository(input);
	const url = repositoryUrl(input.owner, input.repo);
	await execOrThrow(
		sandbox,
		'clone exact commit',
		[
			`git init ${shellQuote(directory)}`,
			`git -C ${shellQuote(directory)} remote add origin ${shellQuote(url)}`,
			`git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 -C ${shellQuote(directory)} fetch --depth=1 --filter=blob:none --no-tags origin ${shellQuote(input.baseSha)}`,
			`git -C ${shellQuote(directory)} checkout --force --detach ${shellQuote(input.baseSha)}`,
			`git -C ${shellQuote(directory)} remote remove origin`,
		].join(' && '),
		900,
	);
	await verifyHead(sandbox, directory, input.baseSha);
}

async function clonePullHead(
	sandbox: AdversarySandbox,
	input: PullRequestRef,
	directory: string,
): Promise<void> {
	assertRepository(input);
	assertPullNumber(input.pullNumber);
	assertSha(input.headSha);
	const localRef = 'refs/factory/pull-head';
	await execOrThrow(
		sandbox,
		'clone pull request head',
		[
			`git init ${shellQuote(directory)}`,
			`git -C ${shellQuote(directory)} remote add origin ${shellQuote(repositoryUrl(input.owner, input.repo))}`,
			`git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 -C ${shellQuote(directory)} fetch --depth=1 --filter=blob:none --no-tags origin ${shellQuote(input.baseSha)}`,
			`git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 -C ${shellQuote(directory)} fetch --depth=1 --filter=blob:none --no-tags origin ${shellQuote(`+refs/pull/${input.pullNumber}/head:${localRef}`)}`,
			`test "$(git -C ${shellQuote(directory)} rev-parse ${shellQuote(localRef)})" = ${shellQuote(input.headSha.toLowerCase())}`,
			`git -C ${shellQuote(directory)} checkout --force --detach ${shellQuote(input.headSha)}`,
			`git -C ${shellQuote(directory)} remote remove origin`,
		].join(' && '),
		900,
	);
}

async function applyPatch(
	sandbox: AdversarySandbox,
	directory: string,
	patchPath: string,
): Promise<void> {
	await inspectPatch(sandbox, patchPath);
	await execOrThrow(
		sandbox,
		'apply blue patch',
		`git -C ${shellQuote(directory)} apply --index --binary --whitespace=nowarn -- ${shellQuote(patchPath)}`,
		300,
	);
}

async function verifyHead(
	sandbox: AdversarySandbox,
	directory: string,
	expectedSha: string,
): Promise<void> {
	assertSha(expectedSha);
	const result = await execOrThrow(
		sandbox,
		'verify checkout',
		`git -C ${shellQuote(directory)} rev-parse HEAD`,
		30,
	);
	if (result.stdout.trim().toLowerCase() !== expectedSha.toLowerCase()) {
		throw new Error('Adversary checkout does not match the expected SHA.');
	}
}

export async function execCommand(
	sandbox: Pick<AdversarySandbox, 'exec'>,
	command: string,
	timeoutSeconds: number,
): Promise<CommandResult> {
	const seconds = Math.min(
		Math.max(timeoutSeconds, 1),
		COMMAND_TIMEOUT_SECONDS,
	);
	const wrapped = `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 timeout -k 5 ${seconds} sh -c ${shellQuote(command)}`;
	const result = await sandbox
		.exec(wrapped, {
			timeout: (seconds + 10) * 1_000,
		})
		.catch((error: unknown) => {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Adversary sandbox RPC failed: ${redactToken(detail)}`);
		});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		success: result.exitCode === 0,
	};
}

async function execOrThrow(
	sandbox: AdversarySandbox,
	stage: string,
	command: string,
	timeoutSeconds: number,
): Promise<CommandResult> {
	const result = await execCommand(sandbox, command, timeoutSeconds);
	if (!result.success) {
		throw new Error(
			`Adversary sandbox ${stage} failed (exit ${result.exitCode}): ${redactToken(tail(result.stderr || result.stdout))}`,
		);
	}
	return result;
}

function repositoryUrl(owner: string, repo: string): string {
	return `https://github.com/${owner}/${repo}.git`;
}

function assertRepository(input: RepositoryRef): void {
	assertRepoIdentifier(input.owner);
	assertRepoIdentifier(input.repo);
	assertSha(input.baseSha);
}

export function assertRepoIdentifier(value: string): void {
	if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
		throw new Error(`Unsafe repository identifier: ${JSON.stringify(value)}`);
	}
}

export function assertGitRef(value: string): void {
	if (
		!value ||
		value.startsWith('-') ||
		value.includes('..') ||
		value.includes('@{') ||
		value.endsWith('.') ||
		value.endsWith('/') ||
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
	) {
		throw new Error(`Unsafe git ref: ${JSON.stringify(value)}`);
	}
}

export function assertSha(value: string): void {
	if (!/^[0-9a-f]{40}$/i.test(value)) {
		throw new Error('Expected a full 40-character commit SHA.');
	}
}

function assertPullNumber(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error('Pull request number is invalid.');
	}
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function redactToken(value: string): string {
	return value
		.replace(/x-access-token:[^@\s]+/g, 'x-access-token:***')
		.replace(/(authorization:\s*basic\s+)[A-Za-z0-9+/=]+/gi, '$1***');
}

function tail(value: string): string {
	return value.length <= OUTPUT_LIMIT ? value : value.slice(-OUTPUT_LIMIT);
}
