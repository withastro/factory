import { DurableObject } from 'cloudflare:workers';
import { init } from '@flue/runtime';
import * as v from 'valibot';
import type {
	QueueAdmission,
	QueueCompletion,
} from '../coordination/queue-coordinator.ts';
import type { WorkerEnv } from '../env.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
} from '../github/client.ts';
import { ReleaseSecurityReviewer } from './agents/reviewer.ts';
import {
	incompleteResult,
	type ReleaseSecurityResult,
	type ReleaseSecurityWorkflowParams,
	releaseSecurityWorkflowParamsSchema,
} from './contracts.ts';
import { liveTargetMatches, loadLiveReleaseSecurityTarget } from './github.ts';
import { finalizeFailedReleaseSecurityReview } from './publication.ts';

const STATE_KEY = 'release-security-queue';
const RECONCILE_DELAY_MS = 60_000;
const PROGRESS_TIMEOUT_MS = 100 * 60_000;
const HARD_TIMEOUT_MS = 4 * 60 * 60_000;
const MAX_FINALIZATION_ATTEMPTS = 12;

type ActivePhase =
	| 'starting'
	| 'running'
	| 'stopping'
	| 'finalizing'
	| 'dead-letter';

interface ActiveReview {
	params: ReleaseSecurityWorkflowParams;
	phase: ActivePhase;
	stage: string;
	startedAt: number;
	updatedAt: number;
	checkRunId?: number;
	agentId?: string;
	terminalResult?: ReleaseSecurityResult;
	finalizationAttempts: number;
}

interface CoordinatorState {
	active?: ActiveReview;
	pending?: ReleaseSecurityWorkflowParams;
}

export interface ReleaseSecurityProgress {
	stage: string;
	checkRunId?: number;
	agentId?: string;
}

export type ReleaseSecurityAdmission =
	| QueueAdmission
	| { disposition: 'rejected'; workflowId: string; reason: string };

export class ReleaseSecurityCoordinator extends DurableObject<WorkerEnv> {
	private operations: Promise<void> = Promise.resolve();

	async enqueue(
		input: ReleaseSecurityWorkflowParams,
	): Promise<ReleaseSecurityAdmission> {
		const params = v.parse(releaseSecurityWorkflowParamsSchema, input);
		return this.serialize(async () => {
			const state = await this.loadState();
			await this.reconcile(state);
			if (state.active?.params.deliveryId === params.deliveryId) {
				return {
					disposition: 'deduplicated',
					workflowId: params.deliveryId,
				};
			}
			if (state.pending?.deliveryId === params.deliveryId) {
				return {
					disposition: 'deduplicated',
					workflowId: params.deliveryId,
					activeWorkflowId: state.active?.params.deliveryId,
				};
			}
			if (!(await this.isCurrentTarget(params))) {
				return {
					disposition: 'rejected',
					workflowId: params.deliveryId,
					reason: 'Release pull request no longer matches this delivery.',
				};
			}
			if (state.active) {
				if (sameTarget(state.active.params, params)) {
					if (params.trigger === 'rerequest') {
						state.pending = params;
						await this.saveState(state);
						return {
							disposition: 'queued',
							workflowId: params.deliveryId,
							activeWorkflowId: state.active.params.deliveryId,
						};
					}
					return {
						disposition: 'deduplicated',
						workflowId: state.active.params.deliveryId,
					};
				}
				state.pending = params;
				markStopping(
					state.active,
					'superseded',
					'the release pull request was superseded by a newer head',
				);
				await this.saveState(state);
				if (await this.stopActive(state.active)) {
					state.active.phase = 'finalizing';
					await this.saveState(state);
				}
				return {
					disposition: 'queued',
					workflowId: params.deliveryId,
					activeWorkflowId: state.active.params.deliveryId,
				};
			}
			const started = await this.startAsActive(state, params);
			return {
				disposition: started ? 'started' : 'deduplicated',
				workflowId: params.deliveryId,
			};
		});
	}

	async track(
		deliveryId: string,
		progress: ReleaseSecurityProgress,
	): Promise<boolean> {
		return this.serialize(async () => {
			const state = await this.loadState();
			const active = state.active;
			if (!active || active.params.deliveryId !== deliveryId) return false;
			active.phase = 'running';
			active.stage = progress.stage;
			active.updatedAt = Date.now();
			if (progress.checkRunId !== undefined) {
				active.checkRunId = progress.checkRunId;
			}
			if (progress.agentId !== undefined) active.agentId = progress.agentId;
			await this.saveState(state);
			return true;
		});
	}

	async fail(deliveryId: string, reason: string): Promise<boolean> {
		return this.serialize(async () => {
			const state = await this.loadState();
			const active = state.active;
			if (!active || active.params.deliveryId !== deliveryId) return false;
			if (active.phase === 'stopping') return true;
			active.phase = 'finalizing';
			active.stage = 'failure finalization';
			active.updatedAt = Date.now();
			active.terminalResult = incompleteResult(active.params.headSha, reason);
			await this.saveState(state, Date.now() + 1_000);
			return true;
		});
	}

	async complete(deliveryId: string): Promise<QueueCompletion> {
		return this.serialize(async () => {
			const state = await this.loadState();
			if (state.active?.params.deliveryId !== deliveryId) {
				return { completed: false };
			}
			state.active = undefined;
			const nextWorkflowId = await this.startPending(state);
			await this.saveState(state);
			return { completed: true, nextWorkflowId };
		});
	}

	override async alarm(): Promise<void> {
		await this.serialize(async () => {
			const state = await this.loadState();
			await this.reconcile(state);
			await this.saveState(state);
		});
	}

	private async reconcile(state: CoordinatorState): Promise<void> {
		const active = state.active;
		if (!active) {
			await this.startPending(state);
			return;
		}
		if (active.phase === 'dead-letter') return;
		if (active.phase === 'stopping') {
			if (!(await this.stopActive(active))) return;
			active.phase = 'finalizing';
			active.updatedAt = Date.now();
			await this.saveState(state);
			await this.finalizeFailure(state, active);
			return;
		}
		if (active.phase === 'finalizing') {
			await this.finalizeFailure(state, active);
			return;
		}
		if (active.phase === 'starting') {
			const started = await this.ensureWorkflow(active.params);
			if (!started) state.active = undefined;
			else {
				active.phase = 'running';
				active.stage = 'workflow admitted';
				active.updatedAt = Date.now();
			}
			if (!state.active) await this.startPending(state);
			return;
		}

		const instance = await this.env.RELEASE_SECURITY_WORKFLOW.get(
			active.params.deliveryId,
		);
		const status = await instance.status();
		if (status.status === 'complete') {
			state.active = undefined;
			await this.startPending(state);
			return;
		}
		if (status.status === 'errored' || status.status === 'terminated') {
			active.phase = 'finalizing';
			active.terminalResult ??= incompleteResult(
				active.params.headSha,
				`the durable release security workflow ${status.status}`,
			);
			await this.finalizeFailure(state, active);
			return;
		}
		if (status.status === 'unknown') {
			active.phase = 'starting';
			active.updatedAt = Date.now();
			return;
		}

		const now = Date.now();
		if (
			now - active.startedAt >= HARD_TIMEOUT_MS ||
			now - active.updatedAt >= PROGRESS_TIMEOUT_MS
		) {
			markStopping(
				active,
				'watchdog timeout',
				'the durable release security workflow stopped reporting progress',
			);
			await this.saveState(state);
			if (await this.stopActive(active)) {
				active.phase = 'finalizing';
				active.updatedAt = now;
				await this.saveState(state);
				await this.finalizeFailure(state, active);
			}
		}
	}

	private async stopActive(active: ActiveReview): Promise<boolean> {
		let stopped = false;
		try {
			const instance = await this.env.RELEASE_SECURITY_WORKFLOW.get(
				active.params.deliveryId,
			);
			let status = await instance.status();
			if (isActiveStatus(status.status)) {
				await instance.terminate({ rollback: true });
				status = await instance.status();
			}
			stopped = !isActiveStatus(status.status);
		} catch (error) {
			console.error(
				JSON.stringify({
					event: 'release_security_workflow_stop_failed',
					deliveryId: active.params.deliveryId,
					error: errorName(error),
				}),
			);
		}
		await this.abortAgent(active);
		return stopped;
	}

	private async abortAgent(active: ActiveReview): Promise<void> {
		if (!active.agentId) return;
		try {
			await init(ReleaseSecurityReviewer, { id: active.agentId }).abort();
		} catch (error) {
			console.error(
				JSON.stringify({
					event: 'release_security_agent_abort_failed',
					deliveryId: active.params.deliveryId,
					error: errorName(error),
				}),
			);
		}
	}

	private async finalizeFailure(
		state: CoordinatorState,
		active: ActiveReview,
	): Promise<void> {
		active.finalizationAttempts += 1;
		active.updatedAt = Date.now();
		try {
			await finalizeFailedReleaseSecurityReview(
				this.env,
				active.params,
				active.terminalResult ??
					incompleteResult(active.params.headSha, 'the review failed'),
				active.checkRunId,
			);
			state.active = undefined;
			await this.startPending(state);
		} catch (error) {
			console.error(
				JSON.stringify({
					event: 'release_security_watchdog_retry',
					deliveryId: active.params.deliveryId,
					attempt: active.finalizationAttempts,
					error: errorName(error),
				}),
			);
			if (active.finalizationAttempts >= MAX_FINALIZATION_ATTEMPTS) {
				active.phase = 'dead-letter';
				active.stage = 'operator intervention required';
				console.error(
					JSON.stringify({
						event: 'release_security_dead_letter',
						deliveryId: active.params.deliveryId,
					}),
				);
			}
		}
	}

	private async startPending(
		state: CoordinatorState,
	): Promise<string | undefined> {
		const pending = state.pending;
		if (!pending) return;
		if (!(await this.isCurrentTarget(pending))) {
			state.pending = undefined;
			return;
		}
		state.pending = undefined;
		const started = await this.startAsActive(state, pending);
		return started ? pending.deliveryId : undefined;
	}

	private async startAsActive(
		state: CoordinatorState,
		params: ReleaseSecurityWorkflowParams,
	): Promise<boolean> {
		const now = Date.now();
		const active: ActiveReview = {
			params,
			phase: 'starting',
			stage: 'workflow admission',
			startedAt: now,
			updatedAt: now,
			finalizationAttempts: 0,
		};
		state.active = active;
		await this.saveState(state);
		const started = await this.ensureWorkflow(params);
		if (!started) state.active = undefined;
		else {
			active.phase = 'running';
			active.stage = 'workflow admitted';
			active.updatedAt = Date.now();
		}
		await this.saveState(state);
		return started;
	}

	private async ensureWorkflow(
		params: ReleaseSecurityWorkflowParams,
	): Promise<boolean> {
		try {
			await this.env.RELEASE_SECURITY_WORKFLOW.create({
				id: params.deliveryId,
				params,
				retention: {
					successRetention: '7 days',
					errorRetention: '30 days',
				},
			});
			return true;
		} catch (error) {
			const instance = await this.env.RELEASE_SECURITY_WORKFLOW.get(
				params.deliveryId,
			);
			const status = await instance.status();
			if (status.status === 'unknown') throw error;
			return isActiveStatus(status.status);
		}
	}

	private async isCurrentTarget(
		params: ReleaseSecurityWorkflowParams,
	): Promise<boolean> {
		const client = await createInstallationClient(
			credentialsFromWorkerEnv(this.env),
			params.installationId,
		);
		return liveTargetMatches(
			params,
			await loadLiveReleaseSecurityTarget(
				client,
				params.owner,
				params.repo,
				params.pullNumber,
			),
		);
	}

	private async loadState(): Promise<CoordinatorState> {
		const state =
			(await this.ctx.storage.get<CoordinatorState>(STATE_KEY)) ?? {};
		if (state.active) {
			state.active.params = v.parse(
				releaseSecurityWorkflowParamsSchema,
				state.active.params,
			);
		}
		if (state.pending) {
			state.pending = v.parse(
				releaseSecurityWorkflowParamsSchema,
				state.pending,
			);
		}
		return state;
	}

	private async saveState(
		state: CoordinatorState,
		alarmAt?: number,
	): Promise<void> {
		if (state.active || state.pending) {
			await this.ctx.storage.put(STATE_KEY, state);
		} else {
			await this.ctx.storage.delete(STATE_KEY);
		}
		if (state.active && state.active.phase !== 'dead-letter') {
			await this.ctx.storage.setAlarm(
				alarmAt ?? Date.now() + RECONCILE_DELAY_MS,
			);
		} else if (!state.active && state.pending) {
			await this.ctx.storage.setAlarm(Date.now() + RECONCILE_DELAY_MS);
		} else {
			await this.ctx.storage.deleteAlarm();
		}
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operations.then(operation, operation);
		this.operations = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function markStopping(
	active: ActiveReview,
	stage: string,
	reason: string,
): void {
	active.phase = 'stopping';
	active.stage = stage;
	active.updatedAt = Date.now();
	active.terminalResult = incompleteResult(active.params.headSha, reason);
}

function sameTarget(
	left: ReleaseSecurityWorkflowParams,
	right: ReleaseSecurityWorkflowParams,
): boolean {
	return (
		left.owner === right.owner &&
		left.repo === right.repo &&
		left.pullNumber === right.pullNumber &&
		left.headRef === right.headRef &&
		left.headSha === right.headSha &&
		left.baseRef === right.baseRef &&
		left.baseSha === right.baseSha &&
		left.mode === right.mode
	);
}

function isActiveStatus(status: string): boolean {
	return (
		status === 'queued' ||
		status === 'running' ||
		status === 'paused' ||
		status === 'waiting' ||
		status === 'waitingForPause'
	);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : 'UnknownError';
}
