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
import { VERIFICATION_MODEL } from '../models.ts';
import type { ThinkingLevel } from '../thinking.ts';
import { MergeRiskAssessor } from './agents/merge-risk-assessor.ts';
import {
	type MergeRiskAgentInput,
	type MergeRiskWorkflowOutcome,
	type MergeRiskWorkflowParams,
	mergeRiskCoordinatorKey,
	mergeRiskResultSchema,
	mergeRiskWorkflowParamsSchema,
} from './contracts.ts';
import { publishMergeRiskComment } from './publish.ts';
import {
	loadMergeRiskCheckRuns,
	loadMergeRiskFiles,
	loadMergeRiskPullRequest,
	loadMergeRiskReviews,
} from './snapshot.ts';

const STEP_RETRIES = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;

/** A lightweight classification call, not a second code review. */
const MERGE_RISK_MODEL = VERIFICATION_MODEL;
const MERGE_RISK_THINKING_LEVEL: ThinkingLevel = 'medium';

type SnapshotResult =
	| { ready: false; reason: string }
	| {
			ready: true;
			pull: Awaited<ReturnType<typeof loadMergeRiskPullRequest>>;
			files: Awaited<ReturnType<typeof loadMergeRiskFiles>>['files'];
			filesTruncated: boolean;
			checkRuns: Awaited<ReturnType<typeof loadMergeRiskCheckRuns>>;
			reviews: Awaited<ReturnType<typeof loadMergeRiskReviews>>;
	  };

/**
 * Assess merge risk once Factory's own review check completes on a pull
 * request, and post one scored comment. Assessment-only: nothing here ever
 * approves, blocks, or merges anything.
 */
export class MergeRiskWorkflow extends WorkflowEntrypoint<
	WorkerEnv,
	MergeRiskWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<MergeRiskWorkflowParams>>,
		step: WorkflowStep,
	): Promise<MergeRiskWorkflowOutcome> {
		const params = v.parse(mergeRiskWorkflowParamsSchema, event.payload);
		const coordinator = this.env.MERGE_RISK_COORDINATOR.getByName(
			mergeRiskCoordinatorKey(params),
		);
		const completeCoordination = async () => {
			const result = await coordinator.complete(params.deliveryId);
			return {
				completed: result.completed,
				...(result.nextWorkflowId
					? { nextWorkflowId: result.nextWorkflowId }
					: {}),
			};
		};
		await step.do(
			'register merge risk coordination',
			async () => params.deliveryId,
			{
				rollback: async () => {
					await completeCoordination();
				},
				rollbackConfig: STEP_RETRIES,
			},
		);
		const finish = async (
			outcome: MergeRiskWorkflowOutcome,
		): Promise<MergeRiskWorkflowOutcome> => {
			await step.do(
				'complete merge risk coordination',
				STEP_RETRIES,
				completeCoordination,
			);
			return outcome;
		};

		const credentials = credentialsFromWorkerEnv(this.env);
		const client = () =>
			createInstallationClient(credentials, params.installationId);

		const snapshot = await step.do(
			'load pull request snapshot',
			STEP_RETRIES,
			async (): Promise<SnapshotResult> => {
				const api = await client();
				const pull = await loadMergeRiskPullRequest(
					api,
					params.owner,
					params.repo,
					params.pullNumber,
				);
				if (pull.state !== 'open') {
					return {
						ready: false,
						reason: 'The pull request is no longer open.',
					};
				}
				if (pull.headSha.toLowerCase() !== params.headSha) {
					return {
						ready: false,
						reason:
							'The pull request head changed since the review check completed.',
					};
				}
				const [{ files, truncated }, checkRuns, reviews] = await Promise.all([
					loadMergeRiskFiles(api, params.owner, params.repo, params.pullNumber),
					loadMergeRiskCheckRuns(
						api,
						params.owner,
						params.repo,
						params.headSha,
					),
					loadMergeRiskReviews(
						api,
						params.owner,
						params.repo,
						params.pullNumber,
					),
				]);
				return {
					ready: true,
					pull,
					files,
					filesTruncated: truncated,
					checkRuns,
					reviews,
				};
			},
		);

		if (!snapshot.ready) {
			return finish({ outcome: 'stale', reason: snapshot.reason });
		}

		const agentInput: MergeRiskAgentInput = {
			owner: params.owner,
			repo: params.repo,
			pullNumber: params.pullNumber,
			headSha: params.headSha,
			baseRef: snapshot.pull.baseRef,
			title: snapshot.pull.title,
			body: snapshot.pull.body,
			draft: snapshot.pull.draft,
			author: snapshot.pull.author,
			labels: snapshot.pull.labels,
			additions: snapshot.pull.additions,
			deletions: snapshot.pull.deletions,
			changedFilesCount: snapshot.pull.changedFilesCount,
			files: snapshot.files,
			filesTruncated: snapshot.filesTruncated,
			checkRuns: snapshot.checkRuns,
			reviews: snapshot.reviews,
			model: MERGE_RISK_MODEL,
			thinkingLevel: MERGE_RISK_THINKING_LEVEL,
		};

		const agent = init(MergeRiskAssessor, {
			id: [
				'merge-risk',
				params.repositoryId,
				params.pullNumber,
				params.headSha,
				params.deliveryId,
			].join(':'),
		});
		const receipt = await step.do('dispatch merge risk agent', async () =>
			agent.dispatch({
				initialData: agentInput,
				idempotencyKey: params.deliveryId,
				message: {
					kind: 'signal',
					type: 'merge-risk.assess',
					body: 'Assess this pull request and submit the merge-risk result.',
				},
			}),
		);
		const result = await step.do(
			'read merge risk assessment',
			{
				retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
				timeout: '20 minutes',
			},
			async () => {
				const reply = await agent.read(receipt);
				const writes = reply.data.assessment;
				if (!writes?.length) {
					throw new Error(
						'The merge risk agent completed without a structured assessment.',
					);
				}
				return v.parse(mergeRiskResultSchema, writes.at(-1));
			},
		);

		const published = await step.do(
			'publish merge risk comment',
			STEP_RETRIES,
			async () => {
				const api = await client();
				return publishMergeRiskComment(
					api,
					{
						owner: params.owner,
						repo: params.repo,
						pullNumber: params.pullNumber,
					},
					result,
					params.headSha,
				);
			},
		);

		return finish({
			outcome: 'posted',
			commentId: published.commentId,
			level: published.level,
		});
	}
}
