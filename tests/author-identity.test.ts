import { describe, expect, it, vi } from 'vitest';
import {
	findStatusComment,
	loadPullRequestSnapshot,
} from '../src/author/github.ts';
import type { InstallationClient } from '../src/github/client.ts';
import type { FactoryIdentities } from '../src/github/identity.ts';
import { CHANGES_REQUESTED_VERDICT_MARKER } from '../src/review/verdict.ts';

const IDENTITIES: FactoryIdentities = {
	main: { appId: 1, login: 'astro-factory' },
	reviewer: { appId: 2, login: 'astro-factory-reviewer' },
	author: { appId: 3, login: 'astro-factory-author' },
};
const ref = { owner: 'withastro', repo: 'astro', pullNumber: 7 };

function review(login: string, typename: string, id: number) {
	return {
		author: { login, __typename: typename },
		authorAssociation: typename === 'Bot' ? 'NONE' : 'CONTRIBUTOR',
		state: 'COMMENTED',
		body: `Review ${id}\n${CHANGES_REQUESTED_VERDICT_MARKER}`,
		submittedAt: `2026-10-01T00:00:0${id}Z`,
		url: `https://github.com/withastro/astro/pull/7#review-${id}`,
	};
}

function pullRequest(reviews: ReturnType<typeof review>[]) {
	return {
		repository: {
			pullRequest: {
				title: 'Fix',
				body: '',
				state: 'OPEN',
				author: { login: 'astro-factory' },
				headRefName: 'fix',
				headRefOid: 'A'.repeat(40),
				baseRefName: 'main',
				isCrossRepository: false,
				assignees: { nodes: [] },
				timelineItems: { nodes: [] },
				comments: {
					nodes: [
						{
							author: { login: 'astro-factory-author', __typename: 'Bot' },
							authorAssociation: 'NONE',
							body: 'Status',
							createdAt: '2026-10-01T00:00:00Z',
							url: 'https://github.com/withastro/astro/pull/7#comment',
						},
					],
				},
				reviews: { nodes: reviews },
				reviewThreads: { nodes: [] },
			},
		},
	};
}

describe('loadPullRequestSnapshot', () => {
	it('marks every Factory App as Factory, and nobody else', async () => {
		const client = {
			graphql: vi.fn(async () =>
				pullRequest([
					review('astro-factory-reviewer', 'Bot', 1),
					review('astro-factory', 'Bot', 2),
					review('astro-factory-reviewer', 'User', 3),
					review('some-other-app', 'Bot', 4),
				]),
			),
		} as unknown as InstallationClient;

		const snapshot = await loadPullRequestSnapshot(client, ref, IDENTITIES);
		expect(
			snapshot.comments.map((comment) => [
				comment.author.login,
				comment.author.factory,
			]),
		).toEqual([
			['astro-factory-author', true],
			['astro-factory-reviewer', true],
			['astro-factory', true],
			['astro-factory-reviewer', false],
			['some-other-app', false],
		]);
	});

	it("trusts the verdict marker only from the reviewer persona's Apps", async () => {
		const client = {
			graphql: vi.fn(async () =>
				pullRequest([
					review('astro-factory-reviewer', 'Bot', 1),
					review('astro-factory', 'Bot', 2),
					review('astro-factory-author', 'Bot', 3),
					review('astro-factory-reviewer', 'User', 4),
				]),
			),
		} as unknown as InstallationClient;

		const snapshot = await loadPullRequestSnapshot(client, ref, IDENTITIES);
		expect(
			snapshot.comments
				.filter((comment) => comment.kind === 'review')
				.map((comment) => comment.requestsChanges),
		).toEqual([true, true, false, false]);
	});
});

describe('findStatusComment', () => {
	const marker = '<!-- factory:author-status -->';
	const comment = (id: number, appId: number | null, body = marker) => ({
		id,
		body,
		performed_via_github_app: appId === null ? null : { id: appId },
	});
	const clientWith = (comments: ReturnType<typeof comment>[]) =>
		({
			paginate: vi.fn(async () => comments),
			rest: { issues: { listComments: vi.fn() } },
		}) as unknown as InstallationClient;

	it("prefers the persona App's comment over the main App's", async () => {
		const client = clientWith([comment(10, 1), comment(11, 3)]);
		await expect(
			findStatusComment(client, ref, marker, [3, 1]),
		).resolves.toEqual({ id: 11, body: marker, appId: 3 });
	});

	it("falls back to the main App's comment", async () => {
		const client = clientWith([comment(10, 1)]);
		await expect(
			findStatusComment(client, ref, marker, [3, 1]),
		).resolves.toEqual({ id: 10, body: marker, appId: 1 });
	});

	it('ignores a marker another App or a person wrote', async () => {
		const client = clientWith([comment(10, 99), comment(11, null)]);
		await expect(findStatusComment(client, ref, marker, [3, 1])).resolves.toBe(
			null,
		);
	});
});
