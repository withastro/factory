import { describe, expect, it } from 'vitest';
import { routeDelivery } from '../src/router.ts';

const repository = {
	id: 456,
	name: 'astro',
	full_name: 'withastro/astro',
	private: false,
	default_branch: 'main',
	owner: { login: 'withastro' },
};
const installation = { id: 123 };
const context = {
	deliveryId: 'delivery-1',
	installationId: 123,
	repositoryId: 456,
	owner: 'withastro',
	repo: 'astro',
	defaultBranch: 'main',
	repoIsPrivate: false,
};

function factoryPull(overrides: Record<string, unknown> = {}) {
	return {
		number: 789,
		assignees: [{ login: 'astro-author', type: 'User' }],
		base: {
			ref: 'main',
			sha: 'a'.repeat(40),
			repo: { full_name: 'withastro/astro' },
		},
		head: {
			ref: 'factory/fix-12',
			sha: 'b'.repeat(40),
			repo: { full_name: 'withastro/astro' },
		},
		...overrides,
	};
}

describe('persona assignment routing', () => {
	it('routes issues.assigned with the assignee', () => {
		expect(
			routeDelivery(
				'issues',
				{
					action: 'assigned',
					installation,
					repository,
					issue: { number: 12 },
					assignee: { login: 'astro-triage', type: 'User' },
				},
				'delivery-1',
			),
		).toEqual({
			kind: 'persona-assignment',
			params: {
				...context,
				login: 'astro-triage',
				signal: 'assigned',
				subject: { type: 'issue', issueNumber: 12 },
			},
		});
	});

	it('routes pull_request.review_requested with the requested reviewer', () => {
		expect(
			routeDelivery(
				'pull_request',
				{
					action: 'review_requested',
					installation,
					repository,
					pull_request: factoryPull(),
					requested_reviewer: { login: 'astro-reviewer', type: 'User' },
				},
				'delivery-1',
			),
		).toEqual({
			kind: 'persona-assignment',
			params: {
				...context,
				login: 'astro-reviewer',
				signal: 'review-requested',
				subject: {
					type: 'pull_request',
					pullNumber: 789,
					baseRef: 'main',
					baseSha: 'a'.repeat(40),
					headSha: 'b'.repeat(40),
				},
			},
		});
	});

	it('routes pull_request.assigned with the assignee', () => {
		const dispatch = routeDelivery(
			'pull_request',
			{
				action: 'assigned',
				installation,
				repository,
				pull_request: factoryPull(),
				assignee: { login: 'astro-author', type: 'User' },
			},
			'delivery-1',
		);
		expect(dispatch).toMatchObject({
			kind: 'persona-assignment',
			params: { login: 'astro-author', signal: 'assigned' },
		});
	});

	it('ignores team review requests and assignments to bots', () => {
		expect(
			routeDelivery(
				'pull_request',
				{
					action: 'review_requested',
					installation,
					repository,
					pull_request: factoryPull(),
				},
				'delivery-1',
			).kind,
		).toBe('none');
		expect(
			routeDelivery(
				'issues',
				{
					action: 'assigned',
					installation,
					repository,
					issue: { number: 12 },
					assignee: { login: 'copilot[bot]', type: 'Bot' },
				},
				'delivery-1',
			).kind,
		).toBe('none');
	});
});

describe('author activity routing', () => {
	it('routes a human review on an assigned Factory pull request', () => {
		expect(
			routeDelivery(
				'pull_request_review',
				{
					action: 'submitted',
					installation,
					repository,
					pull_request: factoryPull(),
					review: {
						user: { login: 'maintainer', type: 'User' },
						state: 'changes_requested',
					},
				},
				'delivery-1',
			),
		).toEqual({
			kind: 'author-activity',
			params: {
				...context,
				pullNumber: 789,
				activity: 'review',
				actor: 'maintainer',
			},
		});
	});

	it('routes a human review comment', () => {
		expect(
			routeDelivery(
				'pull_request_review_comment',
				{
					action: 'created',
					installation,
					repository,
					pull_request: factoryPull(),
					comment: { user: { login: 'maintainer', type: 'User' } },
				},
				'delivery-1',
			),
		).toMatchObject({
			kind: 'author-activity',
			params: { activity: 'review-comment' },
		});
	});

	it('never lets bot feedback start the author', () => {
		for (const user of [
			{ login: 'factory[bot]', type: 'Bot' },
			{ login: 'astrobot-houston', type: 'User' },
		]) {
			expect(
				routeDelivery(
					'pull_request_review',
					{
						action: 'submitted',
						installation,
						repository,
						pull_request: factoryPull(),
						review: { user, state: 'commented' },
					},
					'delivery-1',
				).kind,
			).toBe('none');
		}
	});

	it('ignores reviews on pull requests no persona can own', () => {
		for (const pull of [
			factoryPull({ assignees: [] }),
			factoryPull({
				head: {
					ref: 'feat/thing',
					sha: 'b'.repeat(40),
					repo: { full_name: 'withastro/astro' },
				},
			}),
			factoryPull({
				head: {
					ref: 'factory/fix-12',
					sha: 'b'.repeat(40),
					repo: { full_name: 'someone/astro' },
				},
			}),
		]) {
			expect(
				routeDelivery(
					'pull_request_review',
					{
						action: 'submitted',
						installation,
						repository,
						pull_request: pull,
						review: { user: { login: 'maintainer', type: 'User' } },
					},
					'delivery-1',
				).kind,
			).toBe('none');
		}
	});

	it('routes human comments on assigned pull requests only', () => {
		const comment = (assignees: Array<{ login: string }>) =>
			routeDelivery(
				'issue_comment',
				{
					action: 'created',
					installation,
					repository,
					issue: { number: 789, pull_request: {}, assignees },
					comment: { user: { login: 'maintainer', type: 'User' } },
				},
				'delivery-1',
			);
		expect(comment([{ login: 'astro-author' }])).toMatchObject({
			kind: 'author-activity',
			params: { pullNumber: 789, activity: 'comment', actor: 'maintainer' },
		});
		expect(comment([]).kind).toBe('none');
	});

	it('still routes issue comments to triage', () => {
		expect(
			routeDelivery(
				'issue_comment',
				{
					action: 'created',
					installation,
					repository,
					issue: { number: 12 },
					comment: { user: { login: 'reporter', type: 'User' } },
				},
				'delivery-1',
			).kind,
		).toBe('triage');
	});

	it('routes failed check suites and workflow runs on Factory branches', () => {
		expect(
			routeDelivery(
				'check_suite',
				{
					action: 'completed',
					installation,
					repository,
					check_suite: {
						conclusion: 'failure',
						head_branch: 'factory/fix-12',
						pull_requests: [{ number: 789 }],
					},
				},
				'delivery-1',
			),
		).toEqual({
			kind: 'author-activity',
			params: { ...context, pullNumber: 789, activity: 'check-failure' },
		});
		expect(
			routeDelivery(
				'workflow_run',
				{
					action: 'completed',
					installation,
					repository,
					workflow_run: {
						conclusion: 'timed_out',
						head_branch: 'factory/fix-12',
						head_repository: { full_name: 'withastro/astro' },
						pull_requests: [{ number: 789 }],
					},
				},
				'delivery-1',
			),
		).toMatchObject({
			kind: 'author-activity',
			params: { activity: 'check-failure' },
		});
	});

	it('ignores passing checks, other branches, and fork workflow runs', () => {
		const suite = (conclusion: string, head_branch: string) =>
			routeDelivery(
				'check_suite',
				{
					action: 'completed',
					installation,
					repository,
					check_suite: {
						conclusion,
						head_branch,
						pull_requests: [{ number: 789 }],
					},
				},
				'delivery-1',
			).kind;
		expect(suite('success', 'factory/fix-12')).toBe('none');
		expect(suite('failure', 'main')).toBe('none');
		expect(
			routeDelivery(
				'workflow_run',
				{
					action: 'completed',
					installation,
					repository,
					workflow_run: {
						conclusion: 'failure',
						head_branch: 'factory/fix-12',
						head_repository: { full_name: 'someone/astro' },
						pull_requests: [{ number: 789 }],
					},
				},
				'delivery-1',
			).kind,
		).toBe('none');
	});
});
