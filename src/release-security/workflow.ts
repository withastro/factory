import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import type { WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
} from '../github/client.ts';
import { ReleaseSecurityReviewer } from './agents/reviewer.ts';
import {
	completeReleaseSecurityChecks,
	startReleaseSecurityCheck,
} from './checks.ts';
import {
	extractReleaseSecurityResult,
	incompleteResult,
	RELEASE_SECURITY_MODEL,
	type ReleaseSecurityWorkflowOutcome,
	type ReleaseSecurityWorkflowParams,
	releaseSecurityAgentId,
	releaseSecurityCoordinatorKey,
	releaseSecuritySandboxId,
	releaseSecurityWorkflowParamsSchema,
} from './contracts.ts';
import {
	liveTargetMatches,
	loadLiveReleaseSecurityTarget,
	postSanitizedReleaseSecurityComment,
} from './github.ts';
import { storePrivateReleaseSecurityReport } from './report-store.ts';
import {
	destroyReleaseSecuritySandbox,
	getReleaseSecuritySandbox,
} from './sandbox.ts';
import { createReleaseSecurityTranscript } from './transcript.ts';
import { ensureReleaseSecurityWorkspace } from './workspace.ts';

const API_STEP = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;
export class ReleaseSecurityWorkflow extends WorkflowEntrypoint<
	WorkerEnv,
	ReleaseSecurityWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<ReleaseSecurityWorkflowParams>>,
		step: WorkflowStep,
	): Promise<ReleaseSecurityWorkflowOutcome> {
		const input = v.parse(releaseSecurityWorkflowParamsSchema, event.payload);
		const coordinator = this.env.RELEASE_SECURITY_COORDINATOR.getByName(
			releaseSecurityCoordinatorKey(input),
		);
		const credentials = credentialsFromWorkerEnv(this.env);
		const sandboxId = releaseSecuritySandboxId(input);
		const agentId = releaseSecurityAgentId(input);
		const sandbox = getReleaseSecuritySandbox(this.env, sandboxId);

		await step.do(
			'register release security coordination',
			async () => input.deliveryId,
			{
				rollback: async ({ error }) => {
					await coordinator.fail(
						input.deliveryId,
						`the durable workflow failed (${error.name})`,
					);
				},
				rollbackConfig: API_STEP,
			},
		);

		const finishCoordination = () =>
			step.do('complete release security coordination', API_STEP, async () => {
				const completion = await coordinator.complete(input.deliveryId);
				return {
					completed: completion.completed,
					...(completion.nextWorkflowId
						? { nextWorkflowId: completion.nextWorkflowId }
						: {}),
				};
			});
		const track = (stage: string, progress: Record<string, unknown> = {}) =>
			step.do(`track release security: ${stage}`, API_STEP, async () => {
				const tracked = await coordinator.track(input.deliveryId, {
					stage,
					...(progress as { checkRunId?: number; agentId?: string }),
				});
				if (!tracked)
					throw new Error('Release security attempt is no longer active.');
				return stage;
			});

		const initialTargetMatches = await step.do(
			'validate release security target',
			API_STEP,
			async () => {
				const client = await createInstallationClient(
					credentials,
					input.installationId,
				);
				return liveTargetMatches(
					input,
					await loadLiveReleaseSecurityTarget(
						client,
						input.owner,
						input.repo,
						input.pullNumber,
					),
				);
			},
		);
		if (!initialTargetMatches) {
			await finishCoordination();
			return {
				outcome: 'stale',
				reason: 'The release pull request changed before review started.',
			};
		}

		const checkRunId = await step.do(
			'start release security check',
			API_STEP,
			async () => {
				const client = await createInstallationClient(
					credentials,
					input.installationId,
				);
				return startReleaseSecurityCheck(client, input);
			},
		);
		await track('check started', { checkRunId });

		if (input.mode === 'release') {
			await step.do(
				'prepare complete release security workspace',
				{
					retries: {
						limit: 2,
						delay: '10 seconds',
						backoff: 'exponential',
					},
					timeout: '30 minutes',
				},
				async () => ensureReleaseSecurityWorkspace(this.env, sandbox, input),
				{
					rollback: async () => destroyReleaseSecuritySandbox(sandbox),
					rollbackConfig: {
						retries: { limit: 1, delay: '5 seconds' },
						timeout: '1 minute',
					},
				},
			);
			await track('workspace and trusted context prepared', { checkRunId });
		}

		const preparedTargetMatches = await step.do(
			'validate prepared release security target',
			API_STEP,
			async () => {
				const client = await createInstallationClient(
					credentials,
					input.installationId,
				);
				return liveTargetMatches(
					input,
					await loadLiveReleaseSecurityTarget(
						client,
						input.owner,
						input.repo,
						input.pullNumber,
					),
				);
			},
		);
		if (!preparedTargetMatches) {
			throw new Error('The release pull request changed during preparation.');
		}

		await track('dispatching security agent', {
			checkRunId,
			agentId,
		});
		const agent = init(ReleaseSecurityReviewer, { id: agentId });
		const receipt = await step.do(
			'dispatch release security agent',
			async () =>
				agent.dispatch({
					initialData: {
						...input,
						sandboxId,
						model: RELEASE_SECURITY_MODEL,
					},
					idempotencyKey: input.deliveryId,
					message: {
						kind: 'signal',
						type: 'github.release-security.review-requested',
						body:
							input.mode === 'release'
								? 'Run the Astro release security review.'
								: 'Run the isolated release security model health check.',
						attributes: {
							deliveryId: input.deliveryId,
							headSha: input.headSha,
						},
					},
				}),
			{
				rollback: async () => agent.abort(),
				rollbackConfig: API_STEP,
			},
		);

		await track('security agent running', { checkRunId, agentId });
		const analyzed = await step.do(
			'read release security result',
			{
				retries: {
					limit: 2,
					delay: '10 seconds',
					backoff: 'exponential',
				},
				timeout: '30 minutes',
			},
			async () => {
				const transcript = createReleaseSecurityTranscript(input, agentId);
				const reply = await agent.read(receipt, {
					onEvent: (chunk) => transcript.append(chunk),
				});
				let transcriptKey: string | undefined;
				try {
					transcriptKey = await transcript.finish(this.env.PRIVATE_REPORTS);
				} catch (error) {
					console.error(
						JSON.stringify({
							event: 'release_security_transcript_failed',
							deliveryId: input.deliveryId,
							error: error instanceof Error ? error.name : 'UnknownError',
						}),
					);
				}
				const modelResult = extractReleaseSecurityResult(
					reply.data,
					input.headSha,
				);
				const client = await createInstallationClient(
					credentials,
					input.installationId,
				);
				const targetMatches = liveTargetMatches(
					input,
					await loadLiveReleaseSecurityTarget(
						client,
						input.owner,
						input.repo,
						input.pullNumber,
					),
				);
				const result = targetMatches
					? modelResult
					: incompleteResult(
							input.headSha,
							'the release pull request changed during review',
						);
				const reportKey = await storePrivateReleaseSecurityReport(
					this.env.PRIVATE_REPORTS,
					input,
					result,
				);
				return {
					result: {
						verdict: result.verdict,
						reviewedSha: result.reviewedSha,
					},
					reportKey,
					transcriptKey,
				};
			},
		);

		await track('security analysis complete', { checkRunId, agentId });
		if (input.mode === 'release') {
			await step.do('destroy release security sandbox', async () =>
				destroyReleaseSecuritySandbox(sandbox),
			);
		}
		await step.do(
			'post sanitized release security comment',
			API_STEP,
			async () => {
				const client = await createInstallationClient(
					credentials,
					input.installationId,
				);
				await postSanitizedReleaseSecurityComment(
					client,
					input,
					analyzed.result,
					this.env.GITHUB_APP_ID,
				);
				return analyzed.result.verdict;
			},
		);
		await step.do('complete release security check', API_STEP, async () => {
			const client = await createInstallationClient(
				credentials,
				input.installationId,
			);
			await completeReleaseSecurityChecks(client, input, analyzed.result, [
				checkRunId,
			]);
			return analyzed.result.verdict;
		});
		await finishCoordination();
		return {
			outcome: 'completed',
			verdict: analyzed.result.verdict,
			reportKey: analyzed.reportKey,
			...(analyzed.transcriptKey
				? { transcriptKey: analyzed.transcriptKey }
				: {}),
		};
	}
}
