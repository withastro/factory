/**
 * Pure helpers for the triage sandbox: workspace paths, id derivation, shell
 * quoting, and input validation. Kept free of workerd-only imports so they are
 * unit testable under node.
 */

/** The repository checkout the agent edits and the orchestrator commits from. */
export const REPO_DIR = '/repo';

/**
 * Pipeline scratch space: reproduction projects and report.md.
 *
 * Deliberately a sibling of the checkout, not a directory inside it. The
 * reproduce skill sets up throwaway projects here and cleans them up, and one
 * of those cleanups is `rm -rf` on a path the agent substitutes itself. When
 * this lived at `/repo/triage/...` a mis-resolved path could — and did — take
 * `/repo/.git` with it, destroying the checkout after the fix was already
 * written and losing the whole run at push time.
 */
export const TRIAGE_DIR = '/triage';

/**
 * One sandbox per issue+delivery. Sandbox ids become DNS labels, so keep
 * them lowercase alphanumeric/hyphen and at most 63 characters.
 */
export function triageSandboxId(
	repositoryId: number,
	issueNumber: number,
	deliveryId: string,
): string {
	const cleanDelivery = deliveryId.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
	return `t-${repositoryId}-${issueNumber}-${cleanDelivery}`.slice(0, 63).replace(/-+$/, '');
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function assertRepoIdentifier(value: string): void {
	if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
		throw new Error(`Unsafe repository identifier: ${JSON.stringify(value)}`);
	}
}

export function assertGitRef(value: string): void {
	if (value.startsWith('-') || !/^[A-Za-z0-9._\/-]+$/.test(value) || value.includes('..')) {
		throw new Error(`Unsafe git ref: ${JSON.stringify(value)}`);
	}
}

export function tail(value: string, max = 2_000): string {
	return value.length <= max ? value : value.slice(-max);
}

export function redactToken(value: string): string {
	return value
		.replace(/x-access-token:[^@\s]+/g, 'x-access-token:***')
		.replace(/(authorization:\s*basic\s+)[A-Za-z0-9+/=]+/gi, '$1***');
}
