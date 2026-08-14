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
	credentialsFromWorkerEnv,
	type InstallationClient,
} from '../github/client.ts';
import {
	addIssueLabels,
	createPullRequest,
	deleteBranchIfPresent,
	ensureLabelExists,
	fetchIssueDetails,
	findExistingBranch,
	findOpenPullRequest,
	postIssueComment,
	swapIssueLabel,
	type PullRequestRef,
} from '../github/issues.ts';
import { FixVerifier } from './agents/fix-verifier.ts';
import { RetriageJudge } from './agents/retriage-judge.ts';
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
import { countTriageFailures, MAX_TRIAGE_FAILURES } from './failure.ts';
import { currentTriageLabel, labelAppearance } from './labels.ts';
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
				return finish(this.triagePipelinePending());
			case 'retriage':
				return finish(await this.retriage(step, client, params, routed));
			case 'verify-fix':
				return finish(await this.verifyFix(step, client, params, routed));
		}
	}

	/**
	 * The sandboxed reproduce → diagnose → verify → fix pipeline is the next
	 * milestone. Until it lands, triage-able events settle without touching
	 * the issue, so nothing user-visible happens on real repositories.
	 */
	private triagePipelinePending(): TriageWorkflowOutcome {
		return {
			outcome: 'pipeline-pending',
			reason: 'The sandboxed triage pipeline is not implemented yet; no action was taken.',
		};
	}

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

		return this.triagePipelinePending();
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
			labels: details.labels,
			conversation,
			latestNonBotComment: latestNonBot,
			failureCount: countTriageFailures(details),
			currentLabel: currentTriageLabel(details.labels, config.triage.labels),
		},
	};
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
