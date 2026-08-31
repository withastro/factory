import type { ToolProvider } from '@cloudflare/codemode';
import type { Sandbox } from '@cloudflare/sandbox';
import { execReleaseCommand, shellQuote } from './sandbox.ts';

const MAX_FILE_BYTES = 1_000_000;

export const GIT_ANALYSIS_TYPES = `
declare const git: {
  log(args?: { ref?: string; depth?: number }): Promise<Array<{ oid: string; message: string; parent: string[]; author: { name: string; email: string; timestamp: number } }>>;
  mergeBase(args: { refs: string[] }): Promise<string[]>;
  isAncestor(args: { ancestor: string; descendant: string }): Promise<boolean>;
  changedFiles(args: { from: string; to: string }): Promise<Array<{ path: string; status: 'added' | 'deleted' | 'modified' }>>;
  listFiles(args: { ref: string }): Promise<string[]>;
  readFile(args: { ref: string; path: string }): Promise<string>;
};
`;

export function gitAnalysisTools(sandbox: Sandbox, dir: string): ToolProvider {
	const resolveCommit = async (ref: string): Promise<string> =>
		(
			await git(sandbox, dir, ['rev-parse', '--verify', `${ref}^{commit}`])
		).trim();

	return {
		name: 'git',
		types: GIT_ANALYSIS_TYPES,
		tools: {
			log: {
				description: 'Read commit history from a ref.',
				execute: async (value: unknown) => {
					const input = objectArgs(value);
					const ref = input.ref ? safeRef(input.ref) : 'HEAD';
					const depth = Math.min(Math.max(Number(input.depth) || 50, 1), 500);
					const output = await git(sandbox, dir, [
						'log',
						'-n',
						String(depth),
						'--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%B%x1e',
						ref,
					]);
					return output
						.split('\x1e')
						.map((record) => record.replace(/^\n|\n$/g, ''))
						.filter(Boolean)
						.map((record) => {
							const [
								oid = '',
								parents = '',
								name = '',
								email = '',
								timestamp = '',
								message = '',
							] = record.split('\0');
							return {
								oid,
								message,
								parent: parents ? parents.split(' ') : [],
								author: { name, email, timestamp: Number(timestamp) },
							};
						});
				},
			},
			mergeBase: {
				description: 'Find merge-base commits for two or more refs.',
				execute: async (value: unknown) => {
					const refs = objectArgs(value).refs;
					if (!Array.isArray(refs) || refs.length < 2 || refs.length > 10) {
						throw new Error('mergeBase requires between two and ten refs.');
					}
					return (
						await git(sandbox, dir, [
							'merge-base',
							'--octopus',
							...refs.map(safeRef),
						])
					)
						.split('\n')
						.filter(Boolean);
				},
			},
			isAncestor: {
				description: 'Return whether one ref is an ancestor of another.',
				execute: async (value: unknown) => {
					const input = objectArgs(value);
					const result = await execReleaseCommand(
						sandbox,
						`git ${[
							'merge-base',
							'--is-ancestor',
							safeRef(input.ancestor),
							safeRef(input.descendant),
						]
							.map(shellQuote)
							.join(' ')}`,
						120,
						dir,
						'git merge-base',
						false,
					);
					if (result.exitCode === 0) return true;
					if (result.exitCode === 1) return false;
					throw new Error(`git merge-base failed: ${result.stderr}`);
				},
			},
			changedFiles: {
				description: 'List every file changed between two commits or tags.',
				execute: async (value: unknown) => {
					const input = objectArgs(value);
					const output = await git(sandbox, dir, [
						'diff',
						'--name-status',
						'--no-renames',
						'-z',
						await resolveCommit(safeRef(input.from)),
						await resolveCommit(safeRef(input.to)),
					]);
					const fields = output.split('\0').filter(Boolean);
					const changes: Array<{
						path: string;
						status: 'added' | 'deleted' | 'modified';
					}> = [];
					for (let index = 0; index < fields.length; index += 2) {
						const code = fields[index];
						const path = fields[index + 1];
						if (!code || !path) continue;
						changes.push({
							path,
							status:
								code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
						});
					}
					return changes;
				},
			},
			listFiles: {
				description: 'List files tracked by a commit or tag.',
				execute: async (value: unknown) =>
					(
						await git(sandbox, dir, [
							'ls-tree',
							'-r',
							'--name-only',
							'-z',
							await resolveCommit(safeRef(objectArgs(value).ref)),
						])
					)
						.split('\0')
						.filter(Boolean),
			},
			readFile: {
				description: 'Read a text file as it existed at a commit or tag.',
				execute: async (value: unknown) => {
					const input = objectArgs(value);
					const ref = safeRef(input.ref);
					const path = safeRepoPath(input.path);
					const spec = `${await resolveCommit(ref)}:${path}`;
					const size = Number(
						(await git(sandbox, dir, ['cat-file', '-s', spec])).trim(),
					);
					if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) {
						throw new Error('Historical file exceeds 1 MB.');
					}
					const content = await git(sandbox, dir, ['show', spec]);
					if (content.includes('\0')) {
						throw new Error('Historical file is binary.');
					}
					return content;
				},
			},
		},
	};
}

async function git(
	sandbox: Sandbox,
	dir: string,
	args: string[],
): Promise<string> {
	const result = await execReleaseCommand(
		sandbox,
		`git ${args.map(shellQuote).join(' ')}`,
		120,
		dir,
		`git ${args[0] ?? 'command'}`,
		false,
	);
	if (!result.success) {
		throw new Error(`git ${args[0]} failed: ${result.stderr}`);
	}
	return result.stdout;
}

function objectArgs(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: {};
}

function safeRef(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.startsWith('-') ||
		value.includes('..') ||
		value.length > 300 ||
		!/^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]*$/.test(value)
	) {
		throw new Error('Invalid git ref.');
	}
	return value;
}

function safeRepoPath(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.startsWith('/') ||
		value.split('/').includes('..') ||
		value.includes('\0')
	) {
		throw new Error('Invalid repository path.');
	}
	return value;
}
