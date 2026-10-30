import { describe, expect, it } from 'vitest';
import {
	extractPrSafetyResult,
	parsePrSafetyResult,
	prSafetySandboxId,
} from '../src/pr-safety/contracts.ts';
import {
	formatAlert,
	formatPrivateReport,
	shouldAlert,
} from '../src/pr-safety/output.ts';
import { prSafetyScope } from '../src/pr-safety/scope.ts';
import { routeDelivery } from '../src/router.ts';

const sha = 'c'.repeat(40);
const repository = {
	id: 456,
	name: 'astro',
	full_name: 'withastro/astro',
	private: false,
	default_branch: 'main',
	owner: { login: 'withastro' },
};
const installation = { id: 123 };

function pull(overrides: Record<string, unknown> = {}) {
	return {
		number: 42,
		html_url: 'https://github.com/withastro/astro/pull/42',
		title: 'fix: handle trailing slash',
		body: 'Fixes #1',
		user: { login: 'contributor', type: 'User' },
		author_association: 'FIRST_TIME_CONTRIBUTOR',
		base: {
			ref: 'main',
			sha: 'a'.repeat(40),
			repo: { full_name: 'withastro/astro' },
		},
		head: {
			ref: 'patch-1',
			sha: 'B'.repeat(40),
			repo: { full_name: 'contributor/astro' },
		},
		...overrides,
	};
}

describe('PR safety scope', () => {
	it('reviews untrusted authors and dependency bots only', () => {
		expect(
			prSafetyScope({ login: 'x', type: 'User', association: 'NONE' }),
		).toEqual({
			review: true,
		});
		expect(
			prSafetyScope({ login: 'x', type: 'User', association: 'CONTRIBUTOR' }),
		).toEqual({ review: true });
		expect(
			prSafetyScope({
				login: 'renovate[bot]',
				type: 'Bot',
				association: 'NONE',
			}),
		).toEqual({ review: true });
		for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
			expect(
				prSafetyScope({ login: 'm', type: 'User', association }).review,
			).toBe(false);
		}
		expect(
			prSafetyScope({ login: 'changeset-bot[bot]', type: 'Bot' }).review,
		).toBe(false);
		expect(
			prSafetyScope({ login: 'astrobot-houston', type: 'User' }).review,
		).toBe(false);
		expect(prSafetyScope({}).review).toBe(false);
	});
});

describe('PR safety routing', () => {
	it.each(['opened', 'reopened', 'synchronize'])(
		'routes pull_request.%s from an untrusted author',
		(action) => {
			const dispatch = routeDelivery(
				'pull_request',
				{ action, installation, repository, pull_request: pull() },
				'delivery-1',
			);
			expect(dispatch).toEqual({
				kind: 'pr-safety',
				params: {
					deliveryId: 'delivery-1',
					installationId: 123,
					repositoryId: 456,
					owner: 'withastro',
					repo: 'astro',
					defaultBranch: 'main',
					repoIsPrivate: false,
					pullNumber: 42,
					pullUrl: 'https://github.com/withastro/astro/pull/42',
					pullTitle: 'fix: handle trailing slash',
					pullBody: 'Fixes #1',
					author: 'contributor',
					authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
					headRepository: 'contributor/astro',
					headSha: 'b'.repeat(40),
					baseRef: 'main',
					baseSha: 'a'.repeat(40),
				},
			});
		},
	);

	it('skips maintainers, edits, and incomplete payloads', () => {
		expect(
			routeDelivery(
				'pull_request',
				{
					action: 'opened',
					installation,
					repository,
					pull_request: pull({ author_association: 'MEMBER' }),
				},
				'd',
			).kind,
		).toBe('none');
		expect(
			routeDelivery(
				'pull_request',
				{ action: 'edited', installation, repository, pull_request: pull() },
				'd',
			).kind,
		).toBe('none');
		expect(
			routeDelivery(
				'pull_request',
				{
					action: 'opened',
					installation,
					repository,
					pull_request: pull({ html_url: undefined }),
				},
				'd',
			).kind,
		).toBe('none');
	});

	it('leaves release pull requests to release security', () => {
		const dispatch = routeDelivery(
			'pull_request',
			{
				action: 'opened',
				installation,
				repository,
				pull_request: pull({
					head: {
						ref: 'changeset-release/main',
						sha: 'b'.repeat(40),
						repo: { full_name: 'withastro/astro' },
					},
				}),
			},
			'd',
		);
		expect(dispatch.kind).toBe('release-security');
	});
});

describe('PR safety results', () => {
	it('accepts a well-formed result for the expected head', () => {
		const result = {
			verdict: 'SUSPICIOUS',
			reviewedSha: sha,
			summary: 'Adds an unexplained postinstall script.',
			report: 'SUSPICIOUS - see packages/x/package.json:12',
		};
		expect(parsePrSafetyResult(result, sha)).toEqual(result);
	});

	it('turns stale, malformed, or missing results into INCOMPLETE', () => {
		const result = {
			verdict: 'CLEAN',
			reviewedSha: 'd'.repeat(40),
			summary: 'ok',
			report: 'CLEAN',
		};
		expect(parsePrSafetyResult(result, sha).verdict).toBe('INCOMPLETE');
		expect(
			parsePrSafetyResult(
				{ ...result, reviewedSha: sha, report: 'looks fine' },
				sha,
			).verdict,
		).toBe('INCOMPLETE');
		expect(parsePrSafetyResult({ verdict: 'APPROVE' }, sha).verdict).toBe(
			'INCOMPLETE',
		);
		expect(extractPrSafetyResult({}, sha).verdict).toBe('INCOMPLETE');
	});

	it('derives a sandbox id within the container name limit', () => {
		const id = prSafetySandboxId({
			repositoryId: 1,
			pullNumber: 2,
			deliveryId: `${'X'.repeat(80)}_y`,
		});
		expect(id.length).toBeLessThanOrEqual(63);
		expect(id).toMatch(/^ps-1-2-[a-z0-9-]+$/);
	});
});

describe('PR safety output', () => {
	const totals = { high: 1, medium: 2, info: 3 };
	const input = {
		owner: 'withastro',
		repo: 'astro',
		pullNumber: 42,
		pullUrl: 'https://github.com/withastro/astro/pull/42',
		pullTitle: 'fix: `typo` [x](<https://evil>) @everyone \u202E',
		author: 'contributor',
		authorAssociation: 'NONE',
	};

	it('alerts for findings, and for incomplete reviews with serious signals', () => {
		expect(shouldAlert('CLEAN', totals)).toBe(false);
		expect(shouldAlert('SUSPICIOUS', { high: 0, medium: 0, info: 0 })).toBe(
			true,
		);
		expect(shouldAlert('MALICIOUS', { high: 0, medium: 0, info: 0 })).toBe(
			true,
		);
		expect(shouldAlert('INCOMPLETE', totals)).toBe(true);
		expect(shouldAlert('INCOMPLETE', { high: 0, medium: 5, info: 0 })).toBe(
			false,
		);
	});

	it('neutralizes untrusted text in alerts', () => {
		const alert = formatAlert(
			input,
			{
				verdict: 'MALICIOUS',
				reviewedSha: sha,
				summary: 'Exfiltrates `env`.\nSee <x>',
			},
			totals,
		);
		expect(alert).toContain('**PR safety: Malicious**');
		expect(alert).toContain('1 high, 2 medium, 3 info');
		const quotedTitle = (alert.split('\n')[1] as string).replace(/^> /, '');
		expect(quotedTitle).not.toMatch(/[`[\]<>]/);
		expect(quotedTitle).toContain('\\u{202E}');
		expect(alert).toContain('Exfiltrates env. See x');
	});

	it('records the model report alongside the rule signals', () => {
		const report = formatPrivateReport(
			input,
			{
				verdict: 'CLEAN',
				reviewedSha: sha,
				summary: 'Fine.',
				report: 'CLEAN - fine',
			},
			{
				signals: [
					{
						rule: 'network-call',
						severity: 'medium',
						detail: 'Makes a network request.',
						path: 'src/a|b.ts',
						line: 3,
						excerpt: 'fetch(`x`)',
						occurrences: 2,
					},
				],
				totals: { high: 0, medium: 1, info: 0 },
				files: 1,
				addedLines: 3,
				removedLines: 0,
				truncated: false,
			},
		);
		expect(report).toContain('- Verdict: CLEAN');
		expect(report).toContain('CLEAN - fine');
		expect(report).toContain(
			"| medium | network-call | src/a\\|b.ts:3 (×2) | Makes a network request.<br>`fetch('x')` |",
		);
	});
});
