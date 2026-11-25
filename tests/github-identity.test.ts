import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';

// Each fake App answers as the App its id names. App 1 is the main App.
const apps: Record<
	string,
	{ slug: string; installations: Record<string, number> }
> = {
	'1': { slug: 'astro-factory', installations: {} },
	'2': {
		slug: 'astro-factory-reviewer',
		installations: { 'withastro/astro': 222 },
	},
	'3': { slug: 'astro-factory-author', installations: {} },
};
const getInstallationOctokit = vi.fn(
	async (appId: string, installationId: number) => ({
		appId,
		installationId,
	}),
);

vi.mock('octokit', () => ({
	App: class {
		private readonly appId: string;
		readonly octokit;
		constructor(options: { appId: string }) {
			this.appId = options.appId;
			const app = apps[this.appId];
			this.octokit = {
				rest: {
					apps: {
						getAuthenticated: async () => ({
							data: { id: Number(this.appId), slug: app.slug },
						}),
						getRepoInstallation: async (params: {
							owner: string;
							repo: string;
						}) => {
							const id = app.installations[`${params.owner}/${params.repo}`];
							if (id === undefined) {
								throw Object.assign(new Error('Not Found'), { status: 404 });
							}
							return { data: { id } };
						},
					},
				},
			};
		}
		getInstallationOctokit(installationId: number) {
			return getInstallationOctokit(this.appId, installationId);
		}
	},
}));

const {
	allIdentities,
	authorIdentities,
	clearIdentityCaches,
	createPersonaClient,
	isAuthoredBy,
	personaCredentialsFromWorkerEnv,
	resolveFactoryIdentities,
	reviewerIdentities,
} = await import('../src/github/identity.ts');

const MAIN = { appId: 1, login: 'astro-factory' };
const REVIEWER = { appId: 2, login: 'astro-factory-reviewer' };
const AUTHOR = { appId: 3, login: 'astro-factory-author' };

function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
	return {
		GITHUB_APP_ID: '1',
		GITHUB_APP_PRIVATE_KEY: 'main-key',
		...overrides,
	} as WorkerEnv;
}

const repository = { owner: 'withastro', repo: 'astro', installationId: 111 };

beforeEach(() => {
	clearIdentityCaches();
	getInstallationOctokit.mockClear();
});

describe('personaCredentialsFromWorkerEnv', () => {
	it('is undefined when the persona has no App', () => {
		expect(personaCredentialsFromWorkerEnv(env(), 'reviewer')).toBeUndefined();
	});

	it('reads both secrets and normalizes the private key', () => {
		expect(
			personaCredentialsFromWorkerEnv(
				env({
					GITHUB_REVIEWER_APP_ID: '2',
					GITHUB_REVIEWER_APP_PRIVATE_KEY: 'first\\nsecond',
				}),
				'reviewer',
			),
		).toEqual({ appId: '2', privateKey: 'first\nsecond' });
	});

	it('rejects one secret without the other', () => {
		expect(() =>
			personaCredentialsFromWorkerEnv(
				env({ GITHUB_AUTHOR_APP_ID: '3' }),
				'author',
			),
		).toThrow(
			'GITHUB_AUTHOR_APP_ID and GITHUB_AUTHOR_APP_PRIVATE_KEY must be set together.',
		);
	});
});

describe('resolveFactoryIdentities', () => {
	it('shares the main identity with personas that have no App', async () => {
		await expect(resolveFactoryIdentities(env())).resolves.toEqual({
			main: MAIN,
			reviewer: MAIN,
			author: MAIN,
		});
	});

	it("uses each persona App's slug", async () => {
		await expect(
			resolveFactoryIdentities(
				env({
					GITHUB_REVIEWER_APP_ID: '2',
					GITHUB_REVIEWER_APP_PRIVATE_KEY: 'reviewer-key',
					GITHUB_AUTHOR_APP_ID: '3',
					GITHUB_AUTHOR_APP_PRIVATE_KEY: 'author-key',
				}),
			),
		).resolves.toEqual({ main: MAIN, reviewer: REVIEWER, author: AUTHOR });
	});
});

describe('createPersonaClient', () => {
	const withReviewer = env({
		GITHUB_REVIEWER_APP_ID: '2',
		GITHUB_REVIEWER_APP_PRIVATE_KEY: 'reviewer-key',
		GITHUB_AUTHOR_APP_ID: '3',
		GITHUB_AUTHOR_APP_PRIVATE_KEY: 'author-key',
	});

	it("writes as the persona App's installation on the repository", async () => {
		const persona = await createPersonaClient(
			withReviewer,
			'reviewer',
			repository,
		);
		expect(persona.identity).toEqual(REVIEWER);
		expect(getInstallationOctokit).toHaveBeenCalledWith('2', 222);
	});

	it("falls back to the main App where the persona App isn't installed", async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const persona = await createPersonaClient(
			withReviewer,
			'author',
			repository,
		);
		expect(persona.identity).toEqual(MAIN);
		expect(getInstallationOctokit).toHaveBeenCalledWith('1', 111);
		warn.mockRestore();
	});

	it('falls back to the main App when the persona has no App', async () => {
		const persona = await createPersonaClient(env(), 'reviewer', repository);
		expect(persona.identity).toEqual(MAIN);
		expect(getInstallationOctokit).toHaveBeenCalledWith('1', 111);
	});
});

describe('isAuthoredBy', () => {
	it('matches a Bot by its login, with or without the [bot] suffix', () => {
		expect(
			isAuthoredBy({ login: 'astro-factory-reviewer', __typename: 'Bot' }, [
				REVIEWER,
			]),
		).toBe(true);
		expect(
			isAuthoredBy(
				{ login: 'Astro-Factory-Reviewer[bot]', __typename: 'Bot' },
				[REVIEWER],
			),
		).toBe(true);
	});

	it('rejects a user with the same login, other Apps, and deleted accounts', () => {
		expect(
			isAuthoredBy({ login: 'astro-factory-reviewer', __typename: 'User' }, [
				REVIEWER,
			]),
		).toBe(false);
		expect(
			isAuthoredBy({ login: 'astro-factory-author', __typename: 'Bot' }, [
				REVIEWER,
			]),
		).toBe(false);
		expect(isAuthoredBy(null, [REVIEWER])).toBe(false);
	});
});

describe('identity sets', () => {
	const identities = { main: MAIN, reviewer: REVIEWER, author: AUTHOR };

	it('trusts the main App alongside each persona App', () => {
		expect(reviewerIdentities(identities)).toEqual([REVIEWER, MAIN]);
		expect(authorIdentities(identities)).toEqual([AUTHOR, MAIN]);
		expect(allIdentities(identities)).toEqual([MAIN, REVIEWER, AUTHOR]);
	});

	it('collapses to the main App when personas share it', () => {
		const shared = { main: MAIN, reviewer: MAIN, author: MAIN };
		expect(reviewerIdentities(shared)).toEqual([MAIN]);
		expect(allIdentities(shared)).toEqual([MAIN]);
	});
});
