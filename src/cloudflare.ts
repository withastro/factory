import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import { PullRequestReviewer } from './agents/pull-request-reviewer.ts';
import {
	reviewWorkflowParamsSchema,
	type ReviewWorkflowOutcome,
	type ReviewWorkflowParams,
} from './contracts/review.ts';
import type { WorkerEnv } from './env.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
} from './github/client.ts';
import { publishReview } from './github/publish.ts';
import { loadReviewSetup } from './github/repository.ts';
import { extractReviewResult } from './workflow/result.ts';

export class ReviewWorkflow extends WorkflowEntrypoint<WorkerEnv, ReviewWorkflowParams> {
	override async run(
		event: Readonly<WorkflowEvent<ReviewWorkflowParams>>,
		step: WorkflowStep,
	): Promise<ReviewWorkflowOutcome> {
		const trigger = v.parse(reviewWorkflowParamsSchema, event.payload);
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

		if (setup.outcome !== 'ready') return setup;

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
			async () => extractReviewResult((await agent.read(receipt)).data),
		);

		return step.do(
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
						triggerLabel: setup.agentInput.triggerLabel,
					},
					result,
				);
			},
		);
	}
}
