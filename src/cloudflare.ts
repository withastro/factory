import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import { PullRequestReviewer } from './agents/pull-request-reviewer.ts';
import {
	reviewCoordinatorKey,
	reviewWorkflowParamsSchema,
	type ReviewWorkflowOutcome,
	type ReviewWorkflowParams,
} from './contracts/review.ts';
import type { WorkerEnv } from './env.ts';
import {
	completeReviewCheck,
	startReviewCheck,
	type ReviewCheckInput,
} from './github/checks.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
} from './github/client.ts';
import { removeTriggerLabel } from './github/labels.ts';
import { publishReview } from './github/publish.ts';
import { loadReviewSetup } from './github/repository.ts';
import { extractReviewResult } from './workflow/result.ts';

export { ReviewCoordinator } from './review-coordinator.ts';

export class ReviewWorkflow extends WorkflowEntrypoint<WorkerEnv, ReviewWorkflowParams> {
	override async run(
		event: Readonly<WorkflowEvent<ReviewWorkflowParams>>,
		step: WorkflowStep,
	): Promise<ReviewWorkflowOutcome> {
		const trigger = v.parse(reviewWorkflowParamsSchema, event.payload);
		const coordinator = this.env.REVIEW_COORDINATOR.getByName(reviewCoordinatorKey(trigger));
		const completeCoordination = async () => {
			const result = await coordinator.complete(trigger.deliveryId);
			return {
				completed: result.completed,
				...(result.nextWorkflowId ? { nextWorkflowId: result.nextWorkflowId } : {}),
			};
		};
		await step.do(
			'register review coordination',
			async () => trigger.deliveryId,
			{
				rollback: async () => {
					await completeCoordination();
				},
				rollbackConfig: {
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '5 minutes',
				},
			},
		);
		const finishCoordination = () =>
			step.do(
				'complete review coordination',
				{
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '5 minutes',
				},
				completeCoordination,
			);
		const credentials = credentialsFromWorkerEnv(this.env);
		const setup = await step.do(
			'load repository configuration and review skill',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '5 minutes',
			},
			async () => {
				const client = await createInstallationClient(credentials, trigger.installationId);
				return loadReviewSetup(client, trigger);
			},
		);

		if (setup.outcome !== 'ready') {
			await finishCoordination();
			return setup;
		}

		await step.do(
			'remove trigger label',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '5 minutes',
			},
			async () => {
				const client = await createInstallationClient(credentials, trigger.installationId);
				await removeTriggerLabel(client, {
					owner: trigger.owner,
					repo: trigger.repo,
					pullNumber: trigger.pullNumber,
					label: setup.agentInput.triggerLabel,
				});
				return setup.agentInput.triggerLabel;
			},
		);

		const checkInput: ReviewCheckInput = {
			owner: trigger.owner,
			repo: trigger.repo,
			pullNumber: trigger.pullNumber,
			headSha: trigger.headSha,
			deliveryId: trigger.deliveryId,
		};
		const completeCheck = async (checkRunId?: number) => {
			const client = await createInstallationClient(credentials, trigger.installationId);
			await completeReviewCheck(client, checkInput, checkRunId);
		};
		const checkRunId = await step.do(
			'start GitHub check run',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '5 minutes',
			},
			async () => {
				const client = await createInstallationClient(credentials, trigger.installationId);
				return startReviewCheck(client, checkInput);
			},
			{
				rollback: async ({ output }) => completeCheck(output),
				rollbackConfig: {
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '5 minutes',
				},
			},
		);
		const finishCheck = () =>
			step.do(
				'complete GitHub check run',
				{
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '5 minutes',
				},
				async () => {
					await completeCheck(checkRunId);
					return checkRunId;
				},
			);

		const agent = init(PullRequestReviewer, {
			id: [
				'review',
				trigger.repositoryId,
				trigger.pullNumber,
				trigger.headSha,
				trigger.deliveryId,
			].join(':'),
		});
		const receipt = await step.do('dispatch review agent', async () =>
			agent.dispatch({
				initialData: setup.agentInput,
				idempotencyKey: trigger.deliveryId,
				message: {
					kind: 'signal',
					type: 'github.pull_request.review-requested',
					body: 'Run the configured repository review skill for this pull request.',
					attributes: {
						deliveryId: trigger.deliveryId,
						headSha: trigger.headSha,
					},
				},
			}),
		);

		const result = await step.do(
			'read structured review result',
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '35 minutes' },
			async () => {
				const reply = await agent.read(receipt);
				return extractReviewResult(
					reply.data,
					setup.agentInput.severities,
					setup.agentInput.areas,
				);
			},
		);

		const outcome = await step.do(
			'publish GitHub review',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '5 minutes',
			},
			async () => {
				const client = await createInstallationClient(credentials, trigger.installationId);
				return publishReview(
					client,
					{
						owner: trigger.owner,
						repo: trigger.repo,
						pullNumber: trigger.pullNumber,
						headSha: trigger.headSha,
						deliveryId: trigger.deliveryId,
					},
					result,
				);
			},
		);
		await finishCheck();
		await finishCoordination();
		return outcome;
	}
}
