import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { Sandbox as FlueSandbox, SandboxFactory } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { adversaryBranchName } from './contracts.ts';

export const BLUE_DIR = '/blue';
export const RED_DIR = '/red';
export const ADVERSARY_ARTIFACT_DIR = '/adversary-artifacts';
export const BLUE_PATCH_PATH = `${ADVERSARY_ARTIFACT_DIR}/blue.patch`;
export const MAX_PATCH_BYTES = 20 * 1_024 * 1_024;

const COMMAND_TIMEOUT_SECONDS = 1_800;
const OUTPUT_LIMIT = 4_000;
const AGENT_USER = 'sandbox-agent';

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

interface AdversaryAgentSandboxOptions {
	cwd: string;
	mountedSkillName: string;
	readablePaths?: string[];
	writablePaths?: string[];
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
	options: AdversaryAgentSandboxOptions,
): SandboxFactory {
	const { cwd, mountedSkillName } = options;
	const base = cloudflareSandbox(sandbox, { cwd });
	const workspaceSkillsDir = `${cwd}/.agents/skills`;
	const readablePaths = options.readablePaths ?? [cwd];
	const writablePaths = options.writablePaths ?? [cwd];
	return {
		...base,
		async createSandbox(options) {
			const environment = await base.createSandbox(options);
			const readablePath = (path: string, mustExist = true) =>
				canonicalAllowedPath(
					environment,
					path,
					readablePaths,
					'read',
					mustExist,
				);
			const writablePath = (path: string) =>
				canonicalAllowedPath(environment, path, writablePaths, 'write', false);
			return {
				...environment,
				async readFile(path) {
					const content = await readFileAsAgent(
						environment,
						await readablePath(path),
					);
					return Buffer.from(content).toString('utf8');
				},
				async readFileBuffer(path) {
					return readFileAsAgent(environment, await readablePath(path));
				},
				async writeFile(path, content) {
					const resolved = await writablePath(path);
					await writeFileAsAgent(environment, resolved, content);
				},
				async stat(path) {
					const resolved = await readablePath(path);
					const result = await execAgentCommandOrThrow(
						environment,
						`stat -L -c '%s/%Y/%F' -- ${shellQuote(resolved)} && stat -c '%F' -- ${shellQuote(resolved)}`,
						10_000,
					);
					const [target = '', self = ''] = result.stdout.trim().split('\n');
					const [size = '0', mtime = '0', type = ''] = target.split('/');
					return {
						isFile: type.includes('regular'),
						isDirectory: type === 'directory',
						isSymbolicLink: self.trim() === 'symbolic link',
						size: Number.parseInt(size, 10),
						mtime: new Date(Number.parseInt(mtime, 10) * 1_000),
					};
				},
				async readdir(path) {
					const resolved = await readablePath(path);
					const result = await execAgentCommandOrThrow(
						environment,
						`find ${shellQuote(resolved)} -mindepth 1 -maxdepth 1 -printf '%f\\0'`,
						10_000,
					);
					const entries = result.stdout.split('\0').filter(Boolean);
					// The pinned snapshot is mounted with useSkill; hide its checkout
					// copy from Flue's workspace discovery to avoid a name collision.
					return resolved === workspaceSkillsDir
						? entries.filter((entry) => entry !== mountedSkillName)
						: entries;
				},
				async exists(path) {
					try {
						const resolved = await readablePath(path, false);
						const result = await execAgentCommand(
							environment,
							`test -e ${shellQuote(resolved)}`,
							10_000,
						);
						return result.exitCode === 0;
					} catch {
						return false;
					}
				},
				async mkdir(path, mkdirOptions) {
					const resolved = await writablePath(path);
					await execAgentCommandOrThrow(
						environment,
						`mkdir ${mkdirOptions?.recursive ? '-p ' : ''}-- ${shellQuote(resolved)}`,
						10_000,
					);
				},
				async rm(path, rmOptions) {
					const resolved = environment.resolvePath(path);
					const parent = resolved.slice(0, resolved.lastIndexOf('/')) || '/';
					const canonicalParent = await writablePath(parent);
					const target = `${canonicalParent}/${resolved.slice(resolved.lastIndexOf('/') + 1)}`;
					await execAgentCommandOrThrow(
						environment,
						`rm ${rmOptions?.force ? '-f ' : ''}${rmOptions?.recursive ? '-r ' : ''}-- ${shellQuote(target)}`,
						10_000,
					);
				},
				async exec(command, execOptions) {
					if (execOptions?.cwd) await readablePath(execOptions.cwd);
					const requested =
						execOptions?.timeoutMs ?? COMMAND_TIMEOUT_SECONDS * 1_000;
					const timeoutMs = Math.min(
						Math.max(requested, 1_000),
						COMMAND_TIMEOUT_SECONDS * 1_000,
					);
					const seconds = Math.ceil(timeoutMs / 1_000);
					return execAgentCommand(
						environment,
						command,
						timeoutMs,
						seconds,
						execOptions,
					);
				},
			};
		},
	};
}

async function canonicalAllowedPath(
	environment: FlueSandbox,
	path: string,
	allowedPaths: string[],
	operation: 'read' | 'write',
	mustExist: boolean,
): Promise<string> {
	const resolved = environment.resolvePath(path);
	const canonical = await environment.exec(
		`realpath ${mustExist ? '-e' : '-m'} -- ${shellQuote(resolved)}`,
		{ timeoutMs: 10_000 },
	);
	if (canonical.exitCode !== 0) {
		throw new Error(`Sandbox ${operation} path could not be resolved.`);
	}
	const canonicalPath = canonical.stdout.trim();
	if (
		!allowedPaths.some(
			(allowed) =>
				canonicalPath === allowed || canonicalPath.startsWith(`${allowed}/`),
		)
	) {
		throw new Error(`Sandbox ${operation} denied outside the agent workspace.`);
	}
	return canonicalPath;
}

async function execAgentCommand(
	environment: FlueSandbox,
	command: string,
	timeoutMs: number,
	seconds = Math.ceil(timeoutMs / 1_000),
	execOptions?: Parameters<FlueSandbox['exec']>[1],
): ReturnType<FlueSandbox['exec']> {
	return environment.exec(wrapAgentCommand(command, seconds), {
		...execOptions,
		timeoutMs,
	});
}

function wrapAgentCommand(command: string, seconds: number): string {
	return `runuser --user ${AGENT_USER} -- env HOME=/home/${AGENT_USER} GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 timeout -k 5 ${seconds} sh -c ${shellQuote(command)}`;
}

async function execAgentCommandOrThrow(
	environment: FlueSandbox,
	command: string,
	timeoutMs: number,
): Promise<Awaited<ReturnType<FlueSandbox['exec']>>> {
	const result = await execAgentCommand(environment, command, timeoutMs);
	if (result.exitCode !== 0) {
		throw new Error(
			`Adversary agent command failed (exit ${result.exitCode}): ${tail(result.stderr || result.stdout)}`,
		);
	}
	return result;
}

async function readFileAsAgent(
	environment: FlueSandbox,
	path: string,
): Promise<Uint8Array> {
	const result = await execAgentCommandOrThrow(
		environment,
		`base64 -w 0 -- ${shellQuote(path)}`,
		30_000,
	);
	return Buffer.from(result.stdout, 'base64');
}

async function writeFileAsAgent(
	environment: FlueSandbox,
	path: string,
	content: string | Uint8Array,
): Promise<void> {
	const stagingPath = `/tmp/factory-agent-write-${crypto.randomUUID()}`;
	const parent = path.slice(0, path.lastIndexOf('/')) || '/';
	await environment.writeFile(stagingPath, content);
	try {
		const protection = await environment.exec(
			`chmod 0644 -- ${shellQuote(stagingPath)}`,
			{ timeoutMs: 10_000 },
		);
		if (protection.exitCode !== 0) {
			throw new Error('Unable to protect the staged agent write.');
		}
		await execAgentCommandOrThrow(
			environment,
			`mkdir -p -- ${shellQuote(parent)} && cp -- ${shellQuote(stagingPath)} ${shellQuote(path)}`,
			30_000,
		);
	} finally {
		await environment.rm(stagingPath, { force: true });
	}
}

/** Give blue only an anonymous detached checkout of the immutable base commit. */
export async function setupBlueWorkspace(
	sandbox: AdversarySandbox,
	input: RepositoryRef,
): Promise<void> {
	await prepareDirectories(sandbox, [BLUE_DIR, ADVERSARY_ARTIFACT_DIR]);
	await cloneExactCommit(sandbox, input, BLUE_DIR);
	await grantAgentWorkspace(sandbox, [BLUE_DIR]);
}

/** Stage tracked and untracked edits and encode them as a size-bounded binary patch. */
export async function captureBluePatch(
	sandbox: Pick<AdversarySandbox, 'exec'>,
	baseSha: string,
): Promise<CapturedPatch> {
	assertSha(baseSha);
	const stagingPath = `/tmp/factory-blue-patch-${crypto.randomUUID()}`;
	await execAgentSandboxOrThrow(
		sandbox,
		'capture blue changes',
		[
			`test "$(git -C ${shellQuote(BLUE_DIR)} rev-parse HEAD)" = ${shellQuote(baseSha.toLowerCase())}`,
			`rm -f -- ${shellQuote(stagingPath)}`,
			`git -C ${shellQuote(BLUE_DIR)} add -A`,
			// POSIX ulimit -f is in 512-byte blocks. Leave one block of headroom.
			`(ulimit -f ${Math.floor(MAX_PATCH_BYTES / 512)}; git -C ${shellQuote(BLUE_DIR)} diff --cached --binary --full-index --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ ${shellQuote(baseSha)} -- > ${shellQuote(stagingPath)})`,
		].join(' && '),
		300,
	);
	await execOrThrow(
		sandbox,
		'protect blue patch',
		[
			`mkdir -p ${shellQuote(ADVERSARY_ARTIFACT_DIR)}`,
			`install -o root -g root -m 0444 -- ${shellQuote(stagingPath)} ${shellQuote(BLUE_PATCH_PATH)}`,
			`rm -f -- ${shellQuote(stagingPath)}`,
		].join(' && '),
		30,
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
	await grantAgentWorkspace(sandbox, [BLUE_DIR, RED_DIR]);
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
	sandbox: Pick<AdversarySandbox, 'exec'>,
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

async function grantAgentWorkspace(
	sandbox: AdversarySandbox,
	directories: string[],
): Promise<void> {
	await execOrThrow(
		sandbox,
		'grant agent workspace',
		`chown -R ${AGENT_USER}:${AGENT_USER} -- ${directories.map(shellQuote).join(' ')}`,
		300,
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

async function execAgentSandboxOrThrow(
	sandbox: Pick<AdversarySandbox, 'exec'>,
	stage: string,
	command: string,
	timeoutSeconds: number,
): Promise<CommandResult> {
	const seconds = Math.min(
		Math.max(timeoutSeconds, 1),
		COMMAND_TIMEOUT_SECONDS,
	);
	const result = await sandbox
		.exec(wrapAgentCommand(command, seconds), {
			timeout: (seconds + 10) * 1_000,
		})
		.catch((error: unknown) => {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Adversary sandbox RPC failed: ${redactToken(detail)}`);
		});
	const normalized = {
		exitCode: result.exitCode,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		success: result.exitCode === 0,
	};
	if (!normalized.success) {
		throw new Error(
			`Adversary sandbox ${stage} failed (exit ${normalized.exitCode}): ${redactToken(tail(normalized.stderr || normalized.stdout))}`,
		);
	}
	return normalized;
}

async function execOrThrow(
	sandbox: Pick<AdversarySandbox, 'exec'>,
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
