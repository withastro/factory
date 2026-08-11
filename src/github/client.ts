import { App, type Octokit } from 'octokit';
import type { WorkerEnv } from '../env.ts';

export interface GitHubCredentials {
	appId: string;
	privateKey: string;
}

export type InstallationClient = Octokit;

export function credentialsFromWorkerEnv(env: WorkerEnv): GitHubCredentials {
	return {
		appId: env.GITHUB_APP_ID,
		privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
	};
}

export function credentialsFromProcess(): GitHubCredentials {
	return {
		appId: requiredProcessEnv('GITHUB_APP_ID'),
		privateKey: normalizePrivateKey(requiredProcessEnv('GITHUB_APP_PRIVATE_KEY')),
	};
}

export async function createInstallationClient(
	credentials: GitHubCredentials,
	installationId: number,
): Promise<InstallationClient> {
	const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
	return app.getInstallationOctokit(installationId);
}

export function requiredProcessEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required.`);
	}
	return value;
}

function normalizePrivateKey(value: string): string {
	return value.includes('\\n') ? value.replaceAll('\\n', '\n') : value;
}
