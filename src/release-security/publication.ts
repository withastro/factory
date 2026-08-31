import type { WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
} from '../github/client.ts';
import {
	completeReleaseSecurityChecks,
	startReleaseSecurityCheck,
} from './checks.ts';
import type {
	ReleaseSecurityResult,
	ReleaseSecurityWorkflowParams,
} from './contracts.ts';
import { postSanitizedReleaseSecurityComment } from './github.ts';
import { storePrivateReleaseSecurityReport } from './report-store.ts';

export async function finalizeFailedReleaseSecurityReview(
	env: WorkerEnv,
	input: ReleaseSecurityWorkflowParams,
	result: ReleaseSecurityResult,
	knownCheckRunId?: number,
): Promise<{ reportKey: string }> {
	const client = await createInstallationClient(
		credentialsFromWorkerEnv(env),
		input.installationId,
	);
	let reportKey = '';
	try {
		reportKey = await storePrivateReleaseSecurityReport(
			env.PRIVATE_REPORTS,
			input,
			result,
		);
	} catch (error) {
		console.error(
			JSON.stringify({
				event: 'release_security_private_report_failed',
				deliveryId: input.deliveryId,
				error: errorName(error),
			}),
		);
	}
	try {
		await postSanitizedReleaseSecurityComment(
			client,
			input,
			result,
			env.GITHUB_APP_ID,
		);
	} catch (error) {
		console.error(
			JSON.stringify({
				event: 'release_security_comment_failed',
				deliveryId: input.deliveryId,
				error: errorName(error),
			}),
		);
	}
	const checkRunId =
		knownCheckRunId ?? (await startReleaseSecurityCheck(client, input));
	await completeReleaseSecurityChecks(client, input, result, [checkRunId]);
	return { reportKey };
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : 'UnknownError';
}
