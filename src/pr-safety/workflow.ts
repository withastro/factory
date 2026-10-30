/**
 * The PR safety review of one pull request head.
 *
 * Tier 0 (rule signals) runs while the workspace is prepared; Tier 2 (the
 * reviewer agent) always follows. The verdict goes only to private
 * destinations: R2 and, when a maintainer needs to look, Discord. GitHub
 * gets a check whose appearance doesn't depend on the verdict.
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import { discordDestinationFromEnv } from '../advisory/discord-destination.ts';
import { loadFactoryConfig } from '../config.ts';
import { createDiscordClient, discordNonce } from '../discord/client.ts';
import type { WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
} from '../github/client.ts';
import { PrSafetyReviewer } from './agents/reviewer.ts';
import { completePrSafetyCheck, startPrSafetyCheck } from './checks.ts';
import {
	extractPrSafetyResult,
	incompletePrSafetyResult,
	type PrSafetyWorkflowOutcome,
	type PrSafetyWorkflowParams,
	prSafetyAgentId,
	prSafetyCoordinatorKey,
	prSafetySandboxId,
	prSafetyWorkflowParamsSchema,
} from './contracts.ts';
import {
	formatAlert,
	formatPrivateReport,
	shouldAlert,
	storePrivatePrSafetyReport,
} from './output.ts';
import type { SignalReport } from './signals.ts';
import {
	destroyPrSafetySandbox,
	ensurePrSafetyWorkspace,
	getPrSafetySandbox,
	loadAuthorContext,
	readStagedSignals,
} from './workspace.ts';

const API_STEP = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;

export class PrSafetyWorkflow extends WorkflowEntrypoint<
	WorkerEnv,
	PrSafetyWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<PrSafetyWorkflowParams>>,
		step: WorkflowStep,
	): Promise<PrSafetyWorkflowOutcome> {
		const input = v.parse(prSafetyWorkflowParamsSchema, event.payload);
		const coordinator = this.env.PR_SAFETY_COORDINATOR.getByName(
			prSafetyCoordinatorKey(input),
		);
		const credentials = credentialsFromWorkerEnv(this.env);
		const client = () =>
			createInstallationClient(credentials, input.installationId);
		const sandboxId = prSafetySandboxId(input);
		const agentId = prSafetyAgentId(input);
		const sandbox = getPrSafetySandbox(this.env, sandboxId);

		const completeCoordination = async () => {
			const result = await coordinator.complete(input.deliveryId);
			return {
				completed: result.completed,
				...(result.nextWorkflowId
					? { nextWorkflowId: result.nextWorkflowId }
					: {}),
			};
		};
		await step.do(
			'register PR safety coordination',
			async () => input.deliveryId,
			{
				rollback: async () => {
					await completeCoordination();
				},
				rollbackConfig: API_STEP,
			},
		);
		const finish = () =>
			step.do(
				'complete PR safety coordination',
				API_STEP,
				completeCoordination,
			);
		const skip = async (reason: string): Promise<PrSafetyWorkflowOutcome> => {
			console.info(
				`[factory] PR safety for ${input.owner}/${input.repo}#${input.pullNumber} skipped: ${reason}`,
			);
			await finish();
			return { outcome: 'skipped', reason };
		};

		const setup = await step.do('load PR safety setup', API_STEP, async () => {
			const github = await client();
			const pull = await github.rest.pulls.get({
				owner: input.owner,
				repo: input.repo,
				pull_number: input.pullNumber,
			});
			const { config } = await loadFactoryConfig(
				github,
				input.owner,
				input.repo,
				input.configurationSha,
			);
			return {
				open: pull.data.state === 'open',
				current: pull.data.head.sha.toLowerCase() === input.headSha,
				enabled: config.prSafety.enabled,
				model: config.prSafety.model,
				thinkingLevel: config.prSafety.thinkingLevel,
			};
		});
		if (!setup.enabled) return skip('PR safety is not enabled.');
		if (!setup.open) return skip('The pull request is closed.');
		if (!setup.current) return skip('The pull request has a newer head.');

		const checkRunId = await step.do(
			'start PR safety check',
			API_STEP,
			async () => startPrSafetyCheck(await client(), input),
			{
				// A failed run must not leave the check spinning forever.
				rollback: async () => {
					await completePrSafetyCheck(await client(), input);
				},
				rollbackConfig: API_STEP,
			},
		);

		const workspace = await step.do(
			'prepare workspace and rule signals',
			{
				retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
				timeout: '30 minutes',
			},
			async () =>
				ensurePrSafetyWorkspace(sandbox, input, async () =>
					loadAuthorContext(await client(), input),
				),
			{
				rollback: async () => destroyPrSafetySandbox(sandbox),
				rollbackConfig: {
					retries: { limit: 1, delay: '5 seconds' },
					timeout: '1 minute',
				},
			},
		);
		if (workspace.status === 'stale') {
			await step.do('destroy stale PR safety sandbox', async () =>
				destroyPrSafetySandbox(sandbox),
			);
			await step.do('complete stale PR safety check', API_STEP, async () =>
				completePrSafetyCheck(await client(), input, checkRunId),
			);
			return skip('The pull request head moved before review.');
		}

		const agent = init(PrSafetyReviewer, { id: agentId });
		const receipt = await step.do(
			'dispatch PR safety agent',
			async () =>
				agent.dispatch({
					initialData: {
						...input,
						sandboxId,
						model: setup.model,
						thinkingLevel: setup.thinkingLevel,
					},
					idempotencyKey: input.deliveryId,
					message: {
						kind: 'signal',
						type: 'github.pr-safety.review-requested',
						body: 'Run the PR safety review.',
						attributes: {
							deliveryId: input.deliveryId,
							headSha: input.headSha,
						},
					},
				}),
			{ rollback: async () => agent.abort(), rollbackConfig: API_STEP },
		);

		const analyzed = await step.do(
			'read PR safety result',
			{
				retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
				timeout: '30 minutes',
			},
			async () => {
				let result = incompletePrSafetyResult(
					input.headSha,
					'the agent did not return',
				);
				try {
					const reply = await agent.read(receipt);
					result = extractPrSafetyResult(reply.data, input.headSha);
				} catch (error) {
					// The agent's own failure is a review outcome, not a
					// workflow failure: it must still reach maintainers.
					result = incompletePrSafetyResult(
						input.headSha,
						`the agent failed (${error instanceof Error ? error.name : 'UnknownError'})`,
					);
				}
				let signals: SignalReport | undefined;
				try {
					signals = await readStagedSignals(sandbox);
				} catch {
					signals = undefined;
				}
				const reportKey = await storePrivatePrSafetyReport(
					this.env.PRIVATE_REPORTS,
					input,
					result,
					formatPrivateReport(input, result, signals),
				);
				return { result, reportKey };
			},
		);

		await step.do('destroy PR safety sandbox', async () =>
			destroyPrSafetySandbox(sandbox),
		);

		const totals = workspace.signals.totals;
		const alert = shouldAlert(analyzed.result.verdict, totals);
		if (alert) {
			await step.do('alert maintainers in Discord', API_STEP, async () => {
				const destination = discordDestinationFromEnv(this.env);
				if (!destination) {
					console.error(
						JSON.stringify({
							event: 'pr_safety_alert_undeliverable',
							deliveryId: input.deliveryId,
							verdict: analyzed.result.verdict,
							reportKey: analyzed.reportKey,
						}),
					);
					return false;
				}
				const report = await this.env.PRIVATE_REPORTS.get(analyzed.reportKey);
				await createDiscordClient({
					botToken: destination.botToken,
				}).postMessage(destination.channelId, {
					content: formatAlert(input, analyzed.result, totals),
					nonce: await discordNonce(`${input.deliveryId}:pr-safety`),
					files: report
						? [
								{
									name: `pr-safety-${input.repo}-${input.pullNumber}.md`,
									content: await report.text(),
								},
							]
						: [],
				});
				return true;
			});
		}

		await step.do('complete PR safety check', API_STEP, async () =>
			completePrSafetyCheck(await client(), input, checkRunId),
		);
		console.info(
			JSON.stringify({
				event: 'pr_safety_completed',
				deliveryId: input.deliveryId,
				repository: `${input.owner}/${input.repo}`,
				pullNumber: input.pullNumber,
				verdict: analyzed.result.verdict,
				alerted: alert,
				signals: totals,
			}),
		);
		await finish();
		return {
			outcome: 'completed',
			verdict: analyzed.result.verdict,
			reportKey: analyzed.reportKey,
			alerted: alert,
		};
	}
}
