import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import { type AuthorPersonaConfig, loadFactoryConfig } from '../config.ts';
import type { WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	createScopedInstallationToken,
	credentialsFromWorkerEnv,
	type InstallationClient,
} from '../github/client.ts';
import { upsertIssueComment } from '../github/issues.ts';
import { readSkillSnapshot } from '../github/skill.ts';
import {
	handOffToHuman,
	requestReviews,
	waitForPullHead,
} from '../personas/handoff.ts';
import { formatErrorWithCauses } from '../triage/failure.ts';
import {
	commitAndPushFastForward,
	destroyTriageSandbox,
	ensureTriageWorkspace,
	getTriageSandbox,
	runCheckoutCommands,
	setupTriageWorkspace,
	workspaceHasChanges,
} from '../triage/sandbox.ts';
import {
	BUILD_TIMEOUT_SECONDS,
	INSTALL_TIMEOUT_SECONDS,
} from '../triage/sandbox-utils.ts';
import { CodeAuthor } from './agents/code-author.ts';
import {
	type AuthorStatus,
	formatAuthorHandoffComment,
	formatAuthorRoundComment,
	formatAuthorStatusComment,
	formatThreadReply,
} from './comments.ts';
import {
	type AuthorAgentInput,
	type AuthorResult,
	type AuthorState,
	type AuthorWorkflowOutcome,
	type AuthorWorkflowParams,
	authorAgentId,
	authorCoordinatorKey,
	authorSandboxId,
	authorWorkflowParamsSchema,
	createAuthorResultSchema,
	INITIAL_AUTHOR_STATE,
} from './contracts.ts';
import { defaultAuthorSkill } from './default-skill.ts';
import {
	AUTHOR_STATUS_MARKER,
	type AuthorWork,
	type CheckLogFile,
	fitAuthorWork,
	formatAuthorFeedback,
	latestAssignmentAt,
	parseAuthorState,
	reviewersToRequest,
	selectAuthorWork,
} from './feedback.ts';
import {
	findStatusComment,
	loadCheckLogTail,
	loadFailingChecks,
	loadPullRequestSnapshot,
	replyToReviewThread,
	resolveReviewThread,
	resolveWriteAccess,
	saveStatusComment,
} from './github.ts';
import { checkOwnership } from './ownership.ts';

const STEP_RETRIES = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;

/** Headroom below Workflows' 1 MiB step-result limit. */
const MAX_WORK_BYTES = 700 * 1_024;

/** Check logs live outside the checkout so they can never be committed. */
const CHECK_LOG_DIR = '/author/checks';

interface ReadyRound {
	kind: 'ready';
	author: AuthorPersonaConfig;
	/** The reviewer persona's login, asked to review again after a round. */
	reviewerLogin: string | null;
	/** Who opened the pull request; GitHub won't request their review. */
	pullAuthor: string | null;
	installCommand: string[];
	buildCommand: string[];
	/** Every piece of feedback created at or before this instant is in `work`. */
	snapshotAt: string;
	pull: { title: string; headRef: string; headSha: string; baseRef: string };
	statusCommentId: number | null;
	state: AuthorState;
	adopted: boolean;
	work: AuthorWork;
}

type LoadedRound = { kind: 'ignored'; reason: string } | ReadyRound;

/**
 * One feedback round of the code author persona on a pull request it owns.
 *
 * The workflow is state-based rather than event-based: whatever delivery
 * started it, it re-reads the pull request, decides from GitHub state and the
 * persona's recorded state whether there is new work, and if so runs one
 * round. Every side effect — status comment, push, replies, resolutions — is
 * a checkpointed step in trusted code; the agent only edits a sandboxed
 * checkout and submits a structured result.
 */
export class AuthorWorkflow extends WorkflowEntrypoint<
	WorkerEnv,
	AuthorWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<AuthorWorkflowParams>>,
		step: WorkflowStep,
	): Promise<AuthorWorkflowOutcome> {
		const params = v.parse(authorWorkflowParamsSchema, event.payload);
		const coordinator = this.env.AUTHOR_COORDINATOR.getByName(
			authorCoordinatorKey(params),
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
			'register author coordination',
			async () => params.deliveryId,
			{
				rollback: async () => {
					await completeCoordination();
				},
				rollbackConfig: STEP_RETRIES,
			},
		);
		const finish = async (
			outcome: AuthorWorkflowOutcome,
		): Promise<AuthorWorkflowOutcome> => {
			await step.do(
				'complete author coordination',
				STEP_RETRIES,
				completeCoordination,
			);
			return outcome;
		};

		const credentials = credentialsFromWorkerEnv(this.env);
		const appId = Number(this.env.GITHUB_APP_ID);
		const client = () =>
			createInstallationClient(credentials, params.installationId);
		const ref = {
			owner: params.owner,
			repo: params.repo,
			pullNumber: params.pullNumber,
		};

		const round = await step.do(
			'load pull request and feedback',
			STEP_RETRIES,
			async () => loadRound(await client(), params, appId),
		);
		if (round.kind === 'ignored') {
			return finish({ outcome: 'ignored', reason: round.reason });
		}

		const { author, work } = round;
		const saveStatus = (
			name: string,
			state: AuthorState,
			status: AuthorStatus,
		) =>
			step.do(`update author status: ${name}`, STEP_RETRIES, async () =>
				saveStatusComment(
					await client(),
					ref,
					round.statusCommentId,
					formatAuthorStatusComment({
						login: author.login,
						maxRounds: author.maxRounds,
						state,
						status,
					}),
					AUTHOR_STATUS_MARKER,
					appId,
				),
			);

		if (!work.hasNewActivity) {
			if (round.adopted) {
				// Record the adoption so the persona announces itself once and
				// later rounds only see feedback newer than this.
				await saveStatus(
					'adopted',
					{ ...round.state, lastHandledAt: round.snapshotAt },
					{ kind: 'idle' },
				);
			}
			return finish({
				outcome: 'idle',
				reason: 'No new requested changes or failing checks.',
			});
		}

		if (round.state.parked || round.state.round >= author.maxRounds) {
			// Out of budget with work still arriving: step away rather than keep
			// going. Unassigning ends ownership, so nothing proceeds until a
			// maintainer takes over or reassigns the persona for a fresh budget.
			await step.do('hand off to a human', STEP_RETRIES, async () => {
				const api = await client();
				await upsertIssueComment(
					api,
					params.owner,
					params.repo,
					params.pullNumber,
					`<!-- factory:author-handoff assigned=${round.state.assignedAt ?? 'unknown'} -->`,
					formatAuthorHandoffComment({
						login: author.login,
						maxRounds: author.maxRounds,
					}),
				);
				await handOffToHuman(api, ref, author.login);
			});
			await saveStatus(
				'handed off',
				{ ...round.state, parked: true },
				{ kind: 'handed-off' },
			);
			return finish({ outcome: 'handed-off', round: round.state.round });
		}

		const roundNumber = round.state.round + 1;
		// Counted before the attempt, so a round that keeps failing still spends
		// budget and can't retry forever.
		const attemptedState: AuthorState = { ...round.state, round: roundNumber };
		const statusCommentId = await saveStatus('working', round.state, {
			kind: 'working',
			round: roundNumber,
		});
		const saveFinalStatus = (
			name: string,
			state: AuthorState,
			status: AuthorStatus,
		) =>
			step.do(`update author status: ${name}`, STEP_RETRIES, async () =>
				saveStatusComment(
					await client(),
					ref,
					statusCommentId,
					formatAuthorStatusComment({
						login: author.login,
						maxRounds: author.maxRounds,
						state,
						status,
					}),
					AUTHOR_STATUS_MARKER,
					appId,
				),
			);

		const sandboxId = authorSandboxId(params.repositoryId, params.pullNumber);
		const sandbox = () => getTriageSandbox(this.env, sandboxId);
		let outcome: AuthorWorkflowOutcome;
		try {
			outcome = await this.runRound(
				step,
				client,
				params,
				round,
				roundNumber,
				sandboxId,
			);
		} catch (error) {
			outcome = { outcome: 'failed', reason: formatErrorWithCauses(error) };
		}
		// Destroyed before coordination completes: the next round for this pull
		// request reuses the sandbox id and must not have it torn down under it.
		await step.do(
			'destroy sandbox',
			{
				retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
				timeout: '2 minutes',
			},
			async () => {
				await destroyTriageSandbox(sandbox());
			},
		);

		if (outcome.outcome === 'failed') {
			// Feedback stays unhandled, so the next activity retries it.
			await saveFinalStatus('failed', attemptedState, {
				kind: 'failed',
				round: roundNumber,
				reason: outcome.reason,
			});
		} else {
			await saveFinalStatus(
				'finished',
				{
					...attemptedState,
					lastHandledAt: round.snapshotAt,
					lastCheckSha:
						work.failingChecks.length > 0
							? round.pull.headSha
							: round.state.lastCheckSha,
				},
				{ kind: 'idle' },
			);
		}
		return finish(outcome);
	}

	private async runRound(
		step: WorkflowStep,
		client: () => Promise<InstallationClient>,
		params: AuthorWorkflowParams,
		round: ReadyRound,
		roundNumber: number,
		sandboxId: string,
	): Promise<AuthorWorkflowOutcome> {
		const { author, work, pull } = round;
		const credentials = credentialsFromWorkerEnv(this.env);
		const sandbox = () => getTriageSandbox(this.env, sandboxId);

		const skill = await step.do(
			'resolve author skill',
			STEP_RETRIES,
			async () =>
				author.skill
					? readSkillSnapshot(
							await client(),
							params.owner,
							params.repo,
							author.skill,
							params.defaultBranch,
						)
					: defaultAuthorSkill(),
		);

		const setupWorkspace = async () => {
			const cloneToken = params.repoIsPrivate
				? await createScopedInstallationToken(
						credentials,
						params.installationId,
						{ contents: 'read' },
					)
				: undefined;
			// Cloning the pull request branch and "creating" it from itself
			// leaves the checkout on the branch at its current head.
			await setupTriageWorkspace(sandbox(), {
				owner: params.owner,
				repo: params.repo,
				defaultBranch: pull.headRef,
				fixBranch: pull.headRef,
				skill,
				cloneToken,
			});
		};

		await step.do(
			'provision sandbox workspace',
			{
				retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
				timeout: '20 minutes',
			},
			setupWorkspace,
		);
		if (round.installCommand.length > 0) {
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
						round.installCommand,
						INSTALL_TIMEOUT_SECONDS,
					);
				},
			);
		}
		if (round.buildCommand.length > 0) {
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
					if (recovered && round.installCommand.length > 0) {
						await runCheckoutCommands(
							sandbox(),
							'install',
							round.installCommand,
							INSTALL_TIMEOUT_SECONDS,
						);
					}
					await runCheckoutCommands(
						sandbox(),
						'build',
						round.buildCommand,
						BUILD_TIMEOUT_SECONDS,
					);
				},
			);
		}

		// Logs are written straight into the sandbox and never returned as a
		// step result, keeping them out of Workflow state.
		const logFiles = await step.do(
			'stage failing check logs',
			STEP_RETRIES,
			async (): Promise<CheckLogFile[]> => {
				const api = await client();
				const files: CheckLogFile[] = [];
				for (const [index, check] of work.failingChecks.entries()) {
					if (check.jobId === null) continue;
					const log = await loadCheckLogTail(api, {
						owner: params.owner,
						repo: params.repo,
						jobId: check.jobId,
					});
					if (log === null) continue;
					const path = `${CHECK_LOG_DIR}/${index + 1}.log`;
					await sandbox().mkdir(CHECK_LOG_DIR, { recursive: true });
					await sandbox().writeFile(path, log);
					files.push({ name: check.name, path });
				}
				return files;
			},
		);

		const agent = init(CodeAuthor, {
			id: authorAgentId(params.repositoryId, params.pullNumber),
		});
		const agentInput: AuthorAgentInput = {
			sandboxId,
			owner: params.owner,
			repo: params.repo,
			pullNumber: params.pullNumber,
			headRef: pull.headRef,
			baseRef: pull.baseRef,
			skillName: skill.name,
			skillDirectory: skill.directory,
			model: author.model,
			thinkingLevel: author.thinkingLevel,
			personaLogin: author.login,
		};
		const receipt = await step.do('dispatch author round', async () =>
			agent.dispatch({
				initialData: agentInput,
				idempotencyKey: params.deliveryId,
				message: {
					kind: 'signal',
					type: 'github.pull_request.feedback',
					body: formatAuthorFeedback(
						pull,
						work,
						roundNumber,
						author.maxRounds,
						logFiles,
					),
					attributes: {
						deliveryId: params.deliveryId,
						headSha: pull.headSha,
						round: String(roundNumber),
					},
				},
			}),
		);
		const threadIds = work.threads.map((thread) => thread.threadId);
		const result: AuthorResult = await step.do(
			'read author result',
			{
				retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
				timeout: '50 minutes',
			},
			async () => {
				try {
					const reply = await agent.read(receipt);
					const writes = reply.data.author;
					if (!writes?.length) {
						throw new Error(
							'The author agent finished without submitting a result.',
						);
					}
					return v.parse(createAuthorResultSchema(threadIds), writes.at(-1));
				} catch (error) {
					throw new Error(
						`Author round failed (submission ${receipt.submissionId}).\n${formatErrorWithCauses(error)}`,
						{ cause: error },
					);
				}
			},
		);

		const push = await step.do(
			'commit and push author changes',
			{
				retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
				timeout: '15 minutes',
			},
			async () => {
				await ensureRoundWorkspace(sandbox());
				// Only uncommitted edits count. The agent is told never to commit,
				// and comparing against a SHA would misread commits a maintainer
				// pushed since the snapshot as this round's work.
				const changes = await workspaceHasChanges(sandbox(), 'HEAD');
				if (!changes.dirty) {
					return { kind: 'unchanged' as const };
				}
				// The token exists only inside this step and is scoped to
				// repository contents.
				const token = await createScopedInstallationToken(
					credentials,
					params.installationId,
					{ contents: 'write' },
				);
				const pushed = await commitAndPushFastForward(sandbox(), {
					owner: params.owner,
					repo: params.repo,
					branch: pull.headRef,
					message: result.commitMessage ?? 'fix: address review feedback',
					token,
					dirty: true,
				});
				if (!pushed.pushed || !pushed.sha) {
					return { kind: 'failed' as const, detail: pushed.detail };
				}
				return {
					kind: 'pushed' as const,
					sha: pushed.sha,
					url: `https://github.com/${params.owner}/${params.repo}/commit/${pushed.sha}`,
				};
			},
		);

		// Replies describe work that only exists once it is pushed. Each reply
		// is its own step, so a retry never repeats replies already posted.
		const threadOutcome = { replies: 0, resolved: 0, declined: 0 };
		if (push.kind !== 'failed') {
			for (const reply of result.threadReplies) {
				// A declined finding stays open for the reviewer to reconsider.
				const declined = reply.declined === true;
				const resolved = await step.do(
					`reply to review thread ${reply.threadId}`,
					STEP_RETRIES,
					async () => {
						const api = await client();
						await replyToReviewThread(
							api,
							reply.threadId,
							formatThreadReply(author.login, reply.body, declined),
						);
						return reply.resolve && !declined
							? resolveReviewThread(api, reply.threadId)
							: false;
					},
				);
				threadOutcome.replies += 1;
				if (resolved) threadOutcome.resolved += 1;
				if (declined) threadOutcome.declined += 1;
			}
		}

		// Hand back to the reviewers. Requests come after the replies so the
		// reviewer sees the author's answers, including any disagreement.
		const reviewersRequested =
			push.kind === 'failed'
				? []
				: await step.do('request reviews again', STEP_RETRIES, async () => {
						const api = await client();
						const ref = {
							owner: params.owner,
							repo: params.repo,
							pullNumber: params.pullNumber,
						};
						const logins = reviewersToRequest({
							// Absent from rounds loaded before this field existed.
							changeRequests: work.changeRequests ?? [],
							pushed: push.kind === 'pushed',
							reviewerLogin: round.reviewerLogin ?? undefined,
							pullAuthor: round.pullAuthor ?? undefined,
						});
						// Request the review only once GitHub shows the pushed commit
						// as the head, so the review request names it.
						if (push.kind === 'pushed' && logins.length > 0) {
							await waitForPullHead(api, ref, push.sha);
						}
						return requestReviews(api, ref, logins);
					});

		await step.do('post author round summary', STEP_RETRIES, async () => {
			const api = await client();
			await upsertIssueComment(
				api,
				params.owner,
				params.repo,
				params.pullNumber,
				`<!-- factory:author-round delivery=${params.deliveryId} -->`,
				formatAuthorRoundComment({
					login: author.login,
					round: roundNumber,
					maxRounds: author.maxRounds,
					result,
					push,
					...threadOutcome,
					reviewersRequested,
				}),
			);
		});

		if (push.kind === 'failed') {
			throw new Error(
				`The round's changes could not be pushed: ${push.detail}`,
			);
		}
		return {
			outcome: 'handled',
			round: roundNumber,
			pushedSha: push.kind === 'pushed' ? push.sha : null,
			...threadOutcome,
		};
	}
}

/**
 * The agent's edits live only in the container; if it was replaced after the
 * agent finished, they are gone and there is nothing safe to push.
 */
async function ensureRoundWorkspace(
	sandbox: ReturnType<typeof getTriageSandbox>,
): Promise<void> {
	const checkout = await sandbox.exec('test -d /repo/.git');
	if (checkout.exitCode !== 0) {
		throw new Error(
			"The sandbox was replaced after the agent finished, discarding this round's changes.",
		);
	}
}

async function loadRound(
	api: InstallationClient,
	params: AuthorWorkflowParams,
	appId: number,
): Promise<LoadedRound> {
	const { config } = await loadFactoryConfig(
		api,
		params.owner,
		params.repo,
		params.defaultBranch,
	);
	const author = config.personas.author;
	if (!author) {
		return {
			kind: 'ignored',
			reason: 'No author persona is configured for this repository.',
		};
	}

	// Taken before reading, so feedback created while we read is newer than
	// this and belongs to the next round.
	const snapshotAt = new Date().toISOString();
	const ref = {
		owner: params.owner,
		repo: params.repo,
		pullNumber: params.pullNumber,
	};
	const snapshot = await resolveWriteAccess(
		api,
		ref,
		await loadPullRequestSnapshot(api, ref),
	);
	const ownership = checkOwnership(snapshot, author.login);
	if (ownership) return { kind: 'ignored', reason: ownership };

	const status = await findStatusComment(api, ref, AUTHOR_STATUS_MARKER, appId);
	const assignedAt = latestAssignmentAt(snapshot, author.login);
	const recorded = status ? parseAuthorState(status.body) : undefined;
	const adopted = !recorded || recorded.assignedAt !== assignedAt;
	const state: AuthorState = adopted
		? { ...INITIAL_AUTHOR_STATE, assignedAt }
		: recorded;

	const failingChecks = await loadFailingChecks(api, {
		owner: params.owner,
		repo: params.repo,
		sha: snapshot.headSha,
	});
	const work = fitAuthorWork(
		selectAuthorWork(snapshot, state, failingChecks),
		MAX_WORK_BYTES,
	);

	return {
		kind: 'ready',
		author,
		reviewerLogin: config.personas.reviewer?.login ?? null,
		pullAuthor: snapshot.author,
		installCommand: config.triage.installCommand,
		buildCommand: config.triage.buildCommand,
		snapshotAt,
		pull: {
			title: snapshot.title,
			headRef: snapshot.headRef,
			headSha: snapshot.headSha,
			baseRef: snapshot.baseRef,
		},
		statusCommentId: status?.id ?? null,
		state,
		adopted,
		work,
	};
}
