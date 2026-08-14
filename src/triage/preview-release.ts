/**
 * Preview releases: publish an installable build of a candidate fix so the
 * issue reporter can test it before a maintainer merges anything. A confirmed
 * preview is what moves an issue into "fix pending" and unlocks the
 * FixVerifier conversation loop.
 *
 * Publishing has to happen inside the target repository's own CI: services
 * like pkg.pr.new authenticate with that repository's GitHub Actions OIDC
 * identity, which a Worker cannot present. The factory therefore only
 *   1. dispatches a maintainer-owned `workflow_dispatch` workflow, and
 *   2. reads the published package list back from a check run on the pushed
 *      fix branch commit.
 *
 * Trust model. Two separate boundaries matter here:
 *
 * - *Dispatch* is safe: it always targets the repository's default branch, so
 *   the workflow definition stays maintainer-controlled and an agent can never
 *   rewrite the CI that builds its own code. Only the branch name travels as
 *   an input.
 * - *The return path is untrusted.* The repo-side workflow necessarily builds
 *   agent-authored code (`npm ci`, `npm run build` run lifecycle scripts from
 *   the fix branch), so anything that code can influence — including the check
 *   summary — must be treated as attacker-controlled. The published URLs end
 *   up in a comment telling a human to run `npm i <url>`, so they are
 *   constrained to an explicit host allowlist and the payload is rejected
 *   whole rather than partially trusted.
 */

import * as v from 'valibot';
import type { InstallationClient } from '../github/client.ts';
import { isGitHubStatus } from '../github/content.ts';

/** Check run the repo-side workflow reports its results to. */
export const DEFAULT_PREVIEW_CHECK_NAME = 'factory/preview-release';

/** GitHub Actions creates check runs under this app slug via `github.token`. */
export const DEFAULT_PREVIEW_CHECK_APP = 'github-actions';

/** Hosts trusted to serve preview packages unless a repository widens it. */
export const DEFAULT_PREVIEW_HOSTS = ['pkg.pr.new'] as const;

const MAX_PREVIEW_PACKAGES = 20;

const previewPayloadSchema = v.object({
	packages: v.pipe(
		v.array(
			v.object({
				// Rendered into a fenced shell block, so keep it to characters a
				// package name can actually contain.
				name: v.pipe(
					v.string(),
					v.trim(),
					v.minLength(1),
					v.maxLength(214),
					v.regex(/^[@a-z0-9._/-]+$/i),
				),
				url: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_048)),
			}),
		),
		v.minLength(1),
		v.maxLength(MAX_PREVIEW_PACKAGES),
	),
});

export type PreviewPackage = v.InferOutput<typeof previewPayloadSchema>['packages'][number];

export interface PreviewReleaseCheck {
	status: string;
	conclusion: string | null;
	summary: string;
}

/**
 * Extract the published package list from a check run summary.
 *
 * The summary is CI-authored, and the job that writes it has executed
 * agent-authored build scripts, so this is an untrusted parse: anything
 * malformed, or any URL outside `allowedHosts`, yields no packages at all. It
 * fails closed on purpose — a partially trusted list would still be rendered
 * as an install instruction.
 */
export function parsePreviewReleasePayload(
	summary: string,
	allowedHosts: readonly string[] = DEFAULT_PREVIEW_HOSTS,
): PreviewPackage[] {
	const source = extractJsonBlock(summary);
	if (source === null) return [];

	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return [];
	}

	const result = v.safeParse(previewPayloadSchema, value);
	if (!result.success) return [];

	const packages = result.output.packages;
	if (!packages.every((entry) => isTrustedPreviewUrl(entry.url, allowedHosts))) return [];
	return packages;
}

/**
 * A preview URL must be an https URL on an allowed host, with no embedded
 * credentials (which would let an attacker spoof the host in rendered text)
 * and no characters that could break out of the markdown or shell context it
 * gets rendered into.
 */
export function isTrustedPreviewUrl(value: string, allowedHosts: readonly string[]): boolean {
	if (/[\s()[\]<>"'`\\|;&$]/.test(value)) return false;

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:') return false;
	if (url.username !== '' || url.password !== '') return false;

	const host = url.hostname.toLowerCase();
	return allowedHosts.some((allowed) => {
		const normalized = allowed.toLowerCase();
		return host === normalized || host.endsWith(`.${normalized}`);
	});
}

function extractJsonBlock(summary: string): string | null {
	const fenced = /```json\s*\r?\n([\s\S]*?)```/i.exec(summary);
	if (fenced?.[1]) return fenced[1];
	const trimmed = summary.trim();
	return trimmed.startsWith('{') ? trimmed : null;
}

/**
 * Render the install instructions deterministically.
 *
 * This is built in trusted code rather than asked of the comment agent, so the
 * "fix pending" label and the comment can never disagree, and the untrusted
 * URLs never enter a model prompt.
 */
export function formatPreviewReleaseSection(packages: PreviewPackage[]): string {
	return [
		'### Try this fix',
		'',
		'You can test this fix right now without waiting for a release:',
		'',
		'```sh',
		...packages.flatMap((entry) => [`# ${entry.name}`, `npm i ${entry.url}`]),
		'```',
		'',
		'If this fixes your issue, please leave a comment letting us know (for example',
		'"confirmed, this fixes it"). A pull request will then be opened to get it merged.',
	].join('\n');
}

/**
 * Ask the repository to build and publish a preview release for `branch`.
 *
 * A repository can configure a preview workflow before committing it, revoke
 * the Actions permission, or declare inputs the factory doesn't send. None of
 * those should fail an otherwise successful triage run, so they report as
 * "not dispatched" instead.
 */
export async function dispatchPreviewRelease(
	client: InstallationClient,
	options: {
		owner: string;
		repo: string;
		workflow: string;
		/** Maintainer-controlled ref the workflow definition is read from. */
		ref: string;
		branch: string;
		issueNumber: number;
	},
): Promise<{ dispatched: boolean; detail: string }> {
	try {
		await client.rest.actions.createWorkflowDispatch({
			owner: options.owner,
			repo: options.repo,
			workflow_id: options.workflow,
			ref: options.ref,
			inputs: { branch: options.branch, issue: String(options.issueNumber) },
		});
		return { dispatched: true, detail: 'dispatched' };
	} catch (error) {
		for (const status of [403, 404, 422] as const) {
			if (isGitHubStatus(error, status)) {
				return {
					dispatched: false,
					detail: `${options.workflow} could not be dispatched (HTTP ${status}).`,
				};
			}
		}
		throw error;
	}
}

/**
 * Read the newest preview-release check run for a commit, if one exists yet.
 *
 * `checks.listForRef` returns the latest run *per app*, so the creating app is
 * asserted rather than assumed: without that, any GitHub App installed on the
 * repository could publish a check run under the expected name and have it win
 * on recency.
 */
export async function findPreviewReleaseCheck(
	client: InstallationClient,
	owner: string,
	repo: string,
	sha: string,
	options: { checkName: string; appSlug: string },
): Promise<PreviewReleaseCheck | null> {
	const response = await client.rest.checks.listForRef({
		owner,
		repo,
		ref: sha,
		check_name: options.checkName,
		per_page: 20,
	});

	const runs = response.data.check_runs.filter((run) => run.app?.slug === options.appSlug);
	if (runs.length === 0) return null;

	// GitHub returns the latest run first, but a re-run makes that ordering
	// worth asserting rather than assuming.
	const newest = runs.reduce((latest, run) => (startedAt(run) >= startedAt(latest) ? run : latest));
	return {
		status: newest.status,
		conclusion: newest.conclusion ?? null,
		summary: newest.output?.summary ?? '',
	};
}

function startedAt(run: { started_at?: string | null }): number {
	const parsed = Date.parse(run.started_at ?? '');
	return Number.isNaN(parsed) ? 0 : parsed;
}
