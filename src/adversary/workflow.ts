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
	createScopedInstallationToken,
	credentialsFromWorkerEnv,
} from '../github/client.ts';
import { removeLabelIfPresent } from '../github/issues.ts';
import { BlueTeam } from './agents/blue-team.ts';
import { PurpleTeam } from './agents/purple-team.ts';
import {
	bluePatchArtifactKey,
	downloadBluePatch,
	type PatchArtifact,
	uploadBluePatch,
} from './artifacts.ts';
import {
	type AdversaryCheckInput,
	completeAdversaryCheck,
	startAdversaryCheck,
} from './checks.ts';
import {
	type AdversaryWorkflowOutcome,
	type AdversaryWorkflowParams,
	adversaryCoordinatorKey,
	adversaryWorkflowParamsSchema,
	type BlueTeamInput,
	type BlueTeamResult,
	blueQualifies,
	blueTeamResultSchema,
	type PurpleTeamInput,
	type PurpleTeamResult,
	purpleTeamResultSchema,
} from './contracts.ts';
import {
	createAdversaryPullRequest,
	publishAdversaryComment,
} from './publication.ts';
import {
	BLUE_PATCH_PATH,
	captureBluePatch,
	destroyAdversarySandbox,
	getAdversarySandbox,
	pushPublisherBranch,
	setupBlueWorkspace,
	setupPublisherWorkspace,
	setupPurpleWorkspace,
} from './sandbox.ts';
import { loadAdversarySetup } from './setup.ts';

const RETRIES = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;

export class AdversaryWorkflow extends WorkflowEntrypoint<
	WorkerEnv,
	AdversaryWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<AdversaryWorkflowParams>>,
		step: WorkflowStep,
	): Promise<AdversaryWorkflowOutcome> {
		const params = v.parse(adversaryWorkflowParamsSchema, event.payload);
		const coordinator = this.env.ADVERSARY_COORDINATOR.getByName(
			adversaryCoordinatorKey(params),
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
			'register adversary coordination',
			async () => params.deliveryId,
			{
				rollback: async () => {
					await completeCoordination();
				},
				rollbackConfig: RETRIES,
			},
		);
		const finishCoordination = () =>
			step.do('complete adversary coordination', RETRIES, completeCoordination);
		const credentials = credentialsFromWorkerEnv(this.env);
		const client = () =>
			createInstallationClient(credentials, params.installationId);

		const setup = await step.do('load adversary setup', RETRIES, async () =>
			loadAdversarySetup(await client(), params),
		);
		if (setup.outcome !== 'ready') {
			await finishCoordination();
			return setup;
		}

		await step.do('remove adversary trigger label', RETRIES, async () =>
			removeLabelIfPresent(
				await client(),
				params.owner,
				params.repo,
				params.pullNumber,
				setup.triggerLabel,
			),
		);
		const checkInput: AdversaryCheckInput = params;
		const checkRunId = await step.do(
			'start adversary check',
			RETRIES,
			async () => startAdversaryCheck(await client(), checkInput),
		);
		const completeCheck = (outcome: AdversaryWorkflowOutcome) =>
			step.do('complete adversary check', RETRIES, async () => {
				await completeAdversaryCheck(
					await client(),
					checkInput,
					outcome,
					checkRunId,
				);
			});

		let artifact: PatchArtifact | undefined;
		try {
			const blue = await this.runBlue(step, params, setup.blueInput);
			const blueSandbox = getAdversarySandbox(
				this.env,
				adversarySandboxId('blue', params),
			);
			if (!blue.solved) {
				const outcome: AdversaryWorkflowOutcome = {
					outcome: 'unqualified',
					reason: 'Blue did not produce a candidate solution.',
				};
				await destroyInStep(step, 'blue', blueSandbox);
				await completeCheck(outcome);
				await finishCoordination();
				return outcome;
			}

			const patch = await step.do(
				'capture blue patch',
				{ ...RETRIES, timeout: '10 minutes' },
				() => captureBluePatch(blueSandbox, params.baseSha),
			);
			if (patch.size === 0) {
				const outcome: AdversaryWorkflowOutcome = {
					outcome: 'unqualified',
					reason: 'Blue reported a solution but produced no code changes.',
				};
				await destroyInStep(step, 'blue', blueSandbox);
				await completeCheck(outcome);
				await finishCoordination();
				return outcome;
			}
			const key = bluePatchArtifactKey({ ...params, sha256: patch.sha256 });
			artifact = await step.do('store blue patch', RETRIES, () =>
				uploadBluePatch(this.env.ADVERSARY_ARTIFACTS, blueSandbox, patch, key),
			);
			await destroyInStep(step, 'blue', blueSandbox);

			const purple = await this.runPurple(
				step,
				params,
				setup.purpleInput,
				blue,
				artifact,
			);
			if (!blueQualifies(purple)) {
				const outcome: AdversaryWorkflowOutcome = {
					outcome: 'unqualified',
					reason: 'Purple did not qualify the blue implementation.',
				};
				await step.do(
					'publish unqualified adversary comparison',
					RETRIES,
					async () => publishAdversaryComment(await client(), params, purple),
				);
				await completeCheck(outcome);
				await finishCoordination();
				return outcome;
			}
			if (purple.recommendation !== 'blue') {
				const outcome: AdversaryWorkflowOutcome = {
					outcome: 'not-selected',
					reason: `Purple recommended ${purple.recommendation}, so no alternative pull request was created.`,
				};
				await step.do('publish adversary decision', RETRIES, async () =>
					publishAdversaryComment(await client(), params, purple),
				);
				await completeCheck(outcome);
				await finishCoordination();
				return outcome;
			}
			const current = await step.do(
				'revalidate adversary target',
				RETRIES,
				async () => {
					const pull = await (await client()).rest.pulls.get({
						owner: params.owner,
						repo: params.repo,
						pull_number: params.pullNumber,
					});
					return {
						open: pull.data.state === 'open',
						headSha: pull.data.head.sha,
						baseRef: pull.data.base.ref,
					};
				},
			);
			if (
				!current.open ||
				current.headSha.toLowerCase() !== params.headSha.toLowerCase() ||
				current.baseRef !== params.baseRef
			) {
				const outcome: AdversaryWorkflowOutcome = {
					outcome: 'stale',
					reason:
						'The pull request changed before the alternative was published.',
				};
				await completeCheck(outcome);
				await finishCoordination();
				return outcome;
			}

			const branch = await this.publishBranch(step, params, artifact);
			const pullRequest = await step.do(
				'create adversary pull request',
				RETRIES,
				async () =>
					createAdversaryPullRequest(await client(), { ...params, ...branch }),
			);
			const published = { ...branch, ...pullRequest };
			const outcome: AdversaryWorkflowOutcome = {
				outcome: 'published',
				...published,
			};
			await step.do('publish adversary comparison', RETRIES, async () =>
				publishAdversaryComment(await client(), params, purple, published),
			);
			await completeCheck(outcome);
			await finishCoordination();
			return outcome;
		} catch (error) {
			const outcome: AdversaryWorkflowOutcome = {
				outcome: 'failed',
				reason: error instanceof Error ? error.message : String(error),
			};
			await completeCheck(outcome);
			await finishCoordination();
			return outcome;
		} finally {
			await Promise.allSettled(
				(['blue', 'purple', 'publisher'] as const).map((team) =>
					destroyAdversarySandbox(
						getAdversarySandbox(this.env, adversarySandboxId(team, params)),
					),
				),
			);
			if (artifact) {
				await step.do('delete blue patch artifact', RETRIES, async () => {
					await this.env.ADVERSARY_ARTIFACTS.delete(artifact?.key as string);
				});
			}
		}
	}

	private async runBlue(
		step: WorkflowStep,
		params: AdversaryWorkflowParams,
		input: Omit<BlueTeamInput, 'sandboxId'>,
	): Promise<BlueTeamResult> {
		const sandboxId = adversarySandboxId('blue', params);
		const sandbox = getAdversarySandbox(this.env, sandboxId);
		await step.do(
			'provision blue workspace',
			{ ...RETRIES, timeout: '20 minutes' },
			() => setupBlueWorkspace(sandbox, params),
		);
		const agent = init(BlueTeam, {
			id: [
				'adversary-blue',
				params.repositoryId,
				params.pullNumber,
				params.deliveryId,
			].join(':'),
		});
		const receipt = await step.do('dispatch blue team', () =>
			agent.dispatch({
				initialData: { ...input, sandboxId },
				idempotencyKey: params.deliveryId,
				message: {
					kind: 'signal',
					type: 'github.pull_request.adversary-blue',
					body: 'Produce an independent solution for the stated pull request problem.',
				},
			}),
		);
		return step.do(
			'read blue result',
			{ ...RETRIES, timeout: '50 minutes' },
			async () =>
				extractResult((await agent.read(receipt)).data, blueTeamResultSchema),
		);
	}

	private async runPurple(
		step: WorkflowStep,
		params: AdversaryWorkflowParams,
		input: Omit<PurpleTeamInput, 'sandboxId' | 'blueSummary' | 'blueApproach'>,
		blue: BlueTeamResult,
		artifact: PatchArtifact,
	): Promise<PurpleTeamResult> {
		const sandboxId = adversarySandboxId('purple', params);
		const sandbox = getAdversarySandbox(this.env, sandboxId);
		await step.do(
			'provision purple workspace',
			{ ...RETRIES, timeout: '25 minutes' },
			async () => {
				await downloadBluePatch(
					this.env.ADVERSARY_ARTIFACTS,
					sandbox,
					artifact,
					BLUE_PATCH_PATH,
				);
				await setupPurpleWorkspace(sandbox, params);
			},
		);
		const agent = init(PurpleTeam, {
			id: [
				'adversary-purple',
				params.repositoryId,
				params.pullNumber,
				params.deliveryId,
			].join(':'),
		});
		try {
			const receipt = await step.do('dispatch purple team', () =>
				agent.dispatch({
					initialData: {
						...input,
						sandboxId,
						blueSummary: blue.summary,
						blueApproach: blue.approach,
					},
					idempotencyKey: params.deliveryId,
					message: {
						kind: 'signal',
						type: 'github.pull_request.adversary-purple',
						body: 'Independently qualify blue and compare the red and blue solutions.',
					},
				}),
			);
			return await step.do(
				'read purple result',
				{ ...RETRIES, timeout: '50 minutes' },
				async () =>
					extractResult(
						(await agent.read(receipt)).data,
						purpleTeamResultSchema,
					),
			);
		} finally {
			await destroyInStep(step, 'purple', sandbox);
		}
	}

	private async publishBranch(
		step: WorkflowStep,
		params: AdversaryWorkflowParams,
		artifact: PatchArtifact,
	): Promise<{ branch: string; branchSha: string }> {
		const sandbox = getAdversarySandbox(
			this.env,
			adversarySandboxId('publisher', params),
		);
		try {
			const published = await step.do(
				'prepare adversary branch',
				{ ...RETRIES, timeout: '20 minutes' },
				async () => {
					await downloadBluePatch(
						this.env.ADVERSARY_ARTIFACTS,
						sandbox,
						artifact,
						BLUE_PATCH_PATH,
					);
					return setupPublisherWorkspace(sandbox, params);
				},
			);
			await step.do(
				'push adversary branch',
				{ ...RETRIES, timeout: '10 minutes' },
				async () => {
					const token = await createScopedInstallationToken(
						credentialsFromWorkerEnv(this.env),
						params.installationId,
						{ contents: 'write' },
					);
					await pushPublisherBranch(sandbox, {
						...published,
						owner: params.owner,
						repo: params.repo,
						token,
					});
				},
			);
			return published;
		} finally {
			await destroyInStep(step, 'publisher', sandbox);
		}
	}
}

function adversarySandboxId(
	team: 'blue' | 'purple' | 'publisher',
	params: AdversaryWorkflowParams,
): string {
	return `adversary-${team}-${params.repositoryId}-${params.pullNumber}-${params.deliveryId}`;
}

async function destroyInStep(
	step: WorkflowStep,
	team: string,
	sandbox: ReturnType<typeof getAdversarySandbox>,
): Promise<void> {
	await step.do(
		`destroy ${team} sandbox`,
		{
			retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
			timeout: '2 minutes',
		},
		() => destroyAdversarySandbox(sandbox),
	);
}

function extractResult<S extends v.GenericSchema>(
	data: Record<string, unknown[]>,
	schema: S,
): v.InferOutput<S> {
	const writes = data.result;
	if (!writes?.length)
		throw new Error('The adversary agent produced no result.');
	return v.parse(schema, writes.at(-1));
}
