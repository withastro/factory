import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import { loadFactoryConfig } from '../config.ts';
import type { WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	createScopedInstallationToken,
	credentialsFromWorkerEnv,
} from '../github/client.ts';
import { isGitHubStatus } from '../github/content.ts';
import { createPullRequest, findOpenPullRequest } from '../github/issues.ts';
import { readSkillSnapshot } from '../github/skill.ts';
import { handOffNewPullRequest } from '../personas/handoff.ts';
import { formatErrorWithCauses } from '../triage/failure.ts';
import {
	commitAndPush,
	ensureTriageWorkspace,
	getTriageSandbox,
	REPO_DIR,
	runCheckoutCommands,
	setupTriageWorkspace,
	shellQuote,
	TRIAGE_DIR,
	workspaceHasChanges,
} from '../triage/sandbox.ts';
import {
	assertGitRef,
	BUILD_TIMEOUT_SECONDS,
	INSTALL_TIMEOUT_SECONDS,
	redactToken,
	tail,
} from '../triage/sandbox-utils.ts';
import { DiscordAssistant } from './agents/discord-assistant.ts';
import {
	createDiscordClient,
	type DiscordMessage,
	discordNonce,
} from './client.ts';
import {
	type DiscordAgentInput,
	type DiscordThreadWorkflowParams,
	discordAgentId,
	discordJobId,
	discordSandboxId,
	discordThreadUrl,
	discordThreadWorkflowParamsSchema,
	discordWorkBranch,
	type Proposal,
	type ProposalStatus,
	parseConfirmations,
	parseProposals,
	pullRequestSubmissionSchema,
	type StoredProposal,
} from './contracts.ts';
import { defaultDiscordSkill } from './default-skill.ts';
import {
	createIssue,
	findAssistantRepository,
	renderLinkedIssue,
} from './github.ts';
import {
	formatAnswer,
	formatFailure,
	formatProposalMessage,
	formatSettledProposal,
} from './messages.ts';
import { checkInMessage, type WorkStage, withHeartbeat } from './progress.ts';
import { discordAssistantSettingsFromEnv } from './settings.ts';
import { findIssueReferences, renderTranscript } from './transcript.ts';

const API_STEP = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;

/** Where files staged for the assistant live, outside the checkout. */
export const DISCORD_CONTEXT_DIR = `${TRIAGE_DIR}/discord`;

/** Pages of 100 messages read per mention, newest kept. */
const MAX_HISTORY_PAGES = 3;
/** Longest transcript handed to the assistant in one signal. */
const TRANSCRIPT_LIMIT = 150_000;

interface WorkflowContext {
	owner: string;
	repo: string;
	installationId: number;
	defaultBranch: string;
	isPrivate: boolean;
	skillDirectory: string | undefined;
	model: string;
	thinkingLevel: DiscordAgentInput['thinkingLevel'];
	installCommand: string[];
	buildCommand: string[];
	authorLogin: string | undefined;
	reviewerLogin: string | undefined;
}

export type DiscordWorkflowOutcome =
	| { outcome: 'answered'; proposals: number }
	| { outcome: 'opened'; pullNumber: number }
	| { outcome: 'skipped'; reason: string }
	| { outcome: 'failed'; reason: string };

/**
 * Run one job for a Discord thread: answer a mention, or implement and open
 * an approved pull request.
 *
 * The thread keeps one sandbox, which sleeps after an hour idle. Every job
 * checks for it first and rebuilds it (clone, install, build) when it's gone,
 * telling the thread while it does. The agent's conversation is durable, so
 * a rebuilt sandbox loses scratch files but not the discussion.
 */
export class DiscordThreadWorkflow extends WorkflowEntrypoint<
	WorkerEnv,
	DiscordThreadWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<DiscordThreadWorkflowParams>>,
		step: WorkflowStep,
	): Promise<DiscordWorkflowOutcome> {
		const params = v.parse(discordThreadWorkflowParamsSchema, event.payload);
		const coordinator = this.env.DISCORD_THREAD_COORDINATOR.getByName(
			params.threadId,
		);
		const finish = async (
			outcome: DiscordWorkflowOutcome,
		): Promise<DiscordWorkflowOutcome> => {
			await step.do('complete thread job', API_STEP, async () => {
				await coordinator.complete(params.deliveryId);
			});
			return outcome;
		};

		const settings = discordAssistantSettingsFromEnv(this.env);
		if (!settings) {
			return finish({
				outcome: 'skipped',
				reason: 'The Discord assistant is not configured.',
			});
		}
		const discord = () => createDiscordClient({ botToken: settings.botToken });
		const replyTo = mentionReplyTarget(params);
		const say = (name: string, content: string) =>
			step.do(`say: ${name}`, API_STEP, async () => {
				await discord().postMessage(params.threadId, {
					content,
					replyTo,
					nonce: await discordNonce(`${params.deliveryId}:${name}`),
				});
			});

		try {
			const context = await step.do(
				'load repository and configuration',
				API_STEP,
				async (): Promise<WorkflowContext & { enabled: boolean }> => {
					const credentials = credentialsFromWorkerEnv(this.env);
					const repository = await findAssistantRepository(
						credentials,
						settings.owner,
						settings.repo,
					);
					const api = await createInstallationClient(
						credentials,
						repository.installationId,
					);
					const { config } = await loadFactoryConfig(
						api,
						repository.owner,
						repository.repo,
						repository.defaultBranch,
					);
					return {
						enabled: config.discord.enabled,
						owner: repository.owner,
						repo: repository.repo,
						installationId: repository.installationId,
						defaultBranch: repository.defaultBranch,
						isPrivate: repository.isPrivate,
						skillDirectory: config.discord.skill,
						model: config.discord.model,
						thinkingLevel: config.discord.thinkingLevel,
						installCommand: config.triage.installCommand,
						buildCommand: config.triage.buildCommand,
						authorLogin: config.personas.author?.login,
						reviewerLogin: config.personas.reviewer?.login,
					};
				},
			);
			if (!context.enabled) {
				await say(
					'disabled',
					`The Discord assistant is turned off in ${context.owner}/${context.repo}'s factory.yml.`,
				);
				return finish({
					outcome: 'skipped',
					reason: 'disabled in factory.yml',
				});
			}

			const outcome =
				params.job.kind === 'mention'
					? await this.answerMention(step, params, context, say)
					: await this.openPullRequest(step, params, context, say);
			return finish(outcome);
		} catch (error) {
			const reason = formatErrorWithCauses(error);
			console.error(
				JSON.stringify({
					event: 'discord_job_failed',
					deliveryId: params.deliveryId,
					reason,
				}),
			);
			await step.do('report failure', API_STEP, async () => {
				await discord().postMessage(params.threadId, {
					content: formatFailure(
						params.job.kind === 'mention'
							? 'answering that'
							: 'opening the pull request',
						redactToken(reason),
					),
					replyTo,
					nonce: await discordNonce(`${params.deliveryId}:failure`),
				});
			});
			if (params.job.kind === 'pull-request') {
				await this.reopenProposal(step, params, params.job.proposalId);
			}
			return finish({ outcome: 'failed', reason });
		}
	}

	// ---------- Mentions ----------

	private async answerMention(
		step: WorkflowStep,
		params: DiscordThreadWorkflowParams,
		context: WorkflowContext,
		say: (name: string, content: string) => Promise<void>,
	): Promise<DiscordWorkflowOutcome> {
		const coordinator = this.env.DISCORD_THREAD_COORDINATOR.getByName(
			params.threadId,
		);
		const thread = await step.do('read thread', API_STEP, async () =>
			this.readThread(params, context),
		);
		const linkedIssues = await step.do(
			'record linked issues',
			API_STEP,
			async () => coordinator.addLinkedIssues(thread.issueReferences),
		);

		await this.prepareWorkspace(step, params, context, say, 'On it.');
		await this.stageLinkedIssues(step, params, context, linkedIssues);

		const agent = this.agent(params);
		const receipt = await step.do('dispatch assistant', async () =>
			agent.dispatch({
				initialData: this.agentInput(params, context),
				idempotencyKey: params.deliveryId,
				message: {
					kind: 'signal',
					type: 'discord.mention',
					body: [
						thread.firstContact
							? `You were mentioned for the first time in the Discord thread "${thread.name}". The whole thread so far:`
							: `New messages in the Discord thread "${thread.name}" since your last reply:`,
						'',
						thread.transcript || '_(no new messages)_',
						'',
						linkedIssues.length > 0
							? `Linked issues staged in ${DISCORD_CONTEXT_DIR}: ${linkedIssues.map((number) => `issue-${number}.md`).join(', ')}.`
							: 'No GitHub issues are linked in the thread.',
					].join('\n'),
					attributes: {
						threadId: params.threadId,
						mentionedBy:
							params.job.kind === 'mention' ? params.job.authorName : '',
					},
				},
			}),
		);
		const reply = await this.readReply(
			step,
			params,
			agent,
			receipt,
			'thinking',
		);

		const answer = reply.text.trim();
		const chunks = answer ? formatAnswer(answer) : [];
		for (const [index, content] of chunks.entries()) {
			await step.do(`post answer ${index + 1}`, API_STEP, async () => {
				await createDiscordClient({
					botToken: this.botToken(),
				}).postMessage(params.threadId, {
					content,
					replyTo: index === 0 ? mentionReplyTarget(params) : undefined,
					nonce: await discordNonce(`${params.deliveryId}:answer:${index}`),
				});
			});
		}

		const proposals = reply.proposals;
		for (const [index, proposal] of proposals.entries()) {
			await step.do(`post proposal ${index + 1}`, API_STEP, async () => {
				await coordinator.saveProposal(proposal);
				const message = formatProposalMessage(
					proposal,
					context.owner,
					context.repo,
					params.botUserId,
				);
				const posted = await createDiscordClient({
					botToken: this.botToken(),
				}).postMessage(params.threadId, {
					...message,
					nonce: await discordNonce(`${params.deliveryId}:proposal:${index}`),
				});
				await coordinator.attachProposalMessage(proposal.id, posted.id);
			});
		}

		for (const [index, proposalId] of reply.confirmations.entries()) {
			await this.confirmProposal(step, params, context, index, proposalId);
		}

		if (
			chunks.length === 0 &&
			proposals.length === 0 &&
			reply.confirmations.length === 0
		) {
			await say('empty', "I couldn't come up with an answer for that one.");
		}
		await step.do('advance read cursor', API_STEP, async () => {
			await coordinator.advanceCursor(thread.latestMessageId);
		});
		return { outcome: 'answered', proposals: proposals.length };
	}

	private async readThread(
		params: DiscordThreadWorkflowParams,
		context: WorkflowContext,
	): Promise<{
		name: string;
		transcript: string;
		latestMessageId: string;
		firstContact: boolean;
		issueReferences: number[];
	}> {
		const discord = createDiscordClient({ botToken: this.botToken() });
		const coordinator = this.env.DISCORD_THREAD_COORDINATOR.getByName(
			params.threadId,
		);
		const cursor = await coordinator.getCursor();
		const channel = await discord.getChannel(params.threadId);

		let messages: DiscordMessage[] = [];
		if (cursor) {
			let after = cursor;
			for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
				const batch = await discord.listMessages(params.threadId, {
					after,
					limit: 100,
				});
				messages.push(...batch);
				if (batch.length < 100) break;
				after = batch.at(-1)?.id ?? after;
			}
		} else {
			messages = await discord.listMessages(params.threadId, { limit: 100 });
			// A thread started from a channel message shares that message's id;
			// the message itself lives in the parent channel.
			if (channel.parentId && !messages.some((m) => m.id === params.threadId)) {
				try {
					messages.unshift(
						await discord.getMessage(channel.parentId, params.threadId),
					);
				} catch {
					// Forum posts and threads without a starter message.
				}
			}
		}

		const triggerId =
			params.job.kind === 'mention' ? params.job.messageId : params.threadId;
		const latestMessageId = messages.reduce(
			(latest, message) =>
				BigInt(message.id) > BigInt(latest) ? message.id : latest,
			cursor && BigInt(cursor) > BigInt(triggerId) ? cursor : triggerId,
		);
		let transcript = renderTranscript(messages, params.botUserId);
		if (transcript.length > TRANSCRIPT_LIMIT) {
			transcript = `… [earlier messages omitted]\n\n${transcript.slice(-TRANSCRIPT_LIMIT)}`;
		}
		const name = channel.name ?? 'Discord thread';
		return {
			name,
			transcript,
			latestMessageId,
			firstContact: !cursor,
			issueReferences: findIssueReferences(
				`${name}\n${transcript}`,
				context.owner,
				context.repo,
			),
		};
	}

	// ---------- Pull requests ----------

	private async openPullRequest(
		step: WorkflowStep,
		params: DiscordThreadWorkflowParams,
		context: WorkflowContext,
		say: (name: string, content: string) => Promise<void>,
	): Promise<DiscordWorkflowOutcome> {
		if (params.job.kind !== 'pull-request')
			throw new Error('Not a pull request job.');
		const job = params.job;
		const coordinator = this.env.DISCORD_THREAD_COORDINATOR.getByName(
			params.threadId,
		);
		const stored = await step.do(
			'load proposal',
			API_STEP,
			async (): Promise<StoredProposal | null> => {
				const found = await coordinator.getProposal(job.proposalId);
				return found
					? (JSON.parse(JSON.stringify(found)) as StoredProposal)
					: null;
			},
		);
		if (
			stored?.proposal.kind !== 'pull-request' ||
			stored.status.state !== 'claimed'
		) {
			return {
				outcome: 'skipped',
				reason: 'The proposal is not awaiting implementation.',
			};
		}
		const proposal = stored.proposal;
		const branch = `factory/discord-${proposal.id}`;
		assertGitRef(branch);

		const linkedIssues = await step.do(
			'record linked issues',
			API_STEP,
			async () =>
				coordinator.addLinkedIssues(
					proposal.issueNumber ? [proposal.issueNumber] : [],
				),
		);
		await this.prepareWorkspace(
			step,
			params,
			context,
			say,
			`Working on the pull request: **${proposal.title}**`,
		);
		await this.stageLinkedIssues(step, params, context, linkedIssues);
		await step.do('start pull request branch', API_STEP, async () => {
			const sandbox = this.sandbox(params);
			const result = await sandbox.exec(
				`GIT_TERMINAL_PROMPT=0 timeout 120 sh -c ${shellQuote(
					`cd ${REPO_DIR} && git checkout -f -B ${shellQuote(branch)} ${shellQuote(context.defaultBranch)} && git clean -fd`,
				)}`,
			);
			if (result.exitCode !== 0) {
				throw new Error(
					`Could not start branch ${branch}: ${tail(result.stderr || result.stdout || '')}`,
				);
			}
		});

		const agent = this.agent(params);
		const receipt = await step.do('dispatch implementation', async () =>
			agent.dispatch({
				initialData: this.agentInput(params, context),
				idempotencyKey: params.deliveryId,
				message: {
					kind: 'signal',
					type: 'discord.pull-request-approved',
					body: [
						`${job.requestedByName} confirmed your pull request proposal. Implement it now, following the skill's "Implementing an approved pull request" section, then call submit_pull_request.`,
						`The checkout is on a fresh branch \`${branch}\` from \`${context.defaultBranch}\`.`,
						'',
						`Title: ${proposal.title}`,
						proposal.issueNumber
							? `Fixes: #${proposal.issueNumber}`
							: 'Fixes: no linked issue',
						'',
						'Plan:',
						proposal.plan,
					].join('\n'),
					attributes: { threadId: params.threadId, proposalId: proposal.id },
				},
			}),
		);
		const reply = await this.readReply(
			step,
			params,
			agent,
			receipt,
			'pull-request',
		);
		const submission = reply.pullRequest;
		if (!submission) {
			await say(
				'no-pull-request',
				reply.text.trim()
					? `I didn't open the pull request. ${reply.text.trim()}`.slice(
							0,
							1_900,
						)
					: "I didn't manage to implement that, so I didn't open a pull request.",
			);
			await this.reopenProposal(step, params, proposal.id);
			return {
				outcome: 'failed',
				reason: 'The agent did not submit a pull request.',
			};
		}

		const pull = await step.do(
			'push and open pull request',
			{
				retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
				timeout: '10 minutes',
			},
			async () => {
				const sandbox = this.sandbox(params);
				const changes = await workspaceHasChanges(
					sandbox,
					context.defaultBranch,
				);
				if (!changes.diff && !changes.dirty) {
					throw new Error('The implementation left no changes to commit.');
				}
				const credentials = credentialsFromWorkerEnv(this.env);
				const token = await createScopedInstallationToken(
					credentials,
					context.installationId,
					{ contents: 'write' },
				);
				const pushed = await commitAndPush(sandbox, {
					owner: context.owner,
					repo: context.repo,
					branch,
					message: submission.commitMessage,
					token,
					dirty: changes.dirty,
				});
				if (!pushed.pushed) throw new Error(pushed.detail);

				const api = await createInstallationClient(
					credentials,
					context.installationId,
				);
				const body = [
					submission.body,
					'',
					'---',
					`Requested by ${job.requestedByName} in [Discord](${discordThreadUrl(params.guildId, params.threadId)}).`,
				].join('\n');
				try {
					return await createPullRequest(api, context.owner, context.repo, {
						head: branch,
						base: context.defaultBranch,
						title: submission.title,
						body,
					});
				} catch (error) {
					// A retry after a lost response: the pull request already exists.
					if (!isGitHubStatus(error, 422)) throw error;
					const existing = await findOpenPullRequest(
						api,
						context.owner,
						context.repo,
						branch,
					);
					if (!existing) throw error;
					return existing;
				}
			},
		);

		await step.do('hand pull request to personas', API_STEP, async () => {
			const api = await createInstallationClient(
				credentialsFromWorkerEnv(this.env),
				context.installationId,
			);
			await handOffNewPullRequest(
				api,
				{ owner: context.owner, repo: context.repo, pullNumber: pull.number },
				{
					authorLogin: context.authorLogin,
					reviewerLogin: context.reviewerLogin,
				},
			);
		});
		await step.do('settle proposal', API_STEP, async () => {
			const status = {
				state: 'done' as const,
				byName: job.requestedByName,
				url: pull.url,
				number: pull.number,
			};
			await coordinator.settleProposal(proposal.id, status);
			if (stored.messageId) {
				await createDiscordClient({ botToken: this.botToken() }).editMessage(
					params.threadId,
					stored.messageId,
					formatSettledProposal(
						proposal,
						status,
						context.owner,
						context.repo,
						params.botUserId,
					),
				);
			}
		});
		await say(
			'opened',
			`Opened ${context.owner}/${context.repo}#${pull.number}: ${pull.url}`,
		);
		return { outcome: 'opened', pullNumber: pull.number };
	}

	/** Put a pull request proposal back up for approval after a failed attempt. */
	private async reopenProposal(
		step: WorkflowStep,
		params: DiscordThreadWorkflowParams,
		proposalId: string,
	): Promise<void> {
		await step.do('reopen proposal', API_STEP, async () => {
			const coordinator = this.env.DISCORD_THREAD_COORDINATOR.getByName(
				params.threadId,
			);
			const stored = await coordinator.getProposal(proposalId);
			if (stored?.status.state !== 'claimed') return;
			await coordinator.settleProposal(proposalId, { state: 'proposed' });
			if (!stored.messageId) return;
			const settings = discordAssistantSettingsFromEnv(this.env);
			if (!settings) return;
			await createDiscordClient({ botToken: settings.botToken }).editMessage(
				params.threadId,
				stored.messageId,
				formatSettledProposal(
					stored.proposal,
					{ state: 'proposed' },
					settings.owner,
					settings.repo,
					params.botUserId,
				),
			);
		});
	}

	/**
	 * Act on a proposal the agent confirmed because the mention asked it to.
	 * The proposal must belong to this thread and still be pending; claiming
	 * it in the coordinator makes a repeated confirmation act once. An issue
	 * is filed right away; a pull request is queued as the thread's next job.
	 */
	private async confirmProposal(
		step: WorkflowStep,
		params: DiscordThreadWorkflowParams,
		context: WorkflowContext,
		index: number,
		proposalId: string,
	): Promise<void> {
		if (params.job.kind !== 'mention') return;
		const job = params.job;
		const coordinator = this.env.DISCORD_THREAD_COORDINATOR.getByName(
			params.threadId,
		);
		const discord = () => createDiscordClient({ botToken: this.botToken() });
		const post = async (name: string, content: string) =>
			discord().postMessage(params.threadId, {
				content,
				nonce: await discordNonce(
					`${params.deliveryId}:confirm:${index}:${name}`,
				),
			});
		const updateMessage = async (
			stored: StoredProposal,
			status: ProposalStatus,
		) => {
			if (!stored.messageId) return;
			await discord().editMessage(
				params.threadId,
				stored.messageId,
				formatSettledProposal(
					stored.proposal,
					status,
					context.owner,
					context.repo,
					params.botUserId,
				),
			);
		};

		await step.do(`confirm proposal ${index + 1}`, API_STEP, async () => {
			let stored = await coordinator.getProposal(proposalId);
			if (!stored) {
				await post(
					'missing',
					`I can't find a proposal \`${proposalId}\` in this thread.`,
				);
				return;
			}
			// A retry after the issue was filed: nothing left to do.
			if (
				stored.status.state === 'done' ||
				stored.status.state === 'dismissed'
			) {
				return;
			}
			if (stored.status.state === 'proposed') {
				stored = await coordinator.claimProposal(
					proposalId,
					job.authorId,
					job.authorName,
				);
				if (!stored) return;
			} else if (stored.status.byId !== job.authorId) {
				// Claimed by someone else's confirmation, which is handling it.
				return;
			}
			await updateMessage(stored, stored.status);

			const proposal = stored.proposal;
			if (proposal.kind === 'pull-request') {
				const prJob = {
					kind: 'pull-request' as const,
					proposalId,
					requestedById: job.authorId,
					requestedByName: job.authorName,
				};
				await coordinator.enqueue({
					deliveryId: discordJobId(params.threadId, prJob),
					guildId: params.guildId,
					threadId: params.threadId,
					botUserId: params.botUserId,
					job: prJob,
				});
				return;
			}

			try {
				const api = await createInstallationClient(
					credentialsFromWorkerEnv(this.env),
					context.installationId,
				);
				const issue = await createIssue(api, context.owner, context.repo, {
					title: proposal.title,
					body: `${proposal.body}\n\n---\nFiled by ${job.authorName} from a [Discord discussion](${discordThreadUrl(params.guildId, params.threadId)}).`,
				});
				const status = {
					state: 'done' as const,
					byName: job.authorName,
					url: issue.url,
					number: issue.number,
				};
				await coordinator.settleProposal(proposalId, status);
				await updateMessage(stored, status);
				await post(
					'filed',
					`Filed ${context.owner}/${context.repo}#${issue.number}: ${issue.url}`,
				);
			} catch (error) {
				await coordinator.settleProposal(proposalId, { state: 'proposed' });
				await updateMessage(stored, { state: 'proposed' });
				throw error;
			}
		});
	}

	// ---------- Workspace ----------

	/**
	 * Make sure the thread's sandbox has a checkout, rebuilding it when the
	 * container slept or was replaced. Says what's happening: a short
	 * acknowledgement when the sandbox is warm, a heads-up when it has to be
	 * rebuilt, and at most one "still waiting" note if that runs long.
	 */
	private async prepareWorkspace(
		step: WorkflowStep,
		params: DiscordThreadWorkflowParams,
		context: WorkflowContext,
		say: (name: string, content: string) => Promise<void>,
		acknowledgement: string,
	): Promise<void> {
		const warm = await step.do('check sandbox', API_STEP, async () => {
			const result = await this.sandbox(params).exec(
				`test -d ${REPO_DIR}/.git`,
			);
			return result.exitCode === 0;
		});
		if (warm) {
			await say('acknowledge', acknowledgement);
			return;
		}
		await say(
			'starting sandbox',
			`${acknowledgement} Starting up a sandbox first, which takes a few minutes.`,
		);

		const skill = await step.do(
			'resolve assistant skill',
			API_STEP,
			async () =>
				context.skillDirectory
					? readSkillSnapshot(
							await createInstallationClient(
								credentialsFromWorkerEnv(this.env),
								context.installationId,
							),
							context.owner,
							context.repo,
							context.skillDirectory,
							context.defaultBranch,
						)
					: defaultDiscordSkill(),
		);
		const setup = async () => {
			const cloneToken = context.isPrivate
				? await createScopedInstallationToken(
						credentialsFromWorkerEnv(this.env),
						context.installationId,
						{ contents: 'read' },
					)
				: undefined;
			await setupTriageWorkspace(this.sandbox(params), {
				owner: context.owner,
				repo: context.repo,
				defaultBranch: context.defaultBranch,
				fixBranch: discordWorkBranch(params.threadId),
				skill,
				cloneToken,
			});
		};

		// One "still waiting" note for the whole rebuild, from whichever stage
		// runs long first.
		let checkedIn = false;
		const heartbeat = (name: string, stage: WorkStage) => ({
			typing: () =>
				createDiscordClient({ botToken: this.botToken() }).triggerTyping(
					params.threadId,
				),
			checkIn: checkedIn
				? undefined
				: async () => {
						checkedIn = true;
						await createDiscordClient({
							botToken: this.botToken(),
						}).postMessage(params.threadId, {
							content: checkInMessage(stage),
							nonce: await discordNonce(
								`${params.deliveryId}:check-in:${name}`,
							),
						});
					},
		});

		checkedIn = await step.do(
			'provision workspace',
			{
				retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
				timeout: '20 minutes',
			},
			async () => {
				await withHeartbeat(setup, heartbeat('provision', 'sandbox'));
				return checkedIn;
			},
		);
		if (context.installCommand.length > 0) {
			checkedIn = await step.do(
				'install workspace dependencies',
				{
					retries: { limit: 2, delay: '1 minute', backoff: 'exponential' },
					timeout: '20 minutes',
				},
				async () => {
					await withHeartbeat(
						async () => {
							await ensureTriageWorkspace(this.sandbox(params), setup);
							await runCheckoutCommands(
								this.sandbox(params),
								'install',
								context.installCommand,
								INSTALL_TIMEOUT_SECONDS,
							);
						},
						heartbeat('install', 'sandbox'),
					);
					return checkedIn;
				},
			);
		}
		if (context.buildCommand.length > 0) {
			await step.do(
				'build workspace',
				{
					retries: { limit: 1, delay: '1 minute', backoff: 'constant' },
					timeout: '35 minutes',
				},
				async () => {
					await withHeartbeat(
						async () => {
							const recovered = await ensureTriageWorkspace(
								this.sandbox(params),
								setup,
							);
							if (recovered && context.installCommand.length > 0) {
								await runCheckoutCommands(
									this.sandbox(params),
									'install',
									context.installCommand,
									INSTALL_TIMEOUT_SECONDS,
								);
							}
							await runCheckoutCommands(
								this.sandbox(params),
								'build',
								context.buildCommand,
								BUILD_TIMEOUT_SECONDS,
							);
						},
						heartbeat('build', 'sandbox'),
					);
				},
			);
		}
		await say('sandbox ready', 'Sandbox is ready. Looking into it now.');
	}

	private async stageLinkedIssues(
		step: WorkflowStep,
		params: DiscordThreadWorkflowParams,
		context: WorkflowContext,
		issueNumbers: readonly number[],
	): Promise<void> {
		await step.do('stage linked issues', API_STEP, async () => {
			const sandbox = this.sandbox(params);
			await sandbox.mkdir(DISCORD_CONTEXT_DIR, { recursive: true });
			if (issueNumbers.length === 0) return;
			const api = await createInstallationClient(
				credentialsFromWorkerEnv(this.env),
				context.installationId,
			);
			for (const number of issueNumbers) {
				const markdown = await renderLinkedIssue(
					api,
					context.owner,
					context.repo,
					number,
				);
				if (markdown) {
					await sandbox.writeFile(
						`${DISCORD_CONTEXT_DIR}/issue-${number}.md`,
						markdown,
					);
				}
			}
		});
	}

	// ---------- Agent ----------

	private agent(params: DiscordThreadWorkflowParams) {
		return init(DiscordAssistant, { id: discordAgentId(params.threadId) });
	}

	private agentInput(
		params: DiscordThreadWorkflowParams,
		context: WorkflowContext,
	): DiscordAgentInput {
		const skill = context.skillDirectory ?? defaultDiscordSkill().directory;
		return {
			sandboxId: discordSandboxId(params.threadId),
			guildId: params.guildId,
			threadId: params.threadId,
			owner: context.owner,
			repo: context.repo,
			defaultBranch: context.defaultBranch,
			contextDirectory: DISCORD_CONTEXT_DIR,
			skillName: skill.split('/').at(-1) ?? 'discord-assistant',
			skillDirectory: skill,
			model: context.model,
			thinkingLevel: context.thinkingLevel,
		};
	}

	private async readReply(
		step: WorkflowStep,
		params: DiscordThreadWorkflowParams,
		agent: ReturnType<DiscordThreadWorkflow['agent']>,
		receipt: Awaited<
			ReturnType<ReturnType<DiscordThreadWorkflow['agent']>['dispatch']>
		>,
		stage: WorkStage,
	): Promise<{
		text: string;
		proposals: Proposal[];
		confirmations: string[];
		pullRequest: v.InferOutput<typeof pullRequestSubmissionSchema> | null;
	}> {
		return step.do(
			`read assistant reply`,
			{
				retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
				timeout: '70 minutes',
			},
			async () => {
				const reply = await withHeartbeat(
					async () => {
						try {
							return await agent.read(receipt);
						} catch (error) {
							throw new Error(
								`The assistant failed (submission ${receipt.submissionId}).\n${formatErrorWithCauses(error)}`,
								{ cause: error },
							);
						}
					},
					{
						typing: () =>
							createDiscordClient({ botToken: this.botToken() }).triggerTyping(
								params.threadId,
							),
						checkIn: async () => {
							await createDiscordClient({
								botToken: this.botToken(),
							}).postMessage(params.threadId, {
								content: checkInMessage(stage),
								nonce: await discordNonce(
									`${params.deliveryId}:check-in:reply`,
								),
							});
						},
						// Thinking is often quick; only check in when it's clearly long.
						checkInAfterSeconds: 180,
					},
				);
				return {
					text: reply.text,
					proposals: parseProposals(reply.data.proposal),
					confirmations: parseConfirmations(reply.data.confirm),
					pullRequest: parseLast(
						pullRequestSubmissionSchema,
						reply.data['pull-request'],
					),
				};
			},
		);
	}

	private sandbox(params: DiscordThreadWorkflowParams) {
		return getTriageSandbox(this.env, discordSandboxId(params.threadId));
	}

	private botToken(): string {
		const token = this.env.DISCORD_BOT_TOKEN?.trim();
		if (!token) throw new Error('DISCORD_BOT_TOKEN is not configured.');
		return token;
	}
}

/**
 * The mention to reply to, when it's in the thread. A thread the assistant
 * started from a channel message shares that message's id, and the message
 * itself lives in the parent channel, so it can't be replied to.
 */
function mentionReplyTarget(
	params: DiscordThreadWorkflowParams,
): string | undefined {
	if (params.job.kind !== 'mention') return undefined;
	return params.job.messageId === params.threadId
		? undefined
		: params.job.messageId;
}

function parseLast<S extends v.GenericSchema>(
	schema: S,
	writes: readonly unknown[] | undefined,
): v.InferOutput<S> | null {
	const last = writes?.at(-1);
	if (last === undefined) return null;
	const parsed = v.safeParse(schema, last);
	return parsed.success ? parsed.output : null;
}
