/**
 * Which pull requests the PR safety check reviews.
 *
 * Maintainers can already push to the repository, so reviewing their pull
 * requests for malicious intent adds cost without adding a boundary. The
 * check covers everyone else, and the dependency bots whose pull requests
 * rewrite lockfiles and manifests on behalf of upstream packages: a
 * compromised or typosquatted dependency arrives that way. Other bots
 * (Factory itself, changesets) are skipped; release pull requests have their
 * own release-security review.
 */

import { isBotAuthor } from '../github/bots.ts';

export const TRUSTED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
	'OWNER',
	'MEMBER',
	'COLLABORATOR',
]);

export const DEPENDENCY_BOT_LOGINS: ReadonlySet<string> = new Set([
	'renovate[bot]',
	'dependabot[bot]',
]);

export interface PrSafetyAuthor {
	login?: string;
	type?: string;
	association?: string;
}

export type PrSafetyScope =
	| { review: true }
	| { review: false; reason: string };

export function prSafetyScope(author: PrSafetyAuthor): PrSafetyScope {
	const login = author.login;
	if (!login)
		return { review: false, reason: 'The pull request has no author.' };
	if (author.type === 'Bot' || isBotAuthor(login)) {
		return DEPENDENCY_BOT_LOGINS.has(login)
			? { review: true }
			: { review: false, reason: `Pull request from bot ${login}.` };
	}
	const association = author.association?.toUpperCase();
	if (association && TRUSTED_AUTHOR_ASSOCIATIONS.has(association)) {
		return {
			review: false,
			reason: `Pull request from a trusted author (${association}).`,
		};
	}
	return { review: true };
}
