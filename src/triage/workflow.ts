import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import { loadFactoryConfig, type TriageConfig } from '../config.ts';
import type { WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	createScopedInstallationToken,
	credentialsFromWorkerEnv,
	type GitHubCredentials,
	type InstallationClient,
} from '../github/client.ts';
import {
	addIssueLabels,
	createPullRequest,
	deleteBranchIfPresent,
	ensureLabelExists,
	fetchIssueDetails,
	fetchRepoLabels,
	findExistingBranch,
	findOpenPullRequest,
	partitionClassificationLabels,
	postIssueComment,
	swapIssueLabel,
	type PullRequestRef,
} from '../github/issues.ts';
import { readSkillSnapshot } from '../github/skill.ts';
import { FixVerifier } from './agents/fix-verifier.ts';
import { RetriageJudge } from './agents/retriage-judge.ts';
import { TriagePipeline } from './agents/triage-pipeline.ts';
import {
	fixBranchName,
	fixVerdictSchema,
	legacyFixBranchNames,
	retriageDecisionSchema,
	triageCoordinatorKey,
	triageWorkflowParamsSchema,
	type FixVerdict,
	type TriageWorkflowOutcome,
	type TriageWorkflowParams,
} from './contracts.ts';
import { defaultTriageSkill } from './default-skill.ts';
import {
	countTriageFailures,
	formatFailureComment,
	MAX_TRIAGE_FAILURES,
} from './failure.ts';
import { currentTriageLabel, labelAppearance } from './labels.ts';
import {
	commentResultSchema,
	diagnoseResultSchema,
	fixResultSchema,
	labelSelectionSchema,
	prContentSchema,
	reproduceResultSchema,
	verifyResultSchema,
	type TriagePipelineInput,
	type TriagePipelineResult,
} from './pipeline-contracts.ts';
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
	getTriageSandbox,
	setupTriageWorkspace,
	triageSandboxId,
	workspaceHasChanges,
} from './sandbox.ts';
import { route, type TriageAction } from './fsm.ts';

const STEP_RETRIES = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;

const MAX_COMMENT_BODY = 4_000;
const MAX_CONVERSATION_ENTRIES = 50;

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

export class TriageWorkflow extends WorkflowEntrypoint<WorkerEnv, TriageWorkflowParams> {
	override async run(
		event: Readonly<WorkflowEvent<TriageWorkflowParams>>,
		step: WorkflowStep,
	): Promise<TriageWorkflowOutcome> {
		const params = v.parse(triageWorkflowParamsSchema, event.payload);
		const coordinator = this.env.TRIAGE_COORDINATOR.getByName(triageCoordinatorKey(params));
		const completeCoordination = async () => {
			const result = await coordinator.complete(params.deliveryId);
			return {
				completed: result.completed,
				...(result.nextWorkflowId ? { nextWorkflowId: result.nextWorkflowId } : {}),
			};
		};
		await step.do('register triage coordination', async () => params.deliveryId, {
			rollback: async () => {
				await completeCoordination();
			},
			rollbackConfig: STEP_RETRIES,
		});
		const finishCoordination = () =>
			step.do('complete triage coordination', STEP_RETRIES, completeCoordination);
		const finish = async (outcome: TriageWorkflowOutcome): Promise<TriageWorkflowOutcome> => {
			await finishCoordination();
			return outcome;
		};

		const credentials = credentialsFromWorkerEnv(this.env);
		const client = () => createInstallationClient(credentials, params.installationId);

		const routed = await step.do('load issue and route', STEP_RETRIES, () =>
			loadAndRoute(client, params),
		);

		if (routed.kind === 'disabled') {
			return finish({ outcome: 'ignored', reason: 'Triage is disabled for this repository.' });
		}

		switch (routed.action.type) {
			case 'skip':
				return finish({ outcome: 'skipped', reason: routed.action.reason });
			case 'cleanup':
				return finish(await this.cleanup(step, client, params));
			case 'triage':
				return finish(await this.triage(step, client, credentials, params, routed));
			case 'retriage':
				return finish(await this.retriage(step, client, credentials, params, routed));
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
			issue.currentLabel === triage.labels.failed &&
			issue.failureCount >= MAX_TRIAGE_FAILURES
		) {
			return {
				outcome: 'skipped',
				reason: `Maximum failed triage attempts (${MAX_TRIAGE_FAILURES}) reached.`,
			};
		}

		try {
			return await this.runPipeline(step, client, credentials, params, routed);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await step.do('record triage failure', STEP_RETRIES, async () => {
				const api = await client();
				const attempt = Math.min(issue.failureCount + 1, MAX_TRIAGE_FAILURES);
				await postIssueComment(
					api,
					params.owner,
					params.repo,
					params.issueNumber,
					formatFailureComment(message, attempt),
				);
				await ensureLabelExists(
					api,
					params.owner,
					params.repo,
					triage.labels.failed,
					labelAppearance(triage.labels.failed, triage.labels),
				);
				await swapIssueLabel(
					api,
					params.owner,
					params.repo,
					params.issueNumber,
					issue.currentLabel,
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
	): Promise<TriageWorkflowOutcome> {
		const { issue, triage } = routed;
		const branch = fixBranchName(params.issueNumber);

		const skill = await step.do('resolve triage skill', STEP_RETRIES, async () => {
			if (triage.skill) {
				const api = await client();
				return readSkillSnapshot(api, params.owner, params.repo, triage.skill, params.defaultBranch);
			}
			return defaultTriageSkill();
		});

		const sandboxId = triageSandboxId(params.repositoryId, params.issueNumber, params.deliveryId);
		const sandbox = () => getTriageSandbox(this.env, sandboxId);
		const agent = init(TriagePipeline, {
			id: ['triage', params.repositoryId, params.issueNumber, params.deliveryId].join(':'),
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
		};
		const pipelineStep = <S extends v.GenericSchema>(
			name: string,
			prompt: string,
			channel: string,
			schema: S,
			readTimeout: WorkflowSleepDuration,
		): Promise<v.InferOutput<S>> =>
			runPipelineStep(step, agent, agentInput, params, name, prompt, channel, schema, readTimeout);

		try {
			await step.do(
				'provision sandbox workspace',
				{ retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '20 minutes' },
				async () => {
					await setupTriageWorkspace(sandbox(), {
						owner: params.owner,
						repo: params.repo,
						defaultBranch: params.defaultBranch,
						fixBranch: branch,
						skill,
					});
				},
			);

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

			if (!reproduce.skipped && reproduce.reproducible) {
				const diagnose = await pipelineStep(
					'diagnose',
					diagnoseStepPrompt(),
					'diagnose',
					diagnoseResultSchema,
					'25 minutes',
				);
				result.diagnosisConfidence = diagnose.confidence;

				const verify = await pipelineStep(
					'verify',
					verifyStepPrompt(),
					'verify',
					verifyResultSchema,
					'25 minutes',
				);
				result.verdict = verify.verdict;
				result.completedStage = 'verify';

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
				}
			}

			// ----- push the fix branch when the tree changed -----

			const pushed = await step.do(
				'commit and push fix branch',
				{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '15 minutes' },
				async () => {
					const changes = await workspaceHasChanges(sandbox(), params.defaultBranch);
					if (!changes.diff && !changes.dirty) return { pushed: false, detail: 'no changes' };
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
				const existing = await step.do('find existing pull request', STEP_RETRIES, async () => {
					const api = await client();
					return findOpenPullRequest(api, params.owner, params.repo, branch);
				});
				if (existing) {
					pullRequest = existing;
				} else {
					const content = await pipelineStep(
						'pr-content',
						prContentPrompt(params.issueNumber, branch, params.defaultBranch),
						'pr',
						prContentSchema,
						'10 minutes',
					);
					pullRequest = await step.do('create pull request', STEP_RETRIES, async () => {
						const api = await client();
						const created = await createPullRequest(api, params.owner, params.repo, {
							head: branch,
							base: params.defaultBranch,
							title: content.title,
							body: content.body,
						});
						await ensureLabelExists(
							api,
							params.owner,
							params.repo,
							triage.labels.prFixVerified,
							labelAppearance(triage.labels.prFixVerified, triage.labels),
						);
						await addIssueLabels(api, params.owner, params.repo, created.number, [
							triage.labels.prFixVerified,
						]);
						return created;
					});
				}
			}

			// ----- comment, state label, classification labels -----

			const repoLabels = await step.do('fetch repository labels', STEP_RETRIES, async () => {
				const api = await client();
				return partitionClassificationLabels(await fetchRepoLabels(api, params.owner, params.repo));
			});

			const generated = await pipelineStep(
				'comment',
				commentStepPrompt({
					repo: `${params.owner}/${params.repo}`,
					issueNumber: params.issueNumber,
					branchName: pushed.pushed ? branch : null,
					priorityLabels: repoLabels.priorityLabels,
					// Preview releases arrive with the workflow_dispatch milestone.
					previewReleaseUrls: null,
				}),
				'comment',
				commentResultSchema,
				'20 minutes',
			);

			const newLabel = resolveTriageLabel(result, triage.labels, {
				previewReleaseAvailable: false,
				prOpened: pullRequest !== null,
			});
			await step.do('post comment and swap state label', STEP_RETRIES, async () => {
				const api = await client();
				const comment = pullRequest
					? `${generated.comment}\n\nI've opened a pull request with this fix: ${pullRequest.url}`
					: generated.comment;
				await postIssueComment(api, params.owner, params.repo, params.issueNumber, comment);
				await ensureLabelExists(
					api,
					params.owner,
					params.repo,
					newLabel,
					labelAppearance(newLabel, triage.labels),
				);
				await swapIssueLabel(
					api,
					params.owner,
					params.repo,
					params.issueNumber,
					issue.currentLabel,
					newLabel,
				);
			});

			if (
				result.reproducible &&
				(repoLabels.priorityLabels.length > 0 || repoLabels.packageLabels.length > 0)
			) {
				const selection = await pipelineStep(
					'label-selection',
					labelSelectionPrompt(repoLabels.priorityLabels, repoLabels.packageLabels),
					'labels',
					labelSelectionSchema,
					'10 minutes',
				);
				const priorityNames = new Set(repoLabels.priorityLabels.map((label) => label.name));
				const packageNames = new Set(repoLabels.packageLabels.map((label) => label.name));
				const chosen = [
					...(selection.priority && priorityNames.has(selection.priority)
						? [selection.priority]
						: []),
					...selection.packages.filter((name) => packageNames.has(name)).slice(0, 3),
				];
				if (chosen.length > 0) {
					await step.do('apply classification labels', STEP_RETRIES, async () => {
						const api = await client();
						await addIssueLabels(api, params.owner, params.repo, params.issueNumber, chosen);
					});
				}
			}

			return {
				outcome: 'triaged',
				label: newLabel,
				branchPushed: pushed.pushed,
				pullRequestUrl: pullRequest?.url ?? null,
			};
		} finally {
			await step.do(
				'destroy sandbox',
				{ retries: { limit: 1, delay: '5 seconds', backoff: 'constant' }, timeout: '2 minutes' },
				async () => {
					await destroyTriageSandbox(sandbox());
				},
			);
		}
	}

	// ---------- Other handlers ----------

	private async cleanup(
		step: WorkflowStep,
		client: () => Promise<InstallationClient>,
		params: TriageWorkflowParams,
	): Promise<TriageWorkflowOutcome> {
		const deletedBranch = await step.do('delete fix branch', STEP_RETRIES, async () => {
			const api = await client();
			for (const branch of [
				fixBranchName(params.issueNumber),
				...legacyFixBranchNames(params.issueNumber),
			]) {
				if (await deleteBranchIfPresent(api, params.owner, params.repo, branch)) {
					return branch;
				}
			}
			return null;
		});
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
			id: ['retriage', params.repositoryId, params.issueNumber, params.deliveryId].join(':'),
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
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '15 minutes' },
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
			return { outcome: 'skipped', reason: 'No non-bot comment found to classify.' };
		}

		const agent = init(FixVerifier, {
			id: ['fix-verify', params.repositoryId, params.issueNumber, params.deliveryId].join(':'),
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
			{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '15 minutes' },
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

		const pullRequest = await step.do('open or find pull request', STEP_RETRIES, async () => {
			const api = await client();
			const existing = await findOpenPullRequest(api, params.owner, params.repo, branch);
			if (existing) return { ...existing, created: false };
			const created = await openFixPullRequest(api, params, triage, branch, verdict);
			return { ...created, created: true };
		});

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

async function loadAndRoute(
	client: () => Promise<InstallationClient>,
	params: TriageWorkflowParams,
): Promise<RouteResult> {
	const api = await client();
	const { config } = await loadFactoryConfig(api, params.owner, params.repo, params.defaultBranch);
	if (!config.triage.enabled) return { kind: 'disabled' };

	const details = await fetchIssueDetails(api, params.owner, params.repo, params.issueNumber);
	const action = route(
		{ action: params.issueAction, issueLabels: details.labels },
		config.triage.labels,
	);

	const conversation = details.comments.slice(-MAX_CONVERSATION_ENTRIES).map((comment) => ({
		author: comment.author.login,
		association: comment.authorAssociation,
		isBot: comment.authorIsBot,
		body: comment.body.slice(0, MAX_COMMENT_BODY),
	}));
	const latestNonBot = [...conversation].reverse().find((comment) => !comment.isBot) ?? null;

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
		{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: readTimeout },
		async () => {
			const reply = await agent.read(receipt);
			// Step results must be JSON-serializable; every pipeline schema is a
			// plain object, so the cast is safe.
			return extractLastWrite(channel, reply.data, schema) as unknown as Record<string, string>;
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

function extractLastWrite<S extends v.GenericSchema>(
	channel: string,
	data: Record<string, unknown[]>,
	schema: S,
): v.InferOutput<S> {
	const writes = data[channel];
	if (!writes?.length) {
		throw new Error(`The agent completed without writing a "${channel}" result.`);
	}
	return v.parse(schema, writes.at(-1));
}
