import type { WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
} from '../github/client.ts';
import type { ReleaseSecurityWorkflowParams } from './contracts.ts';
import { fetchPublishedRepositoryAdvisories } from './github.ts';
import { prepareReleaseBaselines } from './release-baselines.ts';
import {
	checkoutReleaseHead,
	cloneReleaseRepository,
	fetchReleasePullRequest,
	prepareReleaseSecurityWorkspace,
	type ReleaseSandbox,
	releaseWorkspaceMatches,
	stageReleaseSecurityContext,
} from './sandbox.ts';

export async function ensureReleaseSecurityWorkspace(
	env: WorkerEnv,
	sandbox: ReleaseSandbox,
	input: ReleaseSecurityWorkflowParams,
): Promise<{
	packageCount: number;
	advisoryCount: number;
	recovered: boolean;
}> {
	if (await releaseWorkspaceMatches(sandbox, input)) {
		return { packageCount: 0, advisoryCount: 0, recovered: false };
	}

	await prepareReleaseSecurityWorkspace(sandbox);
	await cloneReleaseRepository(sandbox, input);
	await fetchReleasePullRequest(sandbox, input);
	await checkoutReleaseHead(sandbox, input);
	const baselines = await prepareReleaseBaselines(sandbox, input);
	const client = await createInstallationClient(
		credentialsFromWorkerEnv(env),
		input.installationId,
	);
	const advisories = await fetchPublishedRepositoryAdvisories(client, input);
	await stageReleaseSecurityContext(sandbox, input, baselines, advisories);
	if (!(await releaseWorkspaceMatches(sandbox, input))) {
		throw new Error('Release security workspace verification failed.');
	}
	return {
		packageCount: baselines.packages.length,
		advisoryCount: advisories.length,
		recovered: true,
	};
}
