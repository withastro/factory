import type { ReleaseSecurityWorkflowParams } from './contracts.ts';
import {
	execReleaseCommand,
	RELEASE_REPO_DIR,
	type ReleaseCommandResult,
	type ReleaseSandbox,
	shellQuote,
} from './sandbox.ts';

// The exact `packages` list of withastro/astro's pnpm-workspace.yaml. pnpm (and therefore
// Changesets) resolves workspace packages from it, so any change must be reviewed against
// WORKSPACE_MANIFEST before release reviews can trust the derived package set.
const EXPECTED_WORKSPACES = [
	'!**/.vercel/**',
	'!packages/astro/test/units/_temp-fixtures/*',
	'benchmark',
	'benchmark/packages/*',
	'benchmark/static-projects/*',
	'examples/**/*',
	'packages/**/*',
	'packages/astro/test/units/_temp-fixtures',
	'scripts',
	'smoke/**/*',
	'temp/*',
	'triage/*',
];
const WORKSPACE_MANIFEST =
	/^packages\/(?:[^/]+|(?:integrations|language-tools|markdown)\/[^/]+)\/package\.json$/;
const SHA = /^[0-9a-f]{40}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SEMVER =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface PackageManifest {
	name: string;
	version: string;
	private: boolean;
	directory: string;
}

export interface ReleasePackageBaseline {
	name: string;
	directory: string;
	previousVersion: string | null;
	newVersion: string;
	previousTag: string | null;
	previousCommit: string | null;
}

export interface ReleaseBaselines {
	mergeBaseSha: string;
	packages: ReleasePackageBaseline[];
}

export async function prepareReleaseBaselines(
	sandbox: ReleaseSandbox,
	input: ReleaseSecurityWorkflowParams,
): Promise<ReleaseBaselines> {
	if (!SHA.test(input.baseSha) || !SHA.test(input.headSha)) {
		throw new Error('Release SHAs are invalid.');
	}
	const mergeBases = (
		await git(sandbox, ['merge-base', '--all', input.baseSha, input.headSha])
	)
		.split('\n')
		.filter(Boolean);
	if (mergeBases.length !== 1) {
		throw new Error('Release history has an ambiguous merge base.');
	}
	const mergeBaseSha = mergeBases[0] ?? '';
	if (!SHA.test(mergeBaseSha)) {
		throw new Error('Release merge base is invalid.');
	}
	if (mergeBaseSha !== input.baseSha) {
		throw new Error('Release head does not contain the reviewed base commit.');
	}
	const [basePackages, headPackages, ignoredPackages] = await Promise.all([
		readSnapshot(sandbox, mergeBaseSha),
		readSnapshot(sandbox, input.headSha),
		readIgnoredPackages(sandbox, input.headSha),
	]);
	const packages = deriveReleasePackageBaselines(
		basePackages,
		headPackages,
		ignoredPackages,
	);
	if (packages.length === 0) {
		throw new Error('No publishable package version changes were found.');
	}
	const tags = packages.flatMap((entry) =>
		entry.previousTag ? [entry.previousTag] : [],
	);
	if (new Set(tags).size !== tags.length) {
		throw new Error('Duplicate release baseline tag.');
	}
	await fetchExactTags(sandbox, tags);
	for (const entry of packages) {
		if (!entry.previousTag) continue;
		entry.previousCommit = (
			await git(sandbox, [
				'rev-parse',
				'--verify',
				`refs/tags/${entry.previousTag}^{commit}`,
			])
		).trim();
		if (!SHA.test(entry.previousCommit)) {
			throw new Error(`Baseline tag ${entry.previousTag} is invalid.`);
		}
		const ancestry = await gitResult(sandbox, [
			'merge-base',
			'--is-ancestor',
			entry.previousCommit,
			mergeBaseSha,
		]);
		if (ancestry.exitCode !== 0) {
			throw new Error(
				`Baseline tag ${entry.previousTag} is not an ancestor of the release.`,
			);
		}
	}
	return { mergeBaseSha, packages };
}

export function deriveReleasePackageBaselines(
	basePackages: Map<string, PackageManifest>,
	headPackages: Map<string, PackageManifest>,
	ignoredPackages: Set<string>,
): ReleasePackageBaseline[] {
	const baselines: ReleasePackageBaseline[] = [];
	for (const head of headPackages.values()) {
		if (head.private || ignoredPackages.has(head.name)) continue;
		const base = basePackages.get(head.name);
		if (base?.version === head.version) continue;
		const previouslyPublished = base !== undefined && !base.private;
		baselines.push({
			name: head.name,
			directory: head.directory,
			previousVersion: previouslyPublished ? base.version : null,
			newVersion: head.version,
			previousTag: previouslyPublished ? `${head.name}@${base.version}` : null,
			previousCommit: null,
		});
	}
	return baselines.sort((left, right) => left.name.localeCompare(right.name));
}

async function readSnapshot(
	sandbox: ReleaseSandbox,
	ref: string,
): Promise<Map<string, PackageManifest>> {
	validateWorkspaces(
		parsePnpmWorkspacePackages(
			await git(sandbox, ['show', `${ref}:pnpm-workspace.yaml`]),
		),
		ref,
	);
	const paths = (
		await git(sandbox, [
			'ls-tree',
			'-r',
			'--name-only',
			'-z',
			ref,
			'--',
			'packages',
		])
	)
		.split('\0')
		.filter((path) => WORKSPACE_MANIFEST.test(path));
	const packages = new Map<string, PackageManifest>();
	for (const path of paths) {
		const manifest = parseJson(
			await git(sandbox, ['show', `${ref}:${path}`]),
			path,
		);
		if (
			typeof manifest.name !== 'string' ||
			manifest.name.length > 214 ||
			!PACKAGE_NAME.test(manifest.name)
		) {
			throw new Error(`Package name is invalid in ${path} at ${ref}.`);
		}
		if (
			typeof manifest.version !== 'string' ||
			manifest.version.length > 256 ||
			!SEMVER.test(manifest.version)
		) {
			throw new Error(`Package version is invalid in ${path} at ${ref}.`);
		}
		if (
			manifest.private !== undefined &&
			typeof manifest.private !== 'boolean'
		) {
			throw new Error(`Package privacy is invalid in ${path} at ${ref}.`);
		}
		if (packages.has(manifest.name)) {
			throw new Error(`Duplicate package name ${manifest.name}.`);
		}
		packages.set(manifest.name, {
			name: manifest.name,
			version: manifest.version,
			private: manifest.private === true,
			directory: path.slice(0, -'/package.json'.length),
		});
	}
	return packages;
}

async function readIgnoredPackages(
	sandbox: ReleaseSandbox,
	ref: string,
): Promise<Set<string>> {
	const config = parseJson(
		await git(sandbox, ['show', `${ref}:.changeset/config.json`]),
		'.changeset/config.json',
	);
	if (config.ignore === undefined) return new Set();
	if (
		!Array.isArray(config.ignore) ||
		!config.ignore.every((value) => typeof value === 'string')
	) {
		throw new Error('Changesets ignore configuration is invalid.');
	}
	return new Set(config.ignore);
}

async function fetchExactTags(
	sandbox: ReleaseSandbox,
	tags: string[],
): Promise<void> {
	if (tags.length === 0) return;
	const refs = tags.map((tag) => `refs/tags/${tag}`);
	for (const ref of refs) await git(sandbox, ['check-ref-format', ref]);
	const result = await gitResult(
		sandbox,
		[
			'fetch',
			'--atomic',
			'--no-tags',
			'--filter=blob:none',
			'origin',
			...refs.map((ref) => `${ref}:${ref}`),
		],
		300,
	);
	if (!result.success) {
		throw new Error(`Exact baseline tag fetch failed: ${result.stderr}`);
	}
	const actual = (await git(sandbox, ['tag', '--list']))
		.split('\n')
		.filter(Boolean)
		.sort();
	const expected = [...tags].sort();
	if (
		actual.length !== expected.length ||
		actual.some((tag, index) => tag !== expected[index])
	) {
		throw new Error('Local tags do not match the required release baselines.');
	}
}

async function gitResult(
	sandbox: ReleaseSandbox,
	args: string[],
	timeoutSeconds = 120,
): Promise<ReleaseCommandResult> {
	return execReleaseCommand(
		sandbox,
		`git ${args.map(shellQuote).join(' ')}`,
		timeoutSeconds,
		RELEASE_REPO_DIR,
		`git ${args[0] ?? 'command'}`,
		false,
	);
}

async function git(sandbox: ReleaseSandbox, args: string[]): Promise<string> {
	const result = await gitResult(sandbox, args);
	if (!result.success) {
		throw new Error(`git ${args[0]} failed: ${result.stderr}`);
	}
	return result.stdout;
}

function parseJson(value: string, source: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error();
		}
		return parsed as Record<string, unknown>;
	} catch {
		throw new Error(`${source} is not a JSON object.`);
	}
}

const YAML_TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*):(.*)$/;
const YAML_LIST_ITEM =
	/^\s+-\s+(?:'([^']*)'|"([^"\\]*)"|([\w./][^\s#]*))\s*(?:#.*)?$/;
const YAML_IGNORABLE = /^\s*(?:#.*)?$/;

/**
 * Extracts the top-level `packages` block sequence from a pnpm-workspace.yaml without a
 * YAML parser. Only the plain block form pnpm documents is accepted (one quoted or bare
 * glob per `- ` line); anything else returns null so callers fail closed.
 */
export function parsePnpmWorkspacePackages(source: string): string[] | null {
	const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
	const start = lines.findIndex((line) => {
		const match = YAML_TOP_LEVEL_KEY.exec(line);
		return match?.[1] === 'packages';
	});
	if (start === -1) return null;
	if (
		!YAML_IGNORABLE.test(YAML_TOP_LEVEL_KEY.exec(lines[start] ?? '')?.[2] ?? '')
	) {
		return null;
	}
	if (
		lines.some(
			(line, index) =>
				index !== start && YAML_TOP_LEVEL_KEY.exec(line)?.[1] === 'packages',
		)
	) {
		return null;
	}
	const packages: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (YAML_IGNORABLE.test(line)) continue;
		if (!/^\s/.test(line)) break;
		const match = YAML_LIST_ITEM.exec(line);
		if (!match) return null;
		const value = match[1] ?? match[2] ?? match[3] ?? '';
		if (value.length === 0) return null;
		packages.push(value);
	}
	return packages.length > 0 ? packages : null;
}

function validateWorkspaces(workspaces: string[] | null, ref: string): void {
	if (!workspaces) {
		throw new Error(`Workspace configuration is invalid at ${ref}.`);
	}
	const actual = [...new Set(workspaces)].sort();
	if (
		actual.length !== EXPECTED_WORKSPACES.length ||
		actual.some((workspace, index) => workspace !== EXPECTED_WORKSPACES[index])
	) {
		throw new Error(`Workspace configuration changed at ${ref}.`);
	}
}
