import { describe, expect, it, vi } from 'vitest';
import {
	type FeedbackAuthor,
	INITIAL_AUTHOR_STATE,
	type PullRequestSnapshot,
} from '../src/author/contracts.ts';
import { isTrustedAuthor, selectAuthorWork } from '../src/author/feedback.ts';
import { resolveWriteAccess } from '../src/author/github.ts';
import type { InstallationClient } from '../src/github/client.ts';

// How GitHub shows an org member with private membership to an app.
const privateMember: FeedbackAuthor = {
	login: 'MatthewP',
	association: 'CONTRIBUTOR',
	factory: false,
	bot: false,
};
const contributor: FeedbackAuthor = {
	login: 'drive-by',
	association: 'CONTRIBUTOR',
	factory: false,
	bot: false,
};
const maintainer: FeedbackAuthor = {
	login: 'maintainer',
	association: 'MEMBER',
	factory: false,
	bot: false,
};
const bot: FeedbackAuthor = {
	login: 'renovate',
	association: 'CONTRIBUTOR',
	factory: false,
	bot: true,
};

function snapshot(): PullRequestSnapshot {
	return {
		title: 'fix: something',
		body: '',
		state: 'open',
		author: 'astro-factory',
		headRef: 'factory/fix-1',
		headSha: 'b'.repeat(40),
		baseRef: 'main',
		isCrossRepository: false,
		assignees: ['astro-author'],
		assignments: [],
		comments: [
			{
				kind: 'review',
				author: privateMember,
				state: 'CHANGES_REQUESTED',
				requestsChanges: true,
				body: 'This does not look right.',
				createdAt: '2026-09-28T14:23:52Z',
				url: 'https://github.com/o/r/pull/1#review-1',
			},
			{
				kind: 'review',
				author: contributor,
				state: 'CHANGES_REQUESTED',
				requestsChanges: true,
				body: 'Please change this.',
				createdAt: '2026-09-28T14:24:00Z',
				url: 'https://github.com/o/r/pull/1#review-2',
			},
			{
				kind: 'comment',
				author: maintainer,
				state: null,
				body: 'Thanks!',
				createdAt: '2026-09-28T14:25:00Z',
				url: 'https://github.com/o/r/pull/1#comment-1',
			},
			{
				kind: 'comment',
				author: bot,
				state: null,
				body: 'Bump',
				createdAt: '2026-09-28T14:26:00Z',
				url: 'https://github.com/o/r/pull/1#comment-2',
			},
		],
		threads: [
			{
				threadId: 'T1',
				path: 'src/a.ts',
				line: 1,
				isOutdated: false,
				url: 'https://github.com/o/r/pull/1#discussion_r1',
				startedBy: privateMember,
				comments: [
					{
						author: privateMember,
						body: 'Rename this.',
						createdAt: '2026-09-28T14:23:50Z',
					},
				],
				omittedComments: 0,
			},
		],
	};
}

function clientWithPermissions(permissions: Record<string, string | 404>) {
	const getCollaboratorPermissionLevel = vi.fn(
		async ({ username }: { username: string }) => {
			const permission = permissions[username];
			if (permission === undefined || permission === 404) {
				throw Object.assign(new Error('Not Found'), { status: 404 });
			}
			return { data: { permission } };
		},
	);
	const client = {
		rest: { repos: { getCollaboratorPermissionLevel } },
	} as unknown as InstallationClient;
	return { client, getCollaboratorPermissionLevel };
}

describe('author write-access trust', () => {
	it('trusts authors with write access regardless of association', () => {
		expect(isTrustedAuthor(privateMember)).toBe(false);
		expect(isTrustedAuthor({ ...privateMember, writeAccess: true })).toBe(true);
		expect(isTrustedAuthor({ ...bot, writeAccess: true })).toBe(false);
	});

	it('looks up only untrusted humans, once each', async () => {
		const { client, getCollaboratorPermissionLevel } = clientWithPermissions({
			matthewp: 'admin',
			'drive-by': 'read',
		});
		await resolveWriteAccess(client, { owner: 'o', repo: 'r' }, snapshot());
		expect(
			getCollaboratorPermissionLevel.mock.calls
				.map(([args]) => args.username)
				.sort(),
		).toEqual(['drive-by', 'matthewp']);
	});

	it('lets a private org member start a round with changes requested', async () => {
		const { client } = clientWithPermissions({
			matthewp: 'admin',
			'drive-by': 404,
		});
		const resolved = await resolveWriteAccess(
			client,
			{ owner: 'o', repo: 'r' },
			snapshot(),
		);
		const work = selectAuthorWork(
			resolved,
			{
				...INITIAL_AUTHOR_STATE,
				round: 1,
				lastHandledAt: '2026-09-28T11:17:36Z',
			},
			[],
		);
		expect(work.hasNewActivity).toBe(true);
		expect(work.changeRequests).toEqual([
			{ login: 'MatthewP', factory: false },
		]);
		expect(work.comments.map((comment) => comment.author.login)).toEqual([
			'MatthewP',
			'maintainer',
		]);
		expect(work.threads.map((thread) => thread.threadId)).toEqual(['T1']);
	});

	it('leaves the snapshot alone when nobody needs a lookup or none has access', async () => {
		const { client } = clientWithPermissions({});
		const input = snapshot();
		const resolved = await resolveWriteAccess(
			client,
			{ owner: 'o', repo: 'r' },
			input,
		);
		expect(resolved).toBe(input);
	});
});
