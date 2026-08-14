/**
 * Per-entity workflow queue, generalized from astro-review's coordinator.
 *
 * Each Durable Object instance serializes work for one entity (a pull request,
 * an issue). It keeps at most one active and one pending workflow: duplicate
 * webhook deliveries are deduplicated by delivery id, and while a workflow is
 * active the newest additional trigger replaces the pending slot. A one-minute
 * alarm reconciles state with the Workflows API to self-heal after crashes.
 */

import { DurableObject } from 'cloudflare:workers';

const STATE_KEY = 'queue';
const RECONCILE_DELAY_MS = 60_000;

export interface QueueParams {
	deliveryId: string;
}

interface ActiveEntry<P extends QueueParams> {
	params: P;
	phase: 'starting' | 'running';
}

interface QueueState<P extends QueueParams> {
	active?: ActiveEntry<P>;
	pending?: P;
}

export interface QueueAdmission {
	disposition: 'started' | 'queued' | 'deduplicated';
	workflowId: string;
	activeWorkflowId?: string;
}

export interface QueueCompletion {
	completed: boolean;
	nextWorkflowId?: string;
}

type EnsureWorkflowResult = 'started' | 'active-existing' | 'terminal-existing';

export abstract class QueueCoordinator<
	P extends QueueParams,
	E = unknown,
> extends DurableObject<E> {
	private operations: Promise<void> = Promise.resolve();

	/** Validate and normalize params received over RPC or loaded from storage. */
	protected abstract parseParams(input: unknown): P;

	/** The Workflow binding that runs entries from this queue. */
	protected abstract workflowBinding(): Workflow<P>;

	async enqueue(input: P): Promise<QueueAdmission> {
		const params = this.parseParams(input);
		return this.serialize(() => this.enqueueInternal(params));
	}

	async complete(deliveryId: string): Promise<QueueCompletion> {
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

	private async enqueueInternal(params: P): Promise<QueueAdmission> {
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

	private async reconcile(state: QueueState<P>): Promise<void> {
		const active = state.active;
		if (active) {
			if (active.phase === 'starting') {
				await this.finishStarting(state, active);
			} else {
				const instance = await this.workflowBinding().get(active.params.deliveryId);
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

	private async startPending(state: QueueState<P>): Promise<string | undefined> {
		const pending = state.pending;
		if (!pending) return;
		state.pending = undefined;
		const result = await this.startAsActive(state, pending);
		return result === 'terminal-existing' ? undefined : pending.deliveryId;
	}

	private async startAsActive(
		state: QueueState<P>,
		params: P,
	): Promise<EnsureWorkflowResult> {
		const active: ActiveEntry<P> = { params, phase: 'starting' };
		state.active = active;
		await this.saveState(state);
		return this.finishStarting(state, active);
	}

	private async finishStarting(
		state: QueueState<P>,
		active: ActiveEntry<P>,
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

	private async ensureWorkflow(params: P): Promise<EnsureWorkflowResult> {
		try {
			await this.workflowBinding().create({ id: params.deliveryId, params });
			return 'started';
		} catch (error) {
			const instance = await this.workflowBinding().get(params.deliveryId);
			const { status } = await instance.status();
			if (status === 'unknown') throw error;
			return isActiveWorkflowStatus(status) ? 'active-existing' : 'terminal-existing';
		}
	}

	private async loadState(): Promise<QueueState<P>> {
		const state = (await this.ctx.storage.get<QueueState<P>>(STATE_KEY)) ?? {};
		if (state.active) {
			state.active.params = this.parseParams(state.active.params);
		}
		if (state.pending) {
			state.pending = this.parseParams(state.pending);
		}
		return state;
	}

	private async saveState(state: QueueState<P>): Promise<void> {
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
