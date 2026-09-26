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
	type InstallationClient,
} from '../github/client.ts';
import {
	removeIssueAssignees,
	removeLabelIfPresent,
} from '../github/issues.ts';
import { handOffToHuman } from '../personas/handoff.ts';
import { PullRequestReviewer } from './agents/pull-request-reviewer.ts';
import {
	completeReviewCheck,
	type ReviewCheckInput,
	startReviewCheck,
} from './checks.ts';
import {
	type ReviewWorkflowOutcome,
	type ReviewWorkflowParams,
	reviewCoordinatorKey,
	reviewWorkflowParamsSchema,
} from './contracts.ts';
import {
	loadUnresolvedFactoryReviewThreads,
	resolveAddressedReviewThreads,
} from './follow-up.ts';
import { publishReview } from './publish.ts';
import { extractReviewResult, parseReviewResult } from './result.ts';
import { loadReviewSetup } from './setup.ts';
import { decideReviewVerdict } from './verdict.ts';

export class ReviewWorkflow extends WorkflowEntrypoint<
	WorkerEnv,
	ReviewWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<ReviewWorkflowParams>>,
		step: WorkflowStep,
	): Promise<ReviewWorkflowOutcome> {
		const trigger = v.parse(reviewWorkflowParamsSchema, event.payload);
		const coordinator = this.env.REVIEW_COORDINATOR.getByName(
			reviewCoordinatorKey(trigger),
		);
		const completeCoordination = async () => {
			const result = await coordinator.complete(trigger.deliveryId);
			return {
				completed: result.completed,
				...(result.nextWorkflowId
					? { nextWorkflowId: result.nextWorkflowId }
					: {}),
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
				const client = await createInstallationClient(
					credentials,
					trigger.installationId,
				);
				return loadReviewSetup(client, trigger);
			},
		);

		if (setup.outcome !== 'ready') {
			await finishCoordination();
			return setup;
		}

		const unresolvedReviewThreads = await step.do(
			'load unresolved threads from Factory reviews',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '5 minutes',
			},
			async () => {
				const client = await createInstallationClient(
					credentials,
					trigger.installationId,
				);
				return loadUnresolvedFactoryReviewThreads(client, {
					owner: trigger.owner,
					repo: trigger.repo,
					pullNumber: trigger.pullNumber,
				});
			},
		);
		const agentInput = { ...setup.agentInput, unresolvedReviewThreads };

		await step.do(
			'remove trigger label',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '5 minutes',
			},
			async () => {
				const client = await createInstallationClient(
					credentials,
					trigger.installationId,
				);
				// Both triggers are one-shot: the label comes off, and the persona's
				// review request or assignment is withdrawn (Factory's review is
				// published by the App, which can't satisfy a request made of the
				// persona account). Re-adding either runs another review.
				if (trigger.persona) {
					await withdrawReviewerPersona(client, trigger);
					return trigger.persona.login;
				}
				if (agentInput.triggerLabel) {
					await removeLabelIfPresent(
						client,
						trigger.owner,
						trigger.repo,
						trigger.pullNumber,
						agentInput.triggerLabel,
					);
				}
				return agentInput.triggerLabel ?? null;
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
			const client = await createInstallationClient(
				credentials,
				trigger.installationId,
			);
			await completeReviewCheck(client, checkInput, checkRunId);
		};
		const checkRunId = await step.do(
			'start GitHub check run',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '5 minutes',
			},
			async () => {
				const client = await createInstallationClient(
					credentials,
					trigger.installationId,
				);
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
				initialData: agentInput,
				idempotencyKey: trigger.deliveryId,
				message: {
					kind: 'signal',
					type: 'github.pull_request.review-requested',
					body: 'Run the resolved review skill for this pull request.',
					attributes: {
						deliveryId: trigger.deliveryId,
						headSha: trigger.headSha,
					},
				},
			}),
		);

		const persistedResult = await step.do(
			'read structured review result',
			{
				retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
				timeout: '35 minutes',
			},
			async () => {
				const reply = await agent.read(receipt);
				return extractReviewResult(
					reply.data,
					agentInput.severities,
					agentInput.areas,
					unresolvedReviewThreads.map((thread) => thread.threadId),
				);
			},
		);
		const result = parseReviewResult(
			persistedResult,
			agentInput.severities,
			agentInput.areas,
			unresolvedReviewThreads.map((thread) => thread.threadId),
		);

		// Persona reviews carry a verdict; label-triggered reviews stay plain
		// comments.
		const verdict = trigger.persona
			? decideReviewVerdict({
					findings: result.findings,
					severities: agentInput.severities,
					threads: unresolvedReviewThreads,
					addressedThreadIds: result.addressedThreadIds,
				})
			: undefined;

		const outcome = await step.do(
			'publish GitHub review',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '5 minutes',
			},
			async () => {
				const client = await createInstallationClient(
					credentials,
					trigger.installationId,
				);
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
					verdict,
				);
			},
		);
		if (
			(outcome.outcome === 'published' ||
				outcome.outcome === 'already-published') &&
			result.addressedThreadIds.length > 0
		) {
			await step.do(
				'resolve addressed Factory review threads',
				{
					retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
					timeout: '5 minutes',
				},
				async () => {
					const client = await createInstallationClient(
						credentials,
						trigger.installationId,
					);
					return resolveAddressedReviewThreads(
						client,
						{
							owner: trigger.owner,
							repo: trigger.repo,
							pullNumber: trigger.pullNumber,
							headSha: trigger.headSha,
							deliveryId: trigger.deliveryId,
						},
						unresolvedReviewThreads,
						result.addressedThreadIds,
					);
				},
			);
		}
		if (
			verdict?.kind === 'stand-still' &&
			(outcome.outcome === 'published' ||
				outcome.outcome === 'already-published')
		) {
			// The personas disagree; stop the loop so nothing proceeds until a
			// maintainer takes over.
			await step.do('hand off to a human', STEP_RETRIES, async () => {
				const client = await createInstallationClient(
					credentials,
					trigger.installationId,
				);
				const pull = await client.rest.pulls.get({
					owner: trigger.owner,
					repo: trigger.repo,
					pull_number: trigger.pullNumber,
				});
				const authorLogin = setup.authorLogin?.toLowerCase();
				const assigned = (pull.data.assignees ?? []).find(
					(user) => user.login.toLowerCase() === authorLogin,
				);
				await handOffToHuman(
					client,
					{
						owner: trigger.owner,
						repo: trigger.repo,
						pullNumber: trigger.pullNumber,
					},
					assigned?.login,
				);
			});
		}
		await finishCheck();
		await finishCoordination();
		return outcome;
	}
}

const STEP_RETRIES = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;

async function withdrawReviewerPersona(
	client: InstallationClient,
	trigger: ReviewWorkflowParams,
): Promise<void> {
	const persona = trigger.persona;
	if (!persona) return;
	if (persona.signal === 'review-requested') {
		await client.rest.pulls.removeRequestedReviewers({
			owner: trigger.owner,
			repo: trigger.repo,
			pull_number: trigger.pullNumber,
			reviewers: [persona.login],
		});
		return;
	}
	await removeIssueAssignees(
		client,
		trigger.owner,
		trigger.repo,
		trigger.pullNumber,
		[persona.login],
	);
}
