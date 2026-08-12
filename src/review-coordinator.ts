import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
	reviewWorkflowParamsSchema,
	type ReviewWorkflowParams,
} from './contracts/review.ts';

const STATE_KEY = 'review-queue';
const RECONCILE_DELAY_MS = 60_000;

interface ReviewCoordinatorEnv {
	REVIEW_WORKFLOW: Workflow<ReviewWorkflowParams>;
}

interface ActiveReview {
	params: ReviewWorkflowParams;
	phase: 'starting' | 'running';
}

interface ReviewQueueState {
	active?: ActiveReview;
	pending?: ReviewWorkflowParams;
}

export interface ReviewAdmission {
	disposition: 'started' | 'queued' | 'deduplicated';
	workflowId: string;
	activeWorkflowId?: string;
}

export interface ReviewCompletion {
	completed: boolean;
	nextWorkflowId?: string;
}

type EnsureWorkflowResult = 'started' | 'active-existing' | 'terminal-existing';

export class ReviewCoordinator extends DurableObject<ReviewCoordinatorEnv> {
	private operations: Promise<void> = Promise.resolve();

	async enqueue(input: ReviewWorkflowParams): Promise<ReviewAdmission> {
		const params = v.parse(reviewWorkflowParamsSchema, input);
		return this.serialize(() => this.enqueueInternal(params));
	}

	async complete(deliveryId: string): Promise<ReviewCompletion> {
		return this.serialize(async () => {
			const state = await this.loadState();
			if (state.active?.params.deliveryId !== deliveryId) {
				return { completed: false };
			}

			state.active = undefined;
			await this.saveState(state);
			const nextWorkflowId = await this.startPending(state);
			await this.saveState(state);
			return {
				completed: true,
				nextWorkflowId,
			};
		});
	}

	override async alarm(): Promise<void> {
		await this.serialize(async () => {
			const state = await this.loadState();
			await this.reconcile(state);
			await this.saveState(state);
		});
	}

	private async enqueueInternal(params: ReviewWorkflowParams): Promise<ReviewAdmission> {
		const state = await this.loadState();
		await this.reconcile(state);

		if (state.active?.params.deliveryId === params.deliveryId) {
			return { disposition: 'deduplicated', workflowId: params.deliveryId };
		}
		if (state.pending?.deliveryId === params.deliveryId) {
			return {
				disposition: 'deduplicated',
				workflowId: params.deliveryId,
				activeWorkflowId: state.active?.params.deliveryId,
			};
		}
		if (state.active) {
			state.pending = params;
			await this.saveState(state);
			return {
				disposition: 'queued',
				workflowId: params.deliveryId,
				activeWorkflowId: state.active.params.deliveryId,
			};
		}

		const result = await this.startAsActive(state, params);
		return {
			disposition: result === 'started' ? 'started' : 'deduplicated',
			workflowId: params.deliveryId,
		};
	}

	private async reconcile(state: ReviewQueueState): Promise<void> {
		const active = state.active;
		if (active) {
			if (active.phase === 'starting') {
				await this.finishStarting(state, active);
			} else {
				const instance = await this.env.REVIEW_WORKFLOW.get(active.params.deliveryId);
				const { status } = await instance.status();
				if (isActiveWorkflowStatus(status)) return;
				if (status === 'unknown') {
					active.phase = 'starting';
					await this.saveState(state);
					await this.finishStarting(state, active);
				} else {
					state.active = undefined;
					await this.saveState(state);
				}
			}
		}

		if (!state.active) await this.startPending(state);
	}

	private async startPending(state: ReviewQueueState): Promise<string | undefined> {
		const pending = state.pending;
		if (!pending) return;
		state.pending = undefined;
		const result = await this.startAsActive(state, pending);
		return result === 'terminal-existing' ? undefined : pending.deliveryId;
	}

	private async startAsActive(
		state: ReviewQueueState,
		params: ReviewWorkflowParams,
	): Promise<EnsureWorkflowResult> {
		const active: ActiveReview = { params, phase: 'starting' };
		state.active = active;
		await this.saveState(state);
		return this.finishStarting(state, active);
	}

	private async finishStarting(
		state: ReviewQueueState,
		active: ActiveReview,
	): Promise<EnsureWorkflowResult> {
		const result = await this.ensureWorkflow(active.params);
		if (result === 'terminal-existing') {
			state.active = undefined;
		} else {
			active.phase = 'running';
		}
		await this.saveState(state);
		return result;
	}

	private async ensureWorkflow(params: ReviewWorkflowParams): Promise<EnsureWorkflowResult> {
		try {
			await this.env.REVIEW_WORKFLOW.create({ id: params.deliveryId, params });
			return 'started';
		} catch (error) {
			const instance = await this.env.REVIEW_WORKFLOW.get(params.deliveryId);
			const { status } = await instance.status();
			if (status === 'unknown') throw error;
			return isActiveWorkflowStatus(status) ? 'active-existing' : 'terminal-existing';
		}
	}

	private async loadState(): Promise<ReviewQueueState> {
		return (await this.ctx.storage.get<ReviewQueueState>(STATE_KEY)) ?? {};
	}

	private async saveState(state: ReviewQueueState): Promise<void> {
		if (state.active || state.pending) {
			await this.ctx.storage.put(STATE_KEY, state);
		} else {
			await this.ctx.storage.delete(STATE_KEY);
		}

		if (state.pending || state.active?.phase === 'starting') {
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

function isActiveWorkflowStatus(status: string): boolean {
	return (
		status === 'queued' ||
		status === 'running' ||
		status === 'paused' ||
		status === 'waiting' ||
		status === 'waitingForPause'
	);
}
