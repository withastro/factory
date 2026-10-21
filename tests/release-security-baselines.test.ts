import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ReleaseSecurityWorkflowParams } from '../src/release-security/contracts.ts';
import {
	parsePnpmWorkspacePackages,
	prepareReleaseBaselines,
} from '../src/release-security/release-baselines.ts';
import type { ReleaseSandbox } from '../src/release-security/sandbox.ts';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

// Verbatim copy of withastro/astro's pnpm-workspace.yaml at 06bd3183 (a release commit
// whose review failed when workspaces were read from package.json).
const ASTRO_PNPM_WORKSPACE = readFileSync(
	'tests/fixtures/astro-pnpm-workspace.yaml',
	'utf8',
);

const ASTRO_WORKSPACE_PACKAGES = [
	'packages/**/*',
	'packages/astro/test/units/_temp-fixtures',
	'examples/**/*',
	'triage/*',
	'smoke/**/*',
	'temp/*',
	'scripts',
	'benchmark',
	'benchmark/packages/*',
	'benchmark/static-projects/*',
	'!packages/astro/test/units/_temp-fixtures/*',
	'!**/.vercel/**',
];

const input: ReleaseSecurityWorkflowParams = {
	deliveryId: 'delivery-1',
	installationId: 1,
	repositoryId: 2,
	owner: 'withastro',
	repo: 'astro',
	pullNumber: 3,
	pullUrl: 'https://github.com/withastro/astro/pull/3',
	pullTitle: 'Release',
	pullBody: '',
	headRef: 'changeset-release/main',
	headSha: 'b'.repeat(40),
	baseRef: 'main',
	baseSha: 'a'.repeat(40),
	mode: 'release',
	trigger: 'pull-request',
};

type GitHandler = (args: string) => string | undefined;

/** Fakes the release sandbox by matching the unwrapped `git ...` command. */
function fakeSandbox(handler: GitHandler) {
	const exec = vi.fn(async (wrapped: string) => {
		const match = /sh -c '(.*)'$/s.exec(wrapped);
		const command = (match?.[1] ?? '').replaceAll("'\\''", "'");
		const stdout = handler(command.replaceAll("'", ''));
		return stdout === undefined
			? {
					exitCode: 1,
					stdout: '',
					stderr: `unexpected: ${command}`,
					success: false,
				}
			: { exitCode: 0, stdout, stderr: '', success: true };
	});
	return { sandbox: { exec } as unknown as ReleaseSandbox, exec };
}

function manifest(name: string, version: string, extra = {}): string {
	return JSON.stringify({ name, version, ...extra });
}

describe('parsePnpmWorkspacePackages', () => {
	it('extracts the packages list from the real astro pnpm-workspace.yaml', () => {
		expect(parsePnpmWorkspacePackages(ASTRO_PNPM_WORKSPACE)).toEqual(
			ASTRO_WORKSPACE_PACKAGES,
		);
	});

	it('ignores other top-level sequences such as trustPolicyExclude', () => {
		const packages = parsePnpmWorkspacePackages(ASTRO_PNPM_WORKSPACE);
		expect(packages).not.toContain('@vercel/routing-utils@6.6.0');
	});

	it('accepts single, double and bare scalars with comments and blank lines', () => {
		const yaml = [
			'# workspace',
			'packages:   # inline',
			"  - 'packages/*'",
			'',
			'  # nested comment',
			'  - "examples/*"  # trailing',
			'  - scripts',
			'catalog:',
			'  vite: ^7',
		].join('\n');
		expect(parsePnpmWorkspacePackages(yaml)).toEqual([
			'packages/*',
			'examples/*',
			'scripts',
		]);
	});

	it('handles CRLF line endings and a BOM', () => {
		const yaml =
			"\uFEFFpackages:\r\n  - 'packages/*'\r\n  - '!**/.vercel/**'\r\n";
		expect(parsePnpmWorkspacePackages(yaml)).toEqual([
			'packages/*',
			'!**/.vercel/**',
		]);
	});

	it('finds packages when it is not the first key', () => {
		const yaml = "linkWorkspacePackages: true\npackages:\n  - 'packages/*'\n";
		expect(parsePnpmWorkspacePackages(yaml)).toEqual(['packages/*']);
	});

	it.each([
		['missing packages key', "catalog:\n  - 'packages/*'\n"],
		['empty packages list', 'packages:\nautoInstallPeers: false\n'],
		['flow sequence', "packages: ['packages/*']\n"],
		['inline scalar', 'packages: packages/*\n'],
		['nested mapping', 'packages:\n  foo: bar\n'],
		['empty item', "packages:\n  - ''\n"],
		['unterminated quote', "packages:\n  - 'packages/*\n"],
		['escaped double quote', 'packages:\n  - "packages/\\u002a"\n'],
		['yaml anchor', 'packages:\n  - &a packages/*\n'],
		['yaml alias', 'packages:\n  - *a\n'],
		['unquoted yaml tag', 'packages:\n  - !negated/*\n'],
		['unquoted flow item', 'packages:\n  - [packages/*]\n'],
		['multiline item', "packages:\n  -\n    'packages/*'\n"],
		['duplicate packages key', "packages:\n  - 'a/*'\npackages:\n  - 'b/*'\n"],
		['indented packages key', "  packages:\n  - 'packages/*'\n"],
	])('returns null for %s', (_name, yaml) => {
		expect(parsePnpmWorkspacePackages(yaml)).toBeNull();
	});
});

describe('release package baselines', () => {
	it('rejects a release head that does not contain the reviewed base SHA', async () => {
		const sandbox = {
			exec: vi.fn(async () => ({
				exitCode: 0,
				stdout: `${'c'.repeat(40)}\n`,
				stderr: '',
				success: true,
			})),
		} as unknown as ReleaseSandbox;

		await expect(prepareReleaseBaselines(sandbox, input)).rejects.toThrow(
			'Release head does not contain the reviewed base commit.',
		);
	});

	function astroRepo(
		overrides: { workspace?: Partial<Record<'base' | 'head', string>> } = {},
	): GitHandler {
		const base = input.baseSha;
		const head = input.headSha;
		const workspace = {
			base: ASTRO_PNPM_WORKSPACE,
			head: ASTRO_PNPM_WORKSPACE,
			...overrides.workspace,
		};
		const files: Record<string, string> = {
			[`${base}:pnpm-workspace.yaml`]: workspace.base,
			[`${head}:pnpm-workspace.yaml`]: workspace.head,
			[`${base}:packages/astro/package.json`]: manifest('astro', '6.0.0'),
			[`${head}:packages/astro/package.json`]: manifest('astro', '6.0.1'),
			[`${base}:packages/integrations/vercel/package.json`]: manifest(
				'@astrojs/vercel',
				'9.0.0',
			),
			[`${head}:packages/integrations/vercel/package.json`]: manifest(
				'@astrojs/vercel',
				'9.0.0',
			),
			[`${head}:.changeset/config.json`]: JSON.stringify({ ignore: [] }),
		};
		const tree = [
			'packages/astro/package.json',
			'packages/integrations/vercel/package.json',
			// Deeper than WORKSPACE_MANIFEST allows: fixtures must be ignored.
			'packages/astro/test/fixtures/basic/package.json',
		].join('\0');
		return (command) => {
			if (command === `git merge-base --all ${base} ${head}`)
				return `${base}\n`;
			if (command.startsWith('git show ')) {
				return files[command.slice('git show '.length)];
			}
			if (command.startsWith('git ls-tree ')) return tree;
			if (command === 'git check-ref-format refs/tags/astro@6.0.0') return '';
			if (command.startsWith('git fetch ')) return '';
			if (command === 'git tag --list') return 'astro@6.0.0\n';
			if (command === 'git rev-parse --verify refs/tags/astro@6.0.0^{commit}') {
				return `${'d'.repeat(40)}\n`;
			}
			if (
				command === `git merge-base --is-ancestor ${'d'.repeat(40)} ${base}`
			) {
				return '';
			}
			return undefined;
		};
	}

	it('derives baselines from an astro repo that only configures pnpm-workspace.yaml', async () => {
		const { sandbox, exec } = fakeSandbox(astroRepo());

		await expect(prepareReleaseBaselines(sandbox, input)).resolves.toEqual({
			mergeBaseSha: input.baseSha,
			packages: [
				{
					name: 'astro',
					directory: 'packages/astro',
					previousVersion: '6.0.0',
					newVersion: '6.0.1',
					previousTag: 'astro@6.0.0',
					previousCommit: 'd'.repeat(40),
				},
			],
		});
		const commands = exec.mock.calls.map(([command]) => command);
		expect(commands.some((command) => command.includes(':package.json'))).toBe(
			false,
		);
	});

	it('fails closed when pnpm-workspace.yaml cannot be parsed', async () => {
		const { sandbox } = fakeSandbox(
			astroRepo({ workspace: { head: "packages: ['packages/*']\n" } }),
		);

		await expect(prepareReleaseBaselines(sandbox, input)).rejects.toThrow(
			`Workspace configuration is invalid at ${input.headSha}.`,
		);
	});

	it('fails closed when the workspace packages list changes', async () => {
		const { sandbox } = fakeSandbox(
			astroRepo({
				workspace: {
					base: ASTRO_PNPM_WORKSPACE.replace(
						/^packages:\n/m,
						"packages:\n  - 'vendor/*'\n",
					),
				},
			}),
		);

		await expect(prepareReleaseBaselines(sandbox, input)).rejects.toThrow(
			`Workspace configuration changed at ${input.baseSha}.`,
		);
	});

	it('accepts the same packages list in a different order', async () => {
		const reordered = `packages:\n${[...ASTRO_WORKSPACE_PACKAGES]
			.reverse()
			.map((entry) => `  - '${entry}'`)
			.join('\n')}\n`;
		const { sandbox } = fakeSandbox(
			astroRepo({ workspace: { head: reordered } }),
		);

		await expect(
			prepareReleaseBaselines(sandbox, input),
		).resolves.toMatchObject({
			packages: [{ name: 'astro' }],
		});
	});
});
