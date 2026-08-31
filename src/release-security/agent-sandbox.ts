import {
	DynamicWorkerExecutor,
	type ResolvedProvider,
	resolveProvider,
	type ToolProvider,
} from '@cloudflare/codemode';
import type { Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import type { SandboxFactory, SandboxToolFactory } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { formatCodeResult } from './code-output.ts';
import { gitAnalysisTools } from './git-analysis.ts';
import {
	execReleaseCommand,
	RELEASE_CONTEXT_DIR,
	RELEASE_REPO_DIR,
	shellQuote,
} from './sandbox.ts';

const ALLOWED_ROOTS = [RELEASE_REPO_DIR, RELEASE_CONTEXT_DIR];
const MAX_CURRENT_FILE_BYTES = 5_000_000;
const MAX_SEARCH_OUTPUT_LENGTH = 90_000;

const STATE_TYPES = `
declare const state: {
  readFile(path: string): Promise<string>;
  readJson(path: string): Promise<unknown>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<Array<{ name: string; path: string; type: string; size: number }>>;
  search(args: { pattern: string; path?: string; caseSensitive?: boolean; maxMatches?: number }): Promise<string>;
};
`;

export function releaseSecurityAgentSandbox(
	sandbox: CloudflareSandbox,
	loader: WorkerLoader,
	ensureWorkspace: () => Promise<unknown>,
): SandboxFactory {
	const base = cloudflareSandbox(sandbox, { cwd: RELEASE_REPO_DIR });
	const toolProviders = [
		stateTools(sandbox),
		gitAnalysisTools(sandbox, RELEASE_REPO_DIR),
	];
	const providers = toolProviders.map(resolveProvider);
	const providerTypes = toolProviders.flatMap(
		(provider) => provider.types ?? [],
	);
	const executor = new DynamicWorkerExecutor({ loader, globalOutbound: null });
	const tools: SandboxToolFactory = () => [
		createCodeTool(executor, providers, providerTypes),
	];
	return {
		async createSandbox(options) {
			await ensureWorkspace();
			const environment = await base.createSandbox(options);
			return {
				...environment,
				exec: async () => {
					throw new Error(
						'Process execution is unavailable to the release security model.',
					);
				},
			};
		},
		tools,
	};
}

function stateTools(sandbox: CloudflareSandbox): ToolProvider {
	return {
		name: 'state',
		types: STATE_TYPES,
		tools: {
			readFile: {
				description: 'Read a current review workspace file as text.',
				execute: (value: unknown) => readText(sandbox, String(value)),
			},
			readJson: {
				description: 'Read and parse a current review workspace JSON file.',
				execute: async (value: unknown) =>
					JSON.parse(await readText(sandbox, String(value))),
			},
			exists: {
				description: 'Return whether a review workspace path exists.',
				execute: async (value: unknown) => {
					const path = safePath(value);
					if (!(await sandbox.exists(path)).exists) return false;
					await resolveExistingPath(sandbox, path);
					return true;
				},
			},
			readdir: {
				description: 'List direct children of a review workspace directory.',
				execute: async (value: unknown) => {
					const result = await sandbox.listFiles(
						await resolveExistingPath(sandbox, value),
						{ recursive: false, includeHidden: true },
					);
					return result.files.map((file) => ({
						name: file.name,
						path: file.absolutePath,
						type: file.type,
						size: file.size,
					}));
				},
			},
			search: {
				description: 'Search current review workspace text files with ripgrep.',
				execute: async (value: unknown) => {
					const input = objectArgs(value);
					if (
						typeof input.pattern !== 'string' ||
						!input.pattern ||
						input.pattern.length > 1_000
					) {
						throw new Error('Search pattern is required.');
					}
					const maxMatches = Math.min(
						Math.max(Number(input.maxMatches) || 200, 1),
						1_000,
					);
					const path = await resolveExistingPath(
						sandbox,
						input.path ?? RELEASE_REPO_DIR,
					);
					const command = [
						'rg',
						'--no-config',
						'--line-number',
						'--no-heading',
						'--color=never',
						'--max-columns',
						'2000',
						'--max-filesize',
						'1M',
						...(input.caseSensitive ? [] : ['--ignore-case']),
						'--',
						input.pattern,
						path,
					];
					const pipeline = `${command.map(shellQuote).join(' ')} | head -n ${maxMatches}; status=\${PIPESTATUS[0]}; test "$status" -eq 0 -o "$status" -eq 1 -o "$status" -eq 141`;
					const result = await execReleaseCommand(
						sandbox,
						`bash -c ${shellQuote(pipeline)}`,
						120,
						undefined,
						'workspace search',
						false,
					);
					if (!result.success) {
						throw new Error(`Workspace search failed: ${result.stderr}`);
					}
					return result.stdout.slice(0, MAX_SEARCH_OUTPUT_LENGTH);
				},
			},
		},
	};
}

function createCodeTool(
	executor: DynamicWorkerExecutor,
	providers: ResolvedProvider[],
	providerTypes: string[],
) {
	return {
		name: 'code',
		label: 'Inspect release',
		description: [
			'Run a JavaScript async arrow function against the read-only release workspace.',
			'Network, imports, process execution, and workspace mutation are unavailable.',
			'Return focused excerpts or summaries; outputs over 100,000 characters are rejected.',
			'Available APIs:',
			'```typescript',
			...providerTypes,
			'```',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: { code: { type: 'string' } },
			required: ['code'],
		},
		async execute(_toolCallId: string, params: unknown) {
			if (
				!params ||
				typeof params !== 'object' ||
				!('code' in params) ||
				typeof params.code !== 'string'
			) {
				throw new Error('code tool requires a JavaScript function in `code`.');
			}
			const { result, error } = await executor.execute(params.code, providers);
			if (error) throw new Error(`code tool failed: ${error}`);
			return {
				content: [{ type: 'text' as const, text: formatCodeResult(result) }],
				details: {},
			};
		},
	};
}

async function resolveExistingPath(
	sandbox: CloudflareSandbox,
	path: unknown,
): Promise<string> {
	const result = await execReleaseCommand(
		sandbox,
		`realpath --canonicalize-existing -- ${shellQuote(safePath(path))}`,
		30,
		undefined,
		'resolve workspace path',
		false,
	);
	if (!result.success) {
		throw new Error(`Unable to resolve workspace path: ${result.stderr}`);
	}
	return safePath(result.stdout.trim());
}

async function readText(
	sandbox: CloudflareSandbox,
	path: string,
): Promise<string> {
	const resolved = await resolveExistingPath(sandbox, path);
	const stat = await execReleaseCommand(
		sandbox,
		`stat --format=%s ${shellQuote(resolved)}`,
		30,
		undefined,
		'inspect workspace file',
	);
	if (Number(stat.stdout.trim()) > MAX_CURRENT_FILE_BYTES) {
		throw new Error('Workspace file exceeds 5 MB.');
	}
	const file = await sandbox.readFile(resolved);
	if (typeof file.content !== 'string') {
		throw new Error('Workspace file is not text.');
	}
	return file.content;
}

function safePath(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value.startsWith('/') ||
		value.includes('\0')
	) {
		throw new Error('Invalid workspace path.');
	}
	const parts = value.split('/').reduce<string[]>((result, part) => {
		if (!part || part === '.') return result;
		if (part === '..') result.pop();
		else result.push(part);
		return result;
	}, []);
	const path = `/${parts.join('/')}`;
	if (
		!ALLOWED_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
	) {
		throw new Error('Workspace path is outside the review context.');
	}
	return path;
}

function objectArgs(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: {};
}
