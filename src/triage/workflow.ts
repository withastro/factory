import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import {
	loadFactoryConfig,
	type PreviewReleaseConfig,
	type TriageConfig,
} from '../config.ts';
import type { WorkerEnv } from '../env.ts';
import { isBotAuthor } from '../github/bots.ts';
import {
	createInstallationClient,
	createScopedInstallationToken,
	credentialsFromWorkerEnv,
	type GitHubCredentials,
	type InstallationClient,
} from '../github/client.ts';
import {
	addIssueLabels,
	computePriorityLabelsToRemove,
	createPullRequest,
	deleteBranchIfPresent,
	ensureLabelExists,
	fetchIssueDetails,
	fetchRepoLabels,
	findExistingBranch,
	findOpenPullRequest,
	getBranchHeadSha,
	normalizeIssueState,
	type PullRequestRef,
	partitionClassificationLabels,
	postIssueComment,
	removeLabelIfPresent,
	replaceIssueLabels,
	saveIssueComment,
	swapIssueLabel,
	upsertIssueComment,
} from '../github/issues.ts';
import { readSkillSnapshot, type SkillSnapshot } from '../github/skill.ts';
import { FixVerifier } from './agents/fix-verifier.ts';
import { RetriageJudge } from './agents/retriage-judge.ts';
import { TriagePipeline } from './agents/triage-pipeline.ts';
import {
	type FixVerdict,
	fixBranchName,
	fixVerdictSchema,
	legacyFixBranchNames,
	retriageDecisionSchema,
	type TriageWorkflowOutcome,
	type TriageWorkflowParams,
	triageCoordinatorKey,
	triageWorkflowParamsSchema,
} from './contracts.ts';
import { defaultTriageSkill } from './default-skill.ts';
import {
	countTriageFailures,
	formatErrorWithCauses,
	formatFailureComment,
	MAX_TRIAGE_FAILURES,
} from './failure.ts';
import { route, type TriageAction } from './fsm.ts';
import {
	allTriageLabels,
	currentTriageLabel,
	labelAppearance,
} from './labels.ts';
import {
	commentResultSchema,
	diagnoseResultSchema,
	fixResultSchema,
	labelSelectionSchema,
	prContentSchema,
	reproduceResultSchema,
	type TriagePipelineInput,
	type TriagePipelineResult,
	verifyResultSchema,
} from './pipeline-contracts.ts';
import {
	dispatchPreviewRelease,
	findPreviewReleaseCheck,
	formatPreviewReleaseSection,
	parsePreviewReleasePayload,
} from './preview-release.ts';
import {
	formatTriageProgress,
	type TriageProgressState,
	triageProgressMarker,
} from './progress.ts';
import {
	commentStepPrompt,
	diagnoseStepPrompt,
	fixStepPrompt,
	labelSelectionPrompt,
	prContentPrompt,
	reproduceStepPrompt,
	verifyStepPrompt,
} from './prompts.ts';
import { resolveTriageLabel } from './resolve-label.ts';
import {
	commitAndPush,
	destroyTriageSandbox,
	ensureTriageWorkspace,
	getTriageSandbox,
	mountTriageSkill,
	runCheckoutCommands,
	setupTriageWorkspace,
	triageSandboxId,
	workspaceHasChanges,
} from './sandbox.ts';
import {
	BUILD_TIMEOUT_SECONDS,
	INSTALL_TIMEOUT_SECONDS,
} from './sandbox-utils.ts';

const STEP_RETRIES = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;

const MAX_COMMENT_BODY = 4_000;
const MAX_CONVERSATION_ENTRIES = 50;

/**
 * Preview releases are polled rather than awaited through a `workflow_run`
 * webhook: polling keeps the whole capability inside this one durable workflow
 * instance, with no cross-instance event correlation to get wrong. Sleeping
 * between polls is durable and costs no compute.
 */
const PREVIEW_POLL_ATTEMPTS = 30;
const PREVIEW_POLL_INTERVAL = '1 minute';

interface PreviewReleaseOutcome {
	available: boolean;
	/** Pre-rendered install instructions, or null when there is no preview. */
	section: string | null;
	detail: string;
}

/**
 * Splice the install instructions above the collapsible report, falling back to
 * appending when the generated comment doesn't contain one.
 */
function insertPreviewSection(comment: string, section: string | null): string {
	if (!section) return comment;
	const marker = comment.indexOf('<details>');
	if (marker === -1) return `${comment}\n\n${section}`;
	return `${comment.slice(0, marker)}${section}\n\n${comment.slice(marker)}`;
}

interface ConversationEntry {
	author: string;
	association: string;
	isBot: boolean;
	body: string;
}

/** Lean, JSON-serializable snapshot persisted as a workflow step result. */
interface RoutedIssue {
	triage: TriageConfig;
	action: TriageAction;
	issue: {
		number: number;
		title: string;
		body: string;
		state: string;
		authorLogin: string;
		authorAssociation: string;
		labels: string[];
		conversation: ConversationEntry[];
		latestNonBotComment: ConversationEntry | null;
		failureCount: number;
		currentLabel: string | null;
	};
}

type RouteResult = { kind: 'disabled' } | ({ kind: 'ready' } & RoutedIssue);

export class TriageWorkflow extends WorkflowEntrypoint<
	WorkerEnv,
	TriageWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<TriageWorkflowParams>>,
		step: WorkflowStep,
	): Promise<TriageWorkflowOutcome> {
		const params = v.parse(triageWorkflowParamsSchema, event.payload);
		const coordinator = this.env.TRIAGE_COORDINATOR.getByName(
			triageCoordinatorKey(params),
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
			'register triage coordination',
			async () => params.deliveryId,
			{
				rollback: async () => {
					await completeCoordination();
				},
				rollbackConfig: STEP_RETRIES,
			},
		);
		const finishCoordination = () =>
			step.do(
				'complete triage coordination',
				STEP_RETRIES,
				completeCoordination,
			);
		const finish = async (
			outcome: TriageWorkflowOutcome,
		): Promise<TriageWorkflowOutcome> => {
			await finishCoordination();
			return outcome;
		};

		const credentials = credentialsFromWorkerEnv(this.env);
		const client = () =>
			createInstallationClient(credentials, params.installationId);

		const routed = await step.do('load issue and route', STEP_RETRIES, () =>
			loadAndRoute(client, params),
		);

		if (routed.kind === 'disabled') {
			return finish({
				outcome: 'ignored',
				reason: 'Triage is disabled for this repository.',
			});
		}

		switch (routed.action.type) {
			case 'skip':
				return finish({ outcome: 'skipped', reason: routed.action.reason });
			case 'cleanup':
				return finish(await this.cleanup(step, client, params));
			case 'triage':
				return finish(
					await this.triage(step, client, credentials, params, routed),
				);
			case 'retriage':
				return finish(
					await this.retriage(step, client, credentials, params, routed),
				);
			case 'verify-fix':
				return finish(await this.verifyFix(step, client, params, routed));
		}
	}

	// ---------- Triage pipeline ----------

	/**
	 * Run the full sandboxed pipeline with failure bookkeeping: any unexpected
	 * error posts a marked failure comment and parks the issue in the failed
	 * label (up to MAX_TRIAGE_FAILURES attempts).
	 */
	private async triage(
		step: WorkflowStep,
		client: () => Promise<InstallationClient>,
		credentials: GitHubCredentials,
		params: TriageWorkflowParams,
		routed: RoutedIssue,
	): Promise<TriageWorkflowOutcome> {
		const { issue, triage } = routed;
		if (
			(issue.currentLabel === triage.labels.failed ||
				issue.currentLabel === triage.labels.inProgress) &&
			issue.failureCount >= MAX_TRIAGE_FAILURES
		) {
			if (issue.currentLabel === triage.labels.inProgress) {
				await step.do(
					'repair exhausted triage state',
					STEP_RETRIES,
					async () => {
						const api = await client();
						await ensureLabelExists(
							api,
							params.owner,
							params.repo,
							triage.labels.failed,
							labelAppearance(triage.labels.failed, triage.labels),
						);
						await replaceIssueLabels(
							api,
							params.owner,
							params.repo,
							params.issueNumber,
							[triage.labels.inProgress],
							triage.labels.failed,
						);
					},
				);
			}
			return {
				outcome: 'skipped',
				reason: `Maximum failed triage attempts (${MAX_TRIAGE_FAILURES}) reached.`,
			};
		}

		const progress: TriageProgressState = {
			current: 'workspace',
			includeInstall: triage.installCommand.length > 0,
			includeBuild: triage.buildCommand.length > 0,
			details: {},
			skipped: {},
		};
		const progressComment = { id: null as number | null };
		try {
			await step.do('mark triage in progress', STEP_RETRIES, async () => {
				const api = await client();
				await ensureLabelExists(
					api,
					params.owner,
					params.repo,
					triage.labels.inProgress,
					labelAppearance(triage.labels.inProgress, triage.labels),
				);
				await replaceIssueLabels(
					api,
					params.owner,
					params.repo,
					params.issueNumber,
					[issue.currentLabel],
					triage.labels.inProgress,
				);
			});
			progressComment.id = await startTriageProgress(
				step,
				client,
				params,
				progress,
			);

			return await this.runPipeline(
				step,
				client,
				credentials,
				params,
				routed,
				progress,
				progressComment,
			);
		} catch (error) {
			const message = formatErrorWithCauses(error);
			await step.do('record triage failure', STEP_RETRIES, async () => {
				const api = await client();
				const attempt = Math.min(issue.failureCount + 1, MAX_TRIAGE_FAILURES);
				await saveIssueComment(
					api,
					params.owner,
					params.repo,
					params.issueNumber,
					progressComment.id,
					triageProgressMarker(params.deliveryId),
					formatTriageProgress(
						params.deliveryId,
						{ ...progress, failed: true },
						formatFailureComment(message, attempt),
					),
				);
				await ensureLabelExists(
					api,
					params.owner,
					params.repo,
					triage.labels.failed,
					labelAppearance(triage.labels.failed, triage.labels),
				);
				await replaceIssueLabels(
					api,
					params.owner,
					params.repo,
					params.issueNumber,
					allTriageLabels(triage.labels),
					triage.labels.failed,
				);
			});
			return { outcome: 'failed', reason: message };
		}
	}

	private async runPipeline(
		step: WorkflowStep,
		client: () => Promise<InstallationClient>,
		credentials: GitHubCredentials,
		params: TriageWorkflowParams,
		routed: RoutedIssue,
		progress: TriageProgressState,
		progressComment: { id: number | null },
	): Promise<TriageWorkflowOutcome> {
		const { issue, triage } = routed;
		const branch = fixBranchName(params.issueNumber);

		const skill = await step.do(
			'resolve triage skill',
			STEP_RETRIES,
			async () => {
				if (triage.skill) {
					const api = await client();
					return readSkillSnapshot(
						api,
						params.owner,
						params.repo,
						triage.skill,
						params.defaultBranch,
					);
				}
				return defaultTriageSkill();
			},
		);
		const prWriterSkill = triage.autoPrOnFix
			? await resolvePrWriterSkill(
					step,
					client,
					params,
					triage,
					skill.directory,
				)
			: undefined;

		const sandboxId = triageSandboxId(
			params.repositoryId,
			params.issueNumber,
			params.deliveryId,
		);
		const sandbox = () => getTriageSandbox(this.env, sandboxId);
		const setupWorkspace = async () => {
			// Private repositories need an authenticated clone. Fetch a new token
			// whenever a replacement container needs its ephemeral checkout restored.
			const cloneToken = params.repoIsPrivate
				? await createScopedInstallationToken(
						credentials,
						params.installationId,
						{
							contents: 'read',
						},
					)
				: undefined;
			await setupTriageWorkspace(sandbox(), {
				owner: params.owner,
				repo: params.repo,
				defaultBranch: params.defaultBranch,
				fixBranch: branch,
				skill,
				cloneToken,
			});
		};
		const agent = init(TriagePipeline, {
			id: [
				'triage',
				params.repositoryId,
				params.issueNumber,
				params.deliveryId,
			].join(':'),
		});
		const agentInput: TriagePipelineInput = {
			sandboxId,
			owner: params.owner,
			repo: params.repo,
			issueNumber: params.issueNumber,
			issueTitle: issue.title,
			issueBody: issue.body,
			issueAuthor: issue.authorLogin || 'ghost',
			issueAuthorAssociation: issue.authorAssociation,
			conversation: issue.conversation,
			defaultBranch: params.defaultBranch,
			fixBranch: branch,
			skillName: skill.name,
			skillDirectory: skill.directory,
			model: triage.model,
		};
		const pipelineStep = <S extends v.GenericSchema>(
			name: string,
			prompt: string,
			channel: string,
			schema: S,
			readTimeout: WorkflowSleepDuration,
		): Promise<v.InferOutput<S>> =>
			runPipelineStep(
				step,
				agent,
				agentInput,
				params,
				name,
				prompt,
				channel,
				schema,
				readTimeout,
			);

		// Released as soon as the last container-backed step is done rather than
		// only on the way out, so a long external wait doesn't idle a sandbox.
		let sandboxReleased = false;
		const releaseSandbox = async () => {
			if (sandboxReleased) return;
			sandboxReleased = true;
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
		};

		try {
			await step.do(
				'provision sandbox workspace',
				{
					retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
					timeout: '20 minutes',
				},
				setupWorkspace,
			);
			progress.details.workspace = 'ready';
			progress.current = progress.includeInstall
				? 'install'
				: progress.includeBuild
					? 'build'
					: 'reproduce';
			await reportTriageProgress(
				step,
				client,
				params,
				progressComment,
				'workspace ready',
				progress,
			);

			// Install and build are separate steps, and separate from
			// provisioning, so each gets its own timeout and a failure names the
			// stage that actually broke rather than "the clone failed".
			//
			// Install is retried because it is the most network-dependent thing
			// in a run. Build is retried too, but for a different reason: not
			// because a failing build is flaky — it isn't — but because the
			// container underneath it can be.
			if (triage.installCommand.length > 0) {
				const installCommand = triage.installCommand;
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
				progress.details.install = 'complete';
				progress.current = progress.includeBuild ? 'build' : 'reproduce';
				await reportTriageProgress(
					step,
					client,
					params,
					progressComment,
					'dependencies installed',
					progress,
				);
			}

			if (triage.buildCommand.length > 0) {
				const buildCommand = triage.buildCommand;
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
						if (recovered && triage.installCommand.length > 0) {
							await runCheckoutCommands(
								sandbox(),
								'install',
								triage.installCommand,
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
				progress.details.build = 'complete';
				progress.current = 'reproduce';
				await reportTriageProgress(
					step,
					client,
					params,
					progressComment,
					'project built',
					progress,
				);
			}

			// ----- reproduce → diagnose → verify → fix -----

			const result: TriagePipelineResult = {
				completedStage: 'reproduce',
				reproducible: false,
				skipped: false,
				skippedReason: null,
				verdict: null,
				diagnosisConfidence: null,
				fixed: false,
				commitMessage: null,
			};

			const reproduce = await pipelineStep(
				'reproduce',
				reproduceStepPrompt(),
				'reproduce',
				reproduceResultSchema,
				'30 minutes',
			);
			result.reproducible = reproduce.reproducible;
			result.skipped = reproduce.skipped;
			result.skippedReason = reproduce.skippedReason;
			progress.details.reproduce = reproduce.skipped
				? `skipped${reproduce.skippedReason ? ` (${humanizeProgressValue(reproduce.skippedReason)})` : ''}`
				: reproduce.reproducible
					? 'confirmed'
					: 'not reproduced';

			if (!reproduce.skipped && reproduce.reproducible) {
				progress.current = 'diagnose';
			} else {
				const reason = reproduce.skipped
					? 'reproduction was skipped'
					: 'the issue was not reproduced';
				progress.skipped.diagnose = reason;
				progress.skipped.verify = reason;
				progress.skipped.fix = reason;
				progress.current = 'publish';
			}
			await reportTriageProgress(
				step,
				client,
				params,
				progressComment,
				'reproduction complete',
				progress,
			);

			if (!reproduce.skipped && reproduce.reproducible) {
				const diagnose = await pipelineStep(
					'diagnose',
					diagnoseStepPrompt(),
					'diagnose',
					diagnoseResultSchema,
					'25 minutes',
				);
				result.diagnosisConfidence = diagnose.confidence;
				progress.details.diagnose = diagnose.confidence
					? `${diagnose.confidence} confidence`
					: 'no confidence reported';
				progress.current = 'verify';
				await reportTriageProgress(
					step,
					client,
					params,
					progressComment,
					'diagnosis complete',
					progress,
				);

				const verify = await pipelineStep(
					'verify',
					verifyStepPrompt(),
					'verify',
					verifyResultSchema,
					'25 minutes',
				);
				result.verdict = verify.verdict;
				result.completedStage = 'verify';
				progress.details.verify = humanizeProgressValue(verify.verdict);
				if (verify.verdict === 'intended-behavior') {
					progress.skipped.fix = 'the reported behavior is intended';
					progress.current = 'publish';
				} else {
					progress.current = 'fix';
				}
				await reportTriageProgress(
					step,
					client,
					params,
					progressComment,
					'diagnosis verified',
					progress,
				);

				if (verify.verdict !== 'intended-behavior') {
					const fix = await pipelineStep(
						'fix',
						fixStepPrompt(),
						'fix',
						fixResultSchema,
						'30 minutes',
					);
					result.fixed = fix.fixed;
					result.commitMessage = fix.commitMessage;
					result.completedStage = 'fix';
					progress.details.fix = fix.fixed ? 'verified' : 'no verified fix';
					progress.current = 'publish';
					await reportTriageProgress(
						step,
						client,
						params,
						progressComment,
						'fix attempt complete',
						progress,
					);
				}
			}

			// ----- push the fix branch when the tree changed -----

			const pushed = await step.do(
				'commit and push fix branch',
				{
					retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
					timeout: '15 minutes',
				},
				async () => {
					const changes = await workspaceHasChanges(
						sandbox(),
						params.defaultBranch,
					);
					if (!changes.diff && !changes.dirty)
						return { pushed: false, detail: 'no changes' };
					// The token exists only inside this step and is scoped to
					// repository contents.
					const token = await createScopedInstallationToken(
						credentials,
						params.installationId,
						{ contents: 'write' },
					);
					return commitAndPush(sandbox(), {
						owner: params.owner,
						repo: params.repo,
						branch,
						message:
							result.commitMessage ??
							(result.fixed
								? 'fix(auto-triage): automated fix'
								: 'test(auto-triage): failing test and investigation notes'),
						token,
						dirty: changes.dirty,
					});
				},
			);

			// ----- open a PR directly when configured -----

			let pullRequest: PullRequestRef | null = null;
			if (result.fixed && pushed.pushed && triage.autoPrOnFix) {
				const existing = await step.do(
					'find existing pull request',
					STEP_RETRIES,
					async () => {
						const api = await client();
						return findOpenPullRequest(api, params.owner, params.repo, branch);
					},
				);
				if (existing) {
					pullRequest = existing;
				} else {
					if (prWriterSkill) {
						await step.do('mount PR writer skill', async () => {
							await mountTriageSkill(sandbox(), prWriterSkill);
						});
					}
					const content = await pipelineStep(
						'pr-content',
						prContentPrompt(
							params.issueNumber,
							branch,
							params.defaultBranch,
							prWriterSkill,
						),
						'pr',
						prContentSchema,
						'10 minutes',
					);
					pullRequest = await step.do(
						'create pull request',
						STEP_RETRIES,
						async () => {
							const api = await client();
							const created = await createPullRequest(
								api,
								params.owner,
								params.repo,
								{
									head: branch,
									base: params.defaultBranch,
									title: content.title,
									body: content.body,
								},
							);
							await ensureLabelExists(
								api,
								params.owner,
								params.repo,
								triage.labels.prFixVerified,
								labelAppearance(triage.labels.prFixVerified, triage.labels),
							);
							await addIssueLabels(
								api,
								params.owner,
								params.repo,
								created.number,
								[triage.labels.prFixVerified],
							);
							return created;
						},
					);
				}
			}

			// ----- comment and classification content (needs the sandbox) -----

			const repoLabels = await step.do(
				'fetch repository labels',
				STEP_RETRIES,
				async () => {
					const api = await client();
					return partitionClassificationLabels(
						await fetchRepoLabels(api, params.owner, params.repo),
					);
				},
			);

			const generated = await pipelineStep(
				'comment',
				commentStepPrompt({
					repo: `${params.owner}/${params.repo}`,
					issueNumber: params.issueNumber,
					branchName: pushed.pushed ? branch : null,
					priorityLabels: repoLabels.priorityLabels,
				}),
				'comment',
				commentResultSchema,
				'20 minutes',
			);

			let selectedPriority: string | null = null;
			const priorityLabelsToRemove: string[] = [];
			const chosenLabels: string[] = [];
			if (
				result.reproducible &&
				(repoLabels.priorityLabels.length > 0 ||
					repoLabels.packageLabels.length > 0)
			) {
				const selection = await pipelineStep(
					'label-selection',
					labelSelectionPrompt(
						repoLabels.priorityLabels,
						repoLabels.packageLabels,
					),
					'labels',
					labelSelectionSchema,
					'10 minutes',
				);
				const priorityNames = new Set(
					repoLabels.priorityLabels.map((label) => label.name),
				);
				const packageNames = new Set(
					repoLabels.packageLabels.map((label) => label.name),
				);
				selectedPriority =
					selection.priority && priorityNames.has(selection.priority)
						? selection.priority
						: null;
				chosenLabels.push(
					...(selectedPriority ? [selectedPriority] : []),
					...selection.packages
						.filter((name) => packageNames.has(name))
						.slice(0, 3),
				);
				priorityLabelsToRemove.push(
					...computePriorityLabelsToRemove(
						issue.labels,
						selectedPriority,
						repoLabels.priorityLabels,
					),
				);
			}

			// No container work left, and a preview release can sit in the
			// repository's CI for half an hour.
			await releaseSandbox();

			// ----- preview release for the reporter to test -----

			// Pointless once a pull request exists: that path is already
			// "fix verified" and a maintainer owns it from here.
			const preview =
				result.fixed && pushed.pushed && pullRequest === null
					? await this.publishPreviewRelease(
							step,
							client,
							params,
							triage,
							branch,
						)
					: { available: false, section: null, detail: 'not applicable' };

			// ----- classification labels, comment, and final state -----

			const newLabel = resolveTriageLabel(result, triage.labels, {
				previewReleaseAvailable: preview.available,
				prOpened: pullRequest !== null,
			});
			if (chosenLabels.length > 0 || priorityLabelsToRemove.length > 0) {
				await step.do('apply classification labels', STEP_RETRIES, async () => {
					const api = await client();
					for (const label of priorityLabelsToRemove) {
						await removeLabelIfPresent(
							api,
							params.owner,
							params.repo,
							params.issueNumber,
							label,
						);
					}
					await addIssueLabels(
						api,
						params.owner,
						params.repo,
						params.issueNumber,
						chosenLabels,
					);
				});
			}

			// The install instructions are spliced in here rather than generated,
			// so the comment and `newLabel` can never disagree about whether a
			// preview exists.
			let comment = insertPreviewSection(generated.comment, preview.section);
			if (pullRequest) {
				comment += `\n\nI've opened a pull request with this fix: ${pullRequest.url}`;
			}
			const completedProgress: TriageProgressState = {
				...progress,
				current: 'complete',
				details: { ...progress.details, publish: `set \`${newLabel}\`` },
			};
			await step.do(
				'publish triage result and swap state label',
				STEP_RETRIES,
				async () => {
					const api = await client();
					await saveIssueComment(
						api,
						params.owner,
						params.repo,
						params.issueNumber,
						progressComment.id,
						triageProgressMarker(params.deliveryId),
						formatTriageProgress(params.deliveryId, completedProgress, comment),
					);
					await ensureLabelExists(
						api,
						params.owner,
						params.repo,
						newLabel,
						labelAppearance(newLabel, triage.labels),
					);
					await replaceIssueLabels(
						api,
						params.owner,
						params.repo,
						params.issueNumber,
						[issue.currentLabel, triage.labels.inProgress],
						newLabel,
					);
				},
			);
			progress.current = 'complete';
			progress.details.publish = completedProgress.details.publish;

			return {
				outcome: 'triaged',
				label: newLabel,
				branchPushed: pushed.pushed,
				pullRequestUrl: pullRequest?.url ?? null,
			};
		} finally {
			await releaseSandbox();
		}
	}

	// ---------- Preview releases ----------

	/**
	 * Ask the repository's own CI to publish an installable build of the fix
	 * branch, then wait for the result.
	 *
	 * A preview release is an enhancement to a triage run that already
	 * succeeded, so every failure mode here — unconfigured, undispatchable, a
	 * failing build, a malformed report, or a timeout — degrades to "no
	 * preview" instead of failing triage. The issue then lands in `needsTriage`
	 * exactly as it does for repositories with no preview workflow at all.
	 */
	private async publishPreviewRelease(
		step: WorkflowStep,
		client: () => Promise<InstallationClient>,
		params: TriageWorkflowParams,
		triage: TriageConfig,
		branch: string,
	): Promise<PreviewReleaseOutcome> {
		const preview = triage.previewRelease;
		if (!preview)
			return { available: false, section: null, detail: 'not configured' };

		const outcome = await this.runPreviewRelease(
			step,
			client,
			params,
			preview,
			branch,
		);
		// The whole point of the feature is invisible in the issue timeline when
		// it doesn't work out, so leave a breadcrumb.
		console.log(
			JSON.stringify({
				event: 'preview_release',
				repo: `${params.owner}/${params.repo}`,
				issue: params.issueNumber,
				branch,
				available: outcome.available,
				detail: outcome.detail,
			}),
		);
		return outcome;
	}

	private async runPreviewRelease(
		step: WorkflowStep,
		client: () => Promise<InstallationClient>,
		params: TriageWorkflowParams,
		preview: PreviewReleaseConfig,
		branch: string,
	): Promise<PreviewReleaseOutcome> {
		try {
			// Results are reported against the exact commit that was pushed, so
			// a later push can never be mistaken for this run's preview.
			const headSha = await step.do(
				'resolve fix branch head',
				STEP_RETRIES,
				async () => {
					const api = await client();
					return getBranchHeadSha(api, params.owner, params.repo, branch);
				},
			);
			if (!headSha) {
				return {
					available: false,
					section: null,
					detail: 'the fix branch has no head commit',
				};
			}

			const dispatch = await step.do(
				'dispatch preview release',
				STEP_RETRIES,
				async () => {
					const api = await client();
					return dispatchPreviewRelease(api, {
						owner: params.owner,
						repo: params.repo,
						workflow: preview.workflow,
						// The workflow definition comes from maintainer-controlled
						// content; only the branch to build is agent-authored.
						ref: params.defaultBranch,
						branch,
						issueNumber: params.issueNumber,
					});
				},
			);
			if (!dispatch.dispatched) {
				return { available: false, section: null, detail: dispatch.detail };
			}

			for (let attempt = 1; attempt <= PREVIEW_POLL_ATTEMPTS; attempt += 1) {
				await step.sleep(
					`await preview release ${attempt}`,
					PREVIEW_POLL_INTERVAL,
				);
				const check = await step.do(
					`read preview release check ${attempt}`,
					STEP_RETRIES,
					async () => {
						const api = await client();
						return findPreviewReleaseCheck(
							api,
							params.owner,
							params.repo,
							headSha,
							{
								checkName: preview.checkName,
								appSlug: preview.checkApp,
							},
						);
					},
				);

				if (check?.status !== 'completed') continue;
				if (check.conclusion !== 'success') {
					return {
						available: false,
						section: null,
						detail: `the preview release ${check.conclusion ?? 'did not succeed'}`,
					};
				}

				const packages = parsePreviewReleasePayload(
					check.summary,
					preview.allowedHosts,
				);
				if (packages.length === 0) {
					return {
						available: false,
						section: null,
						detail: 'the preview release reported no usable packages',
					};
				}
				return {
					available: true,
					section: formatPreviewReleaseSection(packages),
					detail: `published ${packages.length} package(s)`,
				};
			}

			return {
				available: false,
				section: null,
				detail: 'the preview release timed out',
			};
		} catch (error) {
			return {
				available: false,
				section: null,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	// ---------- Other handlers ----------

	private async cleanup(
		step: WorkflowStep,
		client: () => Promise<InstallationClient>,
		params: TriageWorkflowParams,
	): Promise<TriageWorkflowOutcome> {
		const deletedBranch = await step.do(
			'delete fix branch',
			STEP_RETRIES,
			async () => {
				const api = await client();
				for (const branch of [
					fixBranchName(params.issueNumber),
					...legacyFixBranchNames(params.issueNumber),
				]) {
					if (
						await deleteBranchIfPresent(api, params.owner, params.repo, branch)
					) {
						return branch;
					}
				}
				return null;
			},
		);
		return { outcome: 'cleaned-up', deletedBranch };
	}

	private async retriage(
		step: WorkflowStep,
		client: () => Promise<InstallationClient>,
		credentials: GitHubCredentials,
		params: TriageWorkflowParams,
		routed: RoutedIssue,
	): Promise<TriageWorkflowOutcome> {
		const { issue, triage } = routed;
		if (
			issue.currentLabel === triage.labels.failed &&
			issue.failureCount >= MAX_TRIAGE_FAILURES
		) {
			return {
				outcome: 'skipped',
				reason: `Maximum failed triage attempts (${MAX_TRIAGE_FAILURES}) reached.`,
			};
		}

		const agent = init(RetriageJudge, {
			id: [
				'retriage',
				params.repositoryId,
				params.issueNumber,
				params.deliveryId,
			].join(':'),
		});
		const receipt = await step.do('dispatch retriage judge', async () =>
			agent.dispatch({
				initialData: {
					owner: params.owner,
					repo: params.repo,
					issueNumber: params.issueNumber,
					issueTitle: issue.title,
					issueBody: issue.body,
					conversation: issue.conversation,
					model: triage.verificationModel,
				},
				idempotencyKey: params.deliveryId,
				message: {
					kind: 'signal',
					type: 'github.issue.retriage-requested',
					body: 'Decide whether this issue should be re-triaged.',
					attributes: { deliveryId: params.deliveryId },
				},
			}),
		);
		const decision = await step.do(
			'read retriage decision',
			{
				retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
				timeout: '15 minutes',
			},
			async () => {
				const reply = await agent.read(receipt);
				return extractLastWrite('decision', reply.data, retriageDecisionSchema);
			},
		);

		if (!decision.retriage) {
			return { outcome: 'no-retriage', reason: decision.reasoning };
		}

		await step.do('swap label to needs-triage', STEP_RETRIES, async () => {
			const api = await client();
			await ensureLabelExists(
				api,
				params.owner,
				params.repo,
				triage.labels.needsTriage,
				labelAppearance(triage.labels.needsTriage, triage.labels),
			);
			await swapIssueLabel(
				api,
				params.owner,
				params.repo,
				params.issueNumber,
				issue.currentLabel,
				triage.labels.needsTriage,
			);
		});

		// New actionable information — run the full pipeline from the staging label.
		return this.triage(step, client, credentials, params, {
			...routed,
			issue: { ...issue, currentLabel: triage.labels.needsTriage },
		});
	}

	private async verifyFix(
		step: WorkflowStep,
		client: () => Promise<InstallationClient>,
		params: TriageWorkflowParams,
		routed: RoutedIssue,
	): Promise<TriageWorkflowOutcome> {
		const { issue, triage } = routed;

		const branch = await step.do('find fix branch', STEP_RETRIES, async () => {
			const api = await client();
			return findExistingBranch(api, params.owner, params.repo, [
				fixBranchName(params.issueNumber),
				...legacyFixBranchNames(params.issueNumber),
			]);
		});
		if (!branch) {
			return {
				outcome: 'skipped',
				reason: `No fix branch found for issue #${params.issueNumber}.`,
			};
		}
		if (!issue.latestNonBotComment) {
			return {
				outcome: 'skipped',
				reason: 'No non-bot comment found to classify.',
			};
		}
		const prWriterSkill = await resolvePrWriterSkill(
			step,
			client,
			params,
			triage,
		);

		const agent = init(FixVerifier, {
			id: [
				'fix-verify',
				params.repositoryId,
				params.issueNumber,
				params.deliveryId,
			].join(':'),
		});
		const receipt = await step.do('dispatch fix verifier', async () =>
			agent.dispatch({
				initialData: {
					owner: params.owner,
					repo: params.repo,
					issueNumber: params.issueNumber,
					issueTitle: issue.title,
					issueBody: issue.body,
					branch,
					defaultBranch: params.defaultBranch,
					conversation: issue.conversation.slice(-10),
					latestComment: issue.latestNonBotComment,
					prWriterSkill,
					model: triage.verificationModel,
				},
				idempotencyKey: params.deliveryId,
				message: {
					kind: 'signal',
					type: 'github.issue.fix-verification-requested',
					body: 'Classify whether the latest comment confirms the candidate fix.',
					attributes: { deliveryId: params.deliveryId },
				},
			}),
		);
		const verdict = await step.do(
			'read fix verdict',
			{
				retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
				timeout: '15 minutes',
			},
			async () => {
				const reply = await agent.read(receipt);
				return extractLastWrite('verdict', reply.data, fixVerdictSchema);
			},
		);

		if (verdict.status === 'inconclusive') {
			return { outcome: 'fix-inconclusive', reason: verdict.reasoning };
		}

		if (verdict.status === 'rejected') {
			await step.do('mark fix rejected', STEP_RETRIES, async () => {
				const api = await client();
				await ensureLabelExists(
					api,
					params.owner,
					params.repo,
					triage.labels.fixRejected,
					labelAppearance(triage.labels.fixRejected, triage.labels),
				);
				await swapIssueLabel(
					api,
					params.owner,
					params.repo,
					params.issueNumber,
					triage.labels.fixPending,
					triage.labels.fixRejected,
				);
			});
			return { outcome: 'fix-rejected' };
		}

		const pullRequest = await step.do(
			'open or find pull request',
			STEP_RETRIES,
			async () => {
				const api = await client();
				const existing = await findOpenPullRequest(
					api,
					params.owner,
					params.repo,
					branch,
				);
				if (existing) return { ...existing, created: false };
				const created = await openFixPullRequest(
					api,
					params,
					triage,
					branch,
					verdict,
				);
				return { ...created, created: true };
			},
		);

		await step.do('mark fix verified', STEP_RETRIES, async () => {
			const api = await client();
			await ensureLabelExists(
				api,
				params.owner,
				params.repo,
				triage.labels.fixVerified,
				labelAppearance(triage.labels.fixVerified, triage.labels),
			);
			await swapIssueLabel(
				api,
				params.owner,
				params.repo,
				params.issueNumber,
				triage.labels.fixPending,
				triage.labels.fixVerified,
			);
			await postIssueComment(
				api,
				params.owner,
				params.repo,
				params.issueNumber,
				pullRequest.created
					? `The fix has been verified! A pull request has been created: ${pullRequest.url}`
					: `The fix has been verified! A pull request already exists: ${pullRequest.url}`,
			);
		});

		return { outcome: 'fix-verified', pullRequestUrl: pullRequest.url };
	}
}

// ---------- Helpers ----------

async function startTriageProgress(
	step: WorkflowStep,
	client: () => Promise<InstallationClient>,
	params: TriageWorkflowParams,
	progress: TriageProgressState,
): Promise<number | null> {
	const body = formatTriageProgress(params.deliveryId, progress);
	return step.do('report triage progress: started', async () => {
		try {
			const api = await client();
			return await upsertIssueComment(
				api,
				params.owner,
				params.repo,
				params.issueNumber,
				triageProgressMarker(params.deliveryId),
				body,
			);
		} catch (error) {
			logProgressError(params, error);
			return null;
		}
	});
}

async function reportTriageProgress(
	step: WorkflowStep,
	client: () => Promise<InstallationClient>,
	params: TriageWorkflowParams,
	comment: { id: number | null },
	name: string,
	progress: TriageProgressState,
): Promise<void> {
	if (comment.id === null) return;
	const commentId = comment.id;
	const body = formatTriageProgress(params.deliveryId, progress);
	comment.id = await step.do(`report triage progress: ${name}`, async () => {
		try {
			const api = await client();
			return await saveIssueComment(
				api,
				params.owner,
				params.repo,
				params.issueNumber,
				commentId,
				triageProgressMarker(params.deliveryId),
				body,
			);
		} catch (error) {
			logProgressError(params, error);
			return commentId;
		}
	});
}

function logProgressError(params: TriageWorkflowParams, error: unknown): void {
	// Progress is useful status, not a reason to discard completed triage work.
	// Final publication remains required and retried by its enclosing step.
	console.warn(
		JSON.stringify({
			message: 'failed to update triage progress comment',
			owner: params.owner,
			repo: params.repo,
			issueNumber: params.issueNumber,
			error: error instanceof Error ? error.message : String(error),
		}),
	);
}

function humanizeProgressValue(value: string): string {
	return value.replaceAll('-', ' ');
}

async function loadAndRoute(
	client: () => Promise<InstallationClient>,
	params: TriageWorkflowParams,
): Promise<RouteResult> {
	const api = await client();
	const { config } = await loadFactoryConfig(
		api,
		params.owner,
		params.repo,
		params.defaultBranch,
	);
	if (!config.triage.enabled) return { kind: 'disabled' };

	const details = await fetchIssueDetails(
		api,
		params.owner,
		params.repo,
		params.issueNumber,
	);
	const action =
		params.issueAction === 'comment' && isBotAuthor(params.commentAuthor)
			? {
					type: 'skip' as const,
					reason: `Comment from bot (${params.commentAuthor}).`,
				}
			: route(
					{
						action: params.issueAction,
						// Read from the issue rather than inferred from the action: the
						// delivery only says what happened, and the issue may have moved on
						// while the delivery waited its turn in the per-issue queue.
						issueState: normalizeIssueState(details.state),
						issueLabels: details.labels,
					},
					config.triage.labels,
				);

	const conversation = details.comments
		.slice(-MAX_CONVERSATION_ENTRIES)
		.map((comment) => ({
			author: comment.author.login,
			association: comment.authorAssociation,
			isBot: comment.authorIsBot,
			body: comment.body.slice(0, MAX_COMMENT_BODY),
		}));
	const latestNonBot =
		[...conversation].reverse().find((comment) => !comment.isBot) ?? null;

	return {
		kind: 'ready',
		triage: config.triage,
		action,
		issue: {
			number: details.number,
			title: details.title,
			body: details.body.slice(0, 20_000),
			state: details.state,
			authorLogin: details.author.login,
			authorAssociation: details.authorAssociation,
			labels: details.labels,
			conversation,
			latestNonBotComment: latestNonBot,
			failureCount: countTriageFailures(details),
			currentLabel: currentTriageLabel(details.labels, config.triage.labels),
		},
	};
}

type PipelineAgentHandle = ReturnType<typeof initPipelineAgentType>;
// Never called; exists to capture the handle type returned by init().
function initPipelineAgentType() {
	return init(TriagePipeline, { id: 'type-only' });
}

async function runPipelineStep<S extends v.GenericSchema>(
	step: WorkflowStep,
	agent: PipelineAgentHandle,
	agentInput: TriagePipelineInput,
	params: TriageWorkflowParams,
	name: string,
	prompt: string,
	channel: string,
	schema: S,
	readTimeout: WorkflowSleepDuration,
): Promise<v.InferOutput<S>> {
	const receipt = await step.do(`dispatch pipeline step: ${name}`, async () =>
		agent.dispatch({
			initialData: agentInput,
			idempotencyKey: `${params.deliveryId}:${name}`,
			message: {
				kind: 'signal',
				type: 'triage.pipeline-step',
				body: prompt,
				attributes: { deliveryId: params.deliveryId, step: name },
			},
		}),
	);
	const value = await step.do(
		`read pipeline step: ${name}`,
		{
			retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
			timeout: readTimeout,
		},
		async () => {
			try {
				const reply = await agent.read(receipt);
				// Step results must be JSON-serializable; every pipeline schema is a
				// plain object, so the cast is safe.
				return extractLastWrite(
					channel,
					reply.data,
					schema,
				) as unknown as Record<string, string>;
			} catch (error) {
				// Preserve Flue's settlement cause in the message before Workflows
				// serializes the failed attempt and drops Error.cause.
				throw new Error(
					`Pipeline stage "${name}" failed (submission ${receipt.submissionId}).\n${formatErrorWithCauses(error)}`,
					{ cause: error },
				);
			}
		},
	);
	return value as unknown as v.InferOutput<S>;
}

async function openFixPullRequest(
	client: InstallationClient,
	params: TriageWorkflowParams,
	triage: TriageConfig,
	branch: string,
	verdict: FixVerdict,
): Promise<PullRequestRef> {
	if (!verdict.pr) {
		throw new Error('A confirmed fix verdict is missing pull request content.');
	}
	const pull = await createPullRequest(client, params.owner, params.repo, {
		head: branch,
		base: params.defaultBranch,
		title: verdict.pr.title,
		body: verdict.pr.body,
	});
	await ensureLabelExists(
		client,
		params.owner,
		params.repo,
		triage.labels.prFixVerified,
		labelAppearance(triage.labels.prFixVerified, triage.labels),
	);
	await addIssueLabels(client, params.owner, params.repo, pull.number, [
		triage.labels.prFixVerified,
	]);
	return pull;
}

async function resolvePrWriterSkill(
	step: WorkflowStep,
	client: () => Promise<InstallationClient>,
	params: TriageWorkflowParams,
	triage: TriageConfig,
	reservedDirectory?: string,
): Promise<SkillSnapshot | undefined> {
	const directory = triage.prWriterSkill;
	if (!directory) return undefined;
	if (directory === reservedDirectory) {
		throw new Error('The PR writer skill must differ from the triage skill.');
	}
	return step.do('resolve PR writer skill', STEP_RETRIES, async () => {
		const api = await client();
		return readSkillSnapshot(
			api,
			params.owner,
			params.repo,
			directory,
			params.defaultBranch,
		);
	});
}

function extractLastWrite<S extends v.GenericSchema>(
	channel: string,
	data: Record<string, unknown[]>,
	schema: S,
): v.InferOutput<S> {
	const writes = data[channel];
	if (!writes?.length) {
		throw new Error(
			`The agent completed without writing a "${channel}" result.`,
		);
	}
	return v.parse(schema, writes.at(-1));
}
