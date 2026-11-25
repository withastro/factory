/**
 * Factory's GitHub identities: the main App plus optional per-persona Apps.
 *
 * The main App receives every webhook and does everything that isn't a
 * persona speaking: triage, checks, labels, review requests. The reviewer and
 * author personas can each have their own GitHub App, so their reviews,
 * replies, and commits show up as `<slug>[bot]` instead of all coming from
 * the main App. A persona App needs no webhook; Factory only writes with it.
 *
 * A persona without its own App, or whose App isn't installed on a
 * repository, writes with the main App, exactly as before persona Apps
 * existed.
 */

import { App } from 'octokit';
import type { WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	createScopedInstallationToken,
	credentialsFromWorkerEnv,
	type GitHubCredentials,
	type InstallationClient,
	normalizePrivateKey,
} from './client.ts';
import { isGitHubStatus } from './content.ts';

export type PersonaAppName = 'reviewer' | 'author';

/** A GitHub App account: its id, and its bot login without `[bot]`. */
export interface FactoryIdentity {
	appId: number;
	/** The App's slug, which is its bot login as GraphQL reports it. */
	login: string;
}

export interface FactoryIdentities {
	main: FactoryIdentity;
	/** Falls back to `main` when the reviewer has no App of its own. */
	reviewer: FactoryIdentity;
	/** Falls back to `main` when the author has no App of its own. */
	author: FactoryIdentity;
}

export interface RepositoryRef {
	owner: string;
	repo: string;
	/** The main App's installation, from the webhook. */
	installationId: number;
}

/** A client for one persona, and the identity its writes are attributed to. */
export interface PersonaClient {
	client: InstallationClient;
	identity: FactoryIdentity;
}

const PERSONA_ENV = {
	reviewer: {
		appId: 'GITHUB_REVIEWER_APP_ID',
		privateKey: 'GITHUB_REVIEWER_APP_PRIVATE_KEY',
	},
	author: {
		appId: 'GITHUB_AUTHOR_APP_ID',
		privateKey: 'GITHUB_AUTHOR_APP_PRIVATE_KEY',
	},
} as const satisfies Record<
	PersonaAppName,
	{ appId: keyof WorkerEnv; privateKey: keyof WorkerEnv }
>;

/**
 * Credentials for a persona's own App, or undefined when it has none. Both
 * secrets are needed; one without the other is a configuration error, not a
 * silent fallback.
 */
export function personaCredentialsFromWorkerEnv(
	env: WorkerEnv,
	persona: PersonaAppName,
): GitHubCredentials | undefined {
	const names = PERSONA_ENV[persona];
	const appId = env[names.appId];
	const privateKey = env[names.privateKey];
	if (!appId && !privateKey) return undefined;
	if (!appId || !privateKey) {
		throw new Error(
			`${names.appId} and ${names.privateKey} must be set together.`,
		);
	}
	return { appId, privateKey: normalizePrivateKey(privateKey) };
}

// Per-isolate caches. An App's slug never changes, and an installation id
// only changes if the App is uninstalled and installed again; a stale id
// fails loudly and the step retries in a fresh isolate.
const identityCache = new Map<string, Promise<FactoryIdentity>>();
const installationCache = new Map<string, number | null>();

/** Clears the per-isolate caches. For tests. */
export function clearIdentityCaches(): void {
	identityCache.clear();
	installationCache.clear();
}

function appFor(credentials: GitHubCredentials): App {
	return new App({
		appId: credentials.appId,
		privateKey: credentials.privateKey,
	});
}

async function identityOf(
	credentials: GitHubCredentials,
): Promise<FactoryIdentity> {
	let cached = identityCache.get(credentials.appId);
	if (!cached) {
		cached = appFor(credentials)
			.octokit.rest.apps.getAuthenticated()
			.then(({ data }) => {
				if (!data?.slug) {
					throw new Error(`GitHub App ${credentials.appId} has no slug.`);
				}
				return { appId: data.id, login: data.slug.toLowerCase() };
			});
		identityCache.set(credentials.appId, cached);
		// A failed lookup must not stick for the isolate's lifetime.
		cached.catch(() => identityCache.delete(credentials.appId));
	}
	return cached;
}

/**
 * The identities Factory writes as. A persona without its own App shares the
 * main App's identity.
 */
export async function resolveFactoryIdentities(
	env: WorkerEnv,
): Promise<FactoryIdentities> {
	const main = await identityOf(credentialsFromWorkerEnv(env));
	const persona = async (name: PersonaAppName) => {
		const credentials = personaCredentialsFromWorkerEnv(env, name);
		return credentials ? identityOf(credentials) : main;
	};
	const [reviewer, author] = await Promise.all([
		persona('reviewer'),
		persona('author'),
	]);
	return { main, reviewer, author };
}

/**
 * A client that writes as `persona`: its own App's installation on the
 * repository, or the main App's when it has no App or its App isn't
 * installed there.
 */
export async function createPersonaClient(
	env: WorkerEnv,
	persona: PersonaAppName,
	repository: RepositoryRef,
): Promise<PersonaClient> {
	const mainCredentials = credentialsFromWorkerEnv(env);
	const main = async (): Promise<PersonaClient> => ({
		client: await createInstallationClient(
			mainCredentials,
			repository.installationId,
		),
		identity: await identityOf(mainCredentials),
	});

	const credentials = personaCredentialsFromWorkerEnv(env, persona);
	if (!credentials) return main();

	const installationId = await personaInstallationId(credentials, repository);
	if (installationId === null) {
		console.warn(
			`[factory] The ${persona} App is not installed on ${repository.owner}/${repository.repo}; writing as the main App.`,
		);
		return main();
	}
	return {
		client: await createInstallationClient(credentials, installationId),
		identity: await identityOf(credentials),
	};
}

/**
 * Mint a short-lived, scoped installation token that acts as `persona`. Like
 * `createPersonaClient`, it falls back to the main App.
 */
export async function createPersonaScopedToken(
	env: WorkerEnv,
	persona: PersonaAppName,
	repository: RepositoryRef,
	permissions: {
		contents?: 'read' | 'write';
		issues?: 'read' | 'write';
		metadata?: 'read';
	},
): Promise<string> {
	const credentials = personaCredentialsFromWorkerEnv(env, persona);
	const installationId = credentials
		? await personaInstallationId(credentials, repository)
		: null;
	if (credentials && installationId !== null) {
		return createScopedInstallationToken(
			credentials,
			installationId,
			permissions,
		);
	}
	return createScopedInstallationToken(
		credentialsFromWorkerEnv(env),
		repository.installationId,
		permissions,
	);
}

async function personaInstallationId(
	credentials: GitHubCredentials,
	repository: RepositoryRef,
): Promise<number | null> {
	const key =
		`${credentials.appId}:${repository.owner}/${repository.repo}`.toLowerCase();
	const cached = installationCache.get(key);
	if (cached !== undefined) return cached;
	let installationId: number | null;
	try {
		const { data } = await appFor(
			credentials,
		).octokit.rest.apps.getRepoInstallation({
			owner: repository.owner,
			repo: repository.repo,
		});
		installationId = data.id;
	} catch (error) {
		if (!isGitHubStatus(error, 404)) throw error;
		installationId = null;
	}
	installationCache.set(key, installationId);
	return installationId;
}

// ---------- Authorship ----------

/** A bot login in the form GraphQL reports it: lowercase, no `[bot]`. */
function normalizeBotLogin(login: string): string {
	return login.toLowerCase().replace(/\[bot\]$/, '');
}

/**
 * Whether a GraphQL `author { login __typename }` is one of `identities`.
 * Bot logins are App slugs, which are unique and can't be taken by a user,
 * so a `Bot` with a matching login is that App.
 */
export function isAuthoredBy(
	author: { login: string; __typename?: string } | null | undefined,
	identities: readonly FactoryIdentity[],
): boolean {
	if (author?.__typename !== 'Bot') return false;
	const login = normalizeBotLogin(author.login);
	return identities.some((identity) => identity.login === login);
}

/** Every distinct identity Factory writes as. */
export function allIdentities(
	identities: FactoryIdentities,
): FactoryIdentity[] {
	return dedupe([identities.main, identities.reviewer, identities.author]);
}

/**
 * The identities whose reviews count as the reviewer persona's: its own App,
 * and the main App, which wrote every persona review before persona Apps
 * existed.
 */
export function reviewerIdentities(
	identities: FactoryIdentities,
): FactoryIdentity[] {
	return dedupe([identities.reviewer, identities.main]);
}

/** As `reviewerIdentities`, for the author persona. */
export function authorIdentities(
	identities: FactoryIdentities,
): FactoryIdentity[] {
	return dedupe([identities.author, identities.main]);
}

function dedupe(identities: FactoryIdentity[]): FactoryIdentity[] {
	return identities.filter(
		(identity, index) =>
			identities.findIndex((other) => other.appId === identity.appId) === index,
	);
}
