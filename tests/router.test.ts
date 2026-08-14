import { describe, expect, it } from 'vitest';
import { routeDelivery } from '../src/router.ts';

const repository = {
	id: 456,
	name: 'astro',
	private: false,
	default_branch: 'main',
	owner: { login: 'withastro' },
};
const installation = { id: 123 };

describe('webhook dispatch router', () => {
	it('routes pull_request.labeled to review', () => {
		const dispatch = routeDelivery(
			'pull_request',
			{
				action: 'labeled',
				installation,
				repository,
				label: { name: 'ai-review' },
				pull_request: {
					number: 789,
					base: { ref: 'main', sha: 'a'.repeat(40) },
					head: { sha: 'b'.repeat(40) },
				},
			},
			'delivery-1',
		);
		expect(dispatch).toEqual({
			kind: 'review',
			params: {
				deliveryId: 'delivery-1',
				installationId: 123,
				repositoryId: 456,
				owner: 'withastro',
				repo: 'astro',
				pullNumber: 789,
				label: 'ai-review',
				baseSha: 'a'.repeat(40),
				baseRef: 'main',
				headSha: 'b'.repeat(40),
			},
		});
	});

	it.each(['opened', 'reopened', 'closed'] as const)(
		'routes issues.%s to triage',
		(action) => {
			const dispatch = routeDelivery(
				'issues',
				{ action, installation, repository, issue: { number: 42 } },
				'delivery-2',
			);
			expect(dispatch).toEqual({
				kind: 'triage',
				params: {
					deliveryId: 'delivery-2',
					installationId: 123,
					repositoryId: 456,
					owner: 'withastro',
					repo: 'astro',
					issueNumber: 42,
					defaultBranch: 'main',
					issueAction: action,
				},
			});
		},
	);

	it('routes issue_comment.created on an issue to triage', () => {
		const dispatch = routeDelivery(
			'issue_comment',
			{
				action: 'created',
				installation,
				repository,
				issue: { number: 42 },
				comment: { user: { login: 'reporter', type: 'User' } },
			},
			'delivery-3',
		);
		expect(dispatch).toMatchObject({
			kind: 'triage',
			params: { issueAction: 'comment', commentAuthor: 'reporter' },
		});
	});

	it('ignores comments on pull requests', () => {
		const dispatch = routeDelivery(
			'issue_comment',
			{
				action: 'created',
				installation,
				repository,
				issue: { number: 42, pull_request: {} },
				comment: { user: { login: 'reporter', type: 'User' } },
			},
			'delivery-4',
		);
		expect(dispatch.kind).toBe('none');
	});

	it('ignores bot comments to prevent self-trigger loops', () => {
		const dispatch = routeDelivery(
			'issue_comment',
			{
				action: 'created',
				installation,
				repository,
				issue: { number: 42 },
				comment: { user: { login: 'factory[bot]', type: 'Bot' } },
			},
			'delivery-5',
		);
		expect(dispatch).toEqual({ kind: 'none', reason: 'Comment from bot (factory[bot]).' });
	});

	it('ignores private repositories', () => {
		const dispatch = routeDelivery(
			'issues',
			{
				action: 'opened',
				installation,
				repository: { ...repository, private: true },
				issue: { number: 42 },
			},
			'delivery-6',
		);
		expect(dispatch).toEqual({
			kind: 'none',
			reason: 'Private repositories are not supported.',
		});
	});

	it('ignores unhandled events and actions', () => {
		expect(
			routeDelivery('issues', { action: 'labeled', installation, repository }, 'd').kind,
		).toBe('none');
		expect(routeDelivery('push', { installation, repository }, 'd').kind).toBe('none');
		expect(
			routeDelivery(
				'pull_request',
				{ action: 'opened', installation, repository },
				'd',
			).kind,
		).toBe('none');
	});
});
