import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import { loadFactoryConfig } from '../config.ts';
import { createDiscordClient, discordNonce } from '../discord/client.ts';
import type { WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	createScopedInstallationToken,
	credentialsFromWorkerEnv,
} from '../github/client.ts';
import { readSkillSnapshot } from '../github/skill.ts';
import { formatErrorWithCauses } from '../triage/failure.ts';
import {
	destroyTriageSandbox,
	ensureTriageWorkspace,
	getTriageSandbox,
	runCheckoutCommands,
	setupTriageWorkspace,
	TRIAGE_DIR,
} from '../triage/sandbox.ts';
import {
	BUILD_TIMEOUT_SECONDS,
	INSTALL_TIMEOUT_SECONDS,
} from '../triage/sandbox-utils.ts';
import { AdvisoryTriager } from './agents/advisory-triager.ts';
import {
	type AdvisoryAgentInput,
	type AdvisoryTriageResult,
	type AdvisoryWorkflowOutcome,
	type AdvisoryWorkflowParams,
	advisoryAgentId,
	advisoryCoordinatorKey,
	advisorySandboxId,
	advisoryTriageResultSchema,
	advisoryWorkBranch,
	advisoryWorkflowParamsSchema,
} from './contracts.ts';
import { defaultAdvisorySkill } from './default-skill.ts';
import { discordDestinationFromEnv } from './discord-destination.ts';
import {
	formatAnnouncement,
	formatFailureMessage,
	formatThreadName,
	formatTriageMessages,
} from './discord-output.ts';
import {
	type AdvisorySnapshot,
	listKnownAdvisories,
	loadAdvisory,
	renderAdvisoryMarkdown,
	renderKnownAdvisories,
} from './github.ts';
import { storePrivateAdvisoryReport } from './report-store.ts';

const API_STEP = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;

/** Where the advisory files are staged, outside the checkout. */
export const ADVISORY_DIR = `${TRIAGE_DIR}/advisory`;

/** Advisory states that have already been decided; triage would be noise. */
const DECIDED_STATES = new Set(['closed', 'published', 'withdrawn']);

/**
 * Triage one privately reported security advisory.
 *
 * GitHub's API has no way to comment on an advisory, so the result goes to a
 * private Discord channel instead: an announcement when the report arrives,
 * then the verdict, assessment, draft reply to the reporter, and a fix brief
 * in a thread started from it. A maintainer reads it and decides what to post
 * on the advisory. Nothing is ever said to the reporter automatically.
 */
export class AdvisoryWorkflow extends WorkflowEntrypoint<
	WorkerEnv,
	AdvisoryWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<AdvisoryWorkflowParams>>,
		step: WorkflowStep,
	): Promise<AdvisoryWorkflowOutcome> {
		const params = v.parse(advisoryWorkflowParamsSchema, event.payload);
		const coordinator = this.env.ADVISORY_COORDINATOR.getByName(
			advisoryCoordinatorKey(params),
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
			'register advisory coordination',
			async () => params.deliveryId,
			{
				rollback: async () => {
					await completeCoordination();
				},
				rollbackConfig: API_STEP,
			},
		);
		const finish = async (
			outcome: AdvisoryWorkflowOutcome,
		): Promise<AdvisoryWorkflowOutcome> => {
			await step.do(
				'complete advisory coordination',
				API_STEP,
				completeCoordination,
			);
			return outcome;
		};

		const credentials = credentialsFromWorkerEnv(this.env);
		const client = () =>
			createInstallationClient(credentials, params.installationId);

		const loaded = await step.do(
			'load advisory and configuration',
			API_STEP,
			async () => {
				const api = await client();
				const { config } = await loadFactoryConfig(
					api,
					params.owner,
					params.repo,
					params.defaultBranch,
				);
				const advisory = await loadAdvisory(
					api,
					params.owner,
					params.repo,
					params.ghsaId,
				);
				return {
					advisories: config.advisories,
					installCommand: config.triage.installCommand,
					buildCommand: config.triage.buildCommand,
					advisory: advisory as unknown as Record<string, string>,
				};
			},
		);
		const advisory = loaded.advisory as unknown as AdvisorySnapshot;
		const { advisories } = loaded;

		if (!advisories.enabled) {
			return finish({
				outcome: 'ignored',
				reason: 'Advisory triage is disabled for this repository.',
			});
		}
		const destination = discordDestinationFromEnv(this.env);
		if (!destination) {
			console.warn(
				JSON.stringify({
					event: 'advisory_triage_unconfigured',
					deliveryId: params.deliveryId,
					ghsaId: params.ghsaId,
				}),
			);
			return finish({
				outcome: 'skipped',
				reason: 'No Discord destination is configured for advisory triage.',
			});
		}
		if (DECIDED_STATES.has(advisory.state) || advisory.withdrawnAt) {
			return finish({
				outcome: 'skipped',
				reason: `The advisory is already ${advisory.withdrawnAt ? 'withdrawn' : advisory.state}.`,
			});
		}

		const repository = `${params.owner}/${params.repo}`;
		const discord = () =>
			createDiscordClient({ botToken: destination.botToken });

		const announcement = await step.do(
			'announce advisory in Discord',
			API_STEP,
			async () => {
				const api = discord();
				const message = await api.postMessage(destination.channelId, {
					content: formatAnnouncement(repository, advisory, {
						kind: 'running',
					}),
					nonce: await discordNonce(`${params.deliveryId}:announce`),
				});
				const threadId = await api.startThread(
					destination.channelId,
					message.id,
					formatThreadName(advisory),
				);
				return { messageId: message.id, threadId };
			},
		);

		try {
			const { result, reportKey } = await this.triage(
				step,
				params,
				loaded.installCommand,
				loaded.buildCommand,
				advisories,
				advisory,
				client,
				credentials,
			);

			const messages = formatTriageMessages(advisory, result);
			await step.do('post triage summary', API_STEP, async () => {
				await discord().postMessage(announcement.threadId, {
					...messages.summary,
					nonce: await discordNonce(`${params.deliveryId}:summary`),
				});
			});
			for (const [index, content] of messages.followUps.entries()) {
				await step.do(
					`post triage follow-up ${index + 1}`,
					API_STEP,
					async () => {
						await discord().postMessage(announcement.threadId, {
							content,
							nonce: await discordNonce(
								`${params.deliveryId}:follow-up:${index}`,
							),
						});
					},
				);
			}
			await step.do('mark announcement triaged', API_STEP, async () => {
				await discord().editMessage(
					destination.channelId,
					announcement.messageId,
					formatAnnouncement(repository, advisory, {
						kind: 'triaged',
						result,
					}),
				);
			});
			return finish({ outcome: 'triaged', verdict: result.verdict, reportKey });
		} catch (error) {
			const reason = formatErrorWithCauses(error);
			await step.do('report triage failure', API_STEP, async () => {
				const api = discord();
				await api.postMessage(announcement.threadId, {
					content: formatFailureMessage(reason),
					nonce: await discordNonce(`${params.deliveryId}:failure`),
				});
				await api.editMessage(
					destination.channelId,
					announcement.messageId,
					formatAnnouncement(repository, advisory, { kind: 'failed' }),
				);
			});
			return finish({ outcome: 'failed', reason });
		}
	}

	private async triage(
		step: WorkflowStep,
		params: AdvisoryWorkflowParams,
		installCommand: string[],
		buildCommand: string[],
		advisories: {
			skill: string | undefined;
			model: string;
			thinkingLevel: AdvisoryAgentInput['thinkingLevel'];
		},
		advisory: AdvisorySnapshot,
		client: () => ReturnType<typeof createInstallationClient>,
		credentials: ReturnType<typeof credentialsFromWorkerEnv>,
	): Promise<{ result: AdvisoryTriageResult; reportKey: string }> {
		const skill = await step.do('resolve advisory skill', API_STEP, async () =>
			advisories.skill
				? readSkillSnapshot(
						await client(),
						params.owner,
						params.repo,
						advisories.skill,
						params.defaultBranch,
					)
				: defaultAdvisorySkill(),
		);

		const sandboxId = advisorySandboxId(params);
		const sandbox = () => getTriageSandbox(this.env, sandboxId);
		const setupWorkspace = async () => {
			const cloneToken = params.repoIsPrivate
				? await createScopedInstallationToken(
						credentials,
						params.installationId,
						{ contents: 'read' },
					)
				: undefined;
			await setupTriageWorkspace(sandbox(), {
				owner: params.owner,
				repo: params.repo,
				defaultBranch: params.defaultBranch,
				fixBranch: advisoryWorkBranch(params.ghsaId),
				skill,
				cloneToken,
			});
			// Fetched here rather than in an earlier step: the list can be large,
			// and step results are size-limited.
			const known = await listKnownAdvisories(
				await client(),
				params.owner,
				params.repo,
				params.ghsaId,
			);
			await sandbox().mkdir(ADVISORY_DIR, { recursive: true });
			await sandbox().writeFile(
				`${ADVISORY_DIR}/advisory.md`,
				renderAdvisoryMarkdown(advisory),
			);
			await sandbox().writeFile(
				`${ADVISORY_DIR}/advisory.json`,
				`${JSON.stringify(advisory, null, 2)}\n`,
			);
			await sandbox().writeFile(
				`${ADVISORY_DIR}/known-advisories.json`,
				renderKnownAdvisories(known),
			);
		};

		try {
			await step.do(
				'provision advisory workspace',
				{
					retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
					timeout: '20 minutes',
				},
				setupWorkspace,
			);
			if (installCommand.length > 0) {
				await step.do(
					'install workspace dependencies',
					{
						retries: { limit: 2, delay: '1 minute', backoff: 'exponential' },
						timeout: '20 minutes',
					},
					async () => {
						await ensureTriageWorkspace(sandbox(), setupWorkspace);
						await runCheckoutCommands(
							sandbox(),
							'install',
							installCommand,
							INSTALL_TIMEOUT_SECONDS,
						);
					},
				);
			}
			if (buildCommand.length > 0) {
				await step.do(
					'build workspace',
					{
						retries: { limit: 1, delay: '1 minute', backoff: 'constant' },
						timeout: '35 minutes',
					},
					async () => {
						const recovered = await ensureTriageWorkspace(
							sandbox(),
							setupWorkspace,
						);
						if (recovered && installCommand.length > 0) {
							await runCheckoutCommands(
								sandbox(),
								'install',
								installCommand,
								INSTALL_TIMEOUT_SECONDS,
							);
						}
						await runCheckoutCommands(
							sandbox(),
							'build',
							buildCommand,
							BUILD_TIMEOUT_SECONDS,
						);
					},
				);
			}

			const agent = init(AdvisoryTriager, { id: advisoryAgentId(params) });
			const agentInput: AdvisoryAgentInput = {
				sandboxId,
				owner: params.owner,
				repo: params.repo,
				ghsaId: params.ghsaId,
				defaultBranch: params.defaultBranch,
				advisoryDirectory: ADVISORY_DIR,
				skillName: skill.name,
				skillDirectory: skill.directory,
				model: advisories.model,
				thinkingLevel: advisories.thinkingLevel,
			};
			const receipt = await step.do(
				'dispatch advisory triage agent',
				async () =>
					agent.dispatch({
						initialData: agentInput,
						idempotencyKey: params.deliveryId,
						message: {
							kind: 'signal',
							type: 'github.advisory.reported',
							body: `Triage ${params.ghsaId}.`,
							attributes: {
								deliveryId: params.deliveryId,
								ghsaId: params.ghsaId,
							},
						},
					}),
				{
					rollback: async () => agent.abort(),
					rollbackConfig: API_STEP,
				},
			);
			const result = await step.do(
				'read advisory triage result',
				{
					retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
					timeout: '70 minutes',
				},
				async () => {
					try {
						const reply = await agent.read(receipt);
						const writes = reply.data.advisory;
						if (!writes?.length) {
							throw new Error(
								'The agent completed without submitting a triage.',
							);
						}
						return v.parse(
							advisoryTriageResultSchema,
							writes.at(-1),
						) as unknown as Record<string, string>;
					} catch (error) {
						throw new Error(
							`Advisory triage failed (submission ${receipt.submissionId}).\n${formatErrorWithCauses(error)}`,
							{ cause: error },
						);
					}
				},
			);
			const triage = result as unknown as AdvisoryTriageResult;

			const reportKey = await step.do(
				'store private advisory report',
				API_STEP,
				async () =>
					storePrivateAdvisoryReport(
						this.env.PRIVATE_REPORTS,
						params,
						advisory,
						triage,
					),
			);
			return { result: triage, reportKey };
		} finally {
			await step.do(
				'destroy advisory sandbox',
				{
					retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
					timeout: '2 minutes',
				},
				async () => {
					await destroyTriageSandbox(sandbox());
				},
			);
		}
	}
}
