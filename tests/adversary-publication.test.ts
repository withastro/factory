import { describe, expect, it, vi } from 'vitest';
import {
	createAdversaryPullRequest,
	escapeModelMarkdown,
	renderAdversaryComment,
} from '../src/adversary/publication.ts';
import type { InstallationClient } from '../src/github/client.ts';

const metadata = {
	pullNumber: 42,
	headSha: 'a'.repeat(40),
	baseRef: 'main',
	baseSha: 'b'.repeat(40),
	branch: 'factory/adversary/pr-42-aaaaaaaaaaaa',
	branchSha: 'c'.repeat(40),
	deliveryId: 'delivery-1',
};

describe('adversary publication', () => {
	it('escapes model-controlled Markdown and reports unqualified results', () => {
		const body = renderAdversaryComment(
			{
				owner: 'withastro',
				repo: 'factory',
				pullNumber: 42,
				baseSha: metadata.baseSha,
				deliveryId: metadata.deliveryId,
			},
			{
				changeType: 'feature',
				contract: [],
				qualification: {
					sameProblem: true,
					materiallyDifferent: true,
					verified: false,
					safeguardsPreserved: true,
					scopeAppropriate: true,
				},
				comparisons: [],
				recommendation: 'inconclusive',
				summary: '<script>*Missing evidence*</script>',
				decisiveCriteria: ['Validation'],
				uncertainties: ['No integration test'],
				confidence: 'low',
			},
		);
		expect(body).toContain(
			'&lt;script&gt;\\*Missing evidence\\*&lt;/script&gt;',
		);
		expect(body).toContain("did not pass Purple's qualification gate");
		expect(body).toContain('No alternative pull request was created');
	});

	it('links the automatically created PR when Purple selects Blue', () => {
		const body = renderAdversaryComment(
			{
				owner: 'withastro',
				repo: 'factory',
				pullNumber: 42,
				baseSha: metadata.baseSha,
				deliveryId: metadata.deliveryId,
			},
			{
				changeType: 'feature',
				contract: [],
				qualification: {
					sameProblem: true,
					materiallyDifferent: true,
					verified: true,
					safeguardsPreserved: true,
					scopeAppropriate: true,
				},
				comparisons: [],
				recommendation: 'blue',
				summary: 'Blue has the stronger design.',
				decisiveCriteria: ['Maintainability'],
				uncertainties: [],
				confidence: 'high',
			},
			{
				branch: metadata.branch,
				branchSha: metadata.branchSha,
				pullRequestNumber: 99,
				pullRequestUrl: 'https://github.com/withastro/factory/pull/99',
			},
		);
		expect(body).toContain('Purple selected **Blue**');
		expect(body).toContain(
			'[Review alternative PR #99](https://github.com/withastro/factory/pull/99)',
		);
	});

	it('creates the selected alternative as a draft pull request', async () => {
		const template = '## Caller checklist\n\n- [ ] Tests added\n';
		const list = vi.fn();
		const create = vi.fn(async () => ({
			data: {
				number: 99,
				html_url: 'https://github.com/withastro/factory/pull/99',
			},
		}));
		const client = {
			rest: {
				pulls: {
					get: vi.fn(async () => ({
						data: {
							state: 'open',
							head: { sha: metadata.headSha },
							base: { ref: metadata.baseRef },
						},
					})),
					list,
					create,
				},
				git: {
					getRef: vi.fn(async () => ({
						data: { object: { sha: metadata.branchSha } },
					})),
				},
				repos: {
					getContent: vi.fn(async () => ({
						data: {
							type: 'file',
							content: Buffer.from(template).toString('base64'),
							encoding: 'base64',
						},
					})),
				},
			},
			paginate: vi.fn(async () => []),
		} as unknown as InstallationClient;

		await expect(
			createAdversaryPullRequest(client, {
				owner: 'withastro',
				repo: 'factory',
				pullNumber: metadata.pullNumber,
				headSha: metadata.headSha,
				baseRef: metadata.baseRef,
				baseSha: metadata.baseSha,
				branch: metadata.branch,
				branchSha: metadata.branchSha,
			}),
		).resolves.toEqual({
			pullRequestNumber: 99,
			pullRequestUrl: 'https://github.com/withastro/factory/pull/99',
		});
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				head: metadata.branch,
				base: metadata.baseRef,
				draft: true,
				body: expect.stringMatching(
					/^## Caller checklist[\s\S]*Purple selected this alternative implementation/,
				),
			}),
		);
		expect(client.rest.repos.getContent).toHaveBeenCalledWith({
			owner: 'withastro',
			repo: 'factory',
			path: '.github/pull_request_template.md',
			ref: metadata.baseSha,
		});
	});

	it('escapes links and raw HTML characters', () => {
		expect(escapeModelMarkdown('[x](javascript:alert(1)) <b>')).toBe(
			'\\[x\\]\\(javascript:alert\\(1\\)\\) &lt;b&gt;',
		);
	});
});
