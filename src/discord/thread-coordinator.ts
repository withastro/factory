/**
 * One Durable Object per Discord thread. It runs the thread's jobs one at a
 * time, in order, and holds the thread's small amount of state: how far the
 * assistant has read, and the proposals awaiting a maintainer's confirmation.
 *
 * Unlike the GitHub coordinators, nothing is dropped. A pull request job
 * always runs. Mentions coalesce instead: a mention run answers everything
 * new in the thread, so a second mention queued behind a first only needs one
 * more run, and a newer mention replaces an older one still waiting.
 *
 * A one-minute alarm reconciles with the Workflows API while work is queued,
 * so a workflow that died without reporting back doesn't stall the thread.
 */

import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
	type DiscordThreadWorkflowParams,
	discordThreadWorkflowParamsSchema,
	type Proposal,
	type ProposalStatus,
	proposalSchema,
	type StoredProposal,
} from './contracts.ts';

const QUEUE_KEY = 'queue';
const CURSOR_KEY = 'cursor';
const PROPOSAL_PREFIX = 'proposal:';
const LINKED_ISSUES_KEY = 'linked-issues';
const LINKED_ISSUE_LIMIT = 10;
const RECONCILE_DELAY_MS = 60_000;
/** Recently finished job ids, kept to deduplicate late redeliveries. */
const RECENT_LIMIT = 50;

interface QueueState {
	jobs: DiscordThreadWorkflowParams[];
	/** Whether the head job's workflow has been created. */
	headStarted: boolean;
	recent: string[];
}

export interface ThreadAdmission {
	disposition: 'started' | 'queued' | 'coalesced' | 'deduplicated';
	/** Jobs ahead of this one. */
	ahead: number;
}

interface DiscordThreadCoordinatorEnv {
	DISCORD_THREAD_WORKFLOW: Workflow<DiscordThreadWorkflowParams>;
}

export class DiscordThreadCoordinator extends DurableObject<DiscordThreadCoordinatorEnv> {
	private operations: Promise<void> = Promise.resolve();

	async enqueue(input: DiscordThreadWorkflowParams): Promise<ThreadAdmission> {
		const params = v.parse(discordThreadWorkflowParamsSchema, input);
		return this.serialize(async () => {
			const state = await this.loadQueue();
			if (
				state.recent.includes(params.deliveryId) ||
				state.jobs.some((job) => job.deliveryId === params.deliveryId)
			) {
				return { disposition: 'deduplicated', ahead: 0 };
			}

			if (params.job.kind === 'mention') {
				// Replace a mention that hasn't started yet: one run answers both.
				const waiting = state.jobs.findIndex(
					(job, index) =>
						job.job.kind === 'mention' && (index > 0 || !state.headStarted),
				);
				if (waiting >= 0) {
					state.jobs[waiting] = params;
					await this.saveQueue(state);
					if (waiting === 0) await this.startHead(state);
					return { disposition: 'coalesced', ahead: waiting };
				}
			}

			state.jobs.push(params);
			const ahead = state.jobs.length - 1;
			await this.saveQueue(state);
			if (ahead === 0) {
				await this.startHead(state);
				return { disposition: 'started', ahead };
			}
			return { disposition: 'queued', ahead };
		});
	}

	/** Called by the workflow when its job is finished, successful or not. */
	async complete(deliveryId: string): Promise<{ completed: boolean }> {
		return this.serialize(async () => {
			const state = await this.loadQueue();
			if (state.jobs[0]?.deliveryId !== deliveryId) return { completed: false };
			this.finishHead(state);
			await this.saveQueue(state);
			await this.startHead(state);
			return { completed: true };
		});
	}

	override async alarm(): Promise<void> {
		await this.serialize(async () => {
			const state = await this.loadQueue();
			const head = state.jobs[0];
			if (head && state.headStarted) {
				const status = await this.workflowStatus(head.deliveryId);
				if (status !== 'unknown' && !isActiveWorkflowStatus(status)) {
					this.finishHead(state);
				} else if (status === 'unknown') {
					state.headStarted = false;
				}
				await this.saveQueue(state);
			}
			await this.startHead(state);
		});
	}

	// ---------- Read cursor ----------

	/** The newest message the assistant has already read. */
	async getCursor(): Promise<string | null> {
		return (await this.ctx.storage.get<string>(CURSOR_KEY)) ?? null;
	}

	async advanceCursor(messageId: string): Promise<void> {
		await this.serialize(async () => {
			const current = await this.ctx.storage.get<string>(CURSOR_KEY);
			if (!current || BigInt(messageId) > BigInt(current)) {
				await this.ctx.storage.put(CURSOR_KEY, messageId);
			}
		});
	}

	// ---------- Linked issues ----------

	/**
	 * Record GitHub issues referenced in the thread and return all of them, so
	 * a rebuilt sandbox can be restaged with every issue the thread linked.
	 */
	async addLinkedIssues(numbers: readonly number[]): Promise<number[]> {
		return this.serialize(async () => {
			const current =
				(await this.ctx.storage.get<number[]>(LINKED_ISSUES_KEY)) ?? [];
			const merged = [...new Set([...current, ...numbers])].slice(
				-LINKED_ISSUE_LIMIT,
			);
			if (merged.length !== current.length) {
				await this.ctx.storage.put(LINKED_ISSUES_KEY, merged);
			}
			return merged;
		});
	}

	// ---------- Proposals ----------

	async saveProposal(input: Proposal): Promise<void> {
		const proposal = v.parse(proposalSchema, input);
		await this.serialize(async () => {
			const key = PROPOSAL_PREFIX + proposal.id;
			if (await this.ctx.storage.get(key)) return;
			const stored: StoredProposal = {
				proposal,
				messageId: undefined,
				status: { state: 'proposed' },
			};
			await this.ctx.storage.put(key, stored);
		});
	}

	async attachProposalMessage(
		proposalId: string,
		messageId: string,
	): Promise<void> {
		await this.updateProposal(proposalId, (stored) => ({
			...stored,
			messageId,
		}));
	}

	async getProposal(proposalId: string): Promise<StoredProposal | null> {
		return (
			(await this.ctx.storage.get<StoredProposal>(
				PROPOSAL_PREFIX + proposalId,
			)) ?? null
		);
	}

	/**
	 * Claim a proposal for one maintainer's confirmation. Only a proposal
	 * still awaiting a decision can be claimed, so two confirmations act once.
	 */
	async claimProposal(
		proposalId: string,
		byId: string,
		byName: string,
	): Promise<StoredProposal | null> {
		let claimed: StoredProposal | null = null;
		await this.updateProposal(proposalId, (stored) => {
			if (stored.status.state !== 'proposed') return stored;
			claimed = { ...stored, status: { state: 'claimed', byId, byName } };
			return claimed;
		});
		return claimed;
	}

	async settleProposal(
		proposalId: string,
		status: Exclude<ProposalStatus, { state: 'claimed' }>,
	): Promise<void> {
		await this.updateProposal(proposalId, (stored) => ({ ...stored, status }));
	}

	private async updateProposal(
		proposalId: string,
		update: (stored: StoredProposal) => StoredProposal,
	): Promise<void> {
		await this.serialize(async () => {
			const key = PROPOSAL_PREFIX + proposalId;
			const stored = await this.ctx.storage.get<StoredProposal>(key);
			if (!stored) return;
			await this.ctx.storage.put(key, update(stored));
		});
	}

	// ---------- Queue internals ----------

	private finishHead(state: QueueState): void {
		const head = state.jobs.shift();
		state.headStarted = false;
		if (head) {
			state.recent = [...state.recent, head.deliveryId].slice(-RECENT_LIMIT);
		}
	}

	private async startHead(state: QueueState): Promise<void> {
		const head = state.jobs[0];
		if (!head || state.headStarted) return;
		try {
			await this.env.DISCORD_THREAD_WORKFLOW.create({
				id: head.deliveryId,
				params: head,
			});
		} catch (error) {
			const status = await this.workflowStatus(head.deliveryId);
			if (status === 'unknown') {
				// Couldn't start it; the alarm retries.
				console.warn('Failed to start Discord thread workflow:', error);
				return;
			}
			if (!isActiveWorkflowStatus(status)) {
				// This job already ran to the end; move on.
				this.finishHead(state);
				await this.saveQueue(state);
				await this.startHead(state);
				return;
			}
		}
		state.headStarted = true;
		await this.saveQueue(state);
	}

	private async workflowStatus(id: string): Promise<string> {
		try {
			const instance = await this.env.DISCORD_THREAD_WORKFLOW.get(id);
			return (await instance.status()).status;
		} catch {
			return 'unknown';
		}
	}

	private async loadQueue(): Promise<QueueState> {
		const state = await this.ctx.storage.get<QueueState>(QUEUE_KEY);
		return {
			jobs: (state?.jobs ?? []).map((job) =>
				v.parse(discordThreadWorkflowParamsSchema, job),
			),
			headStarted: state?.headStarted ?? false,
			recent: state?.recent ?? [],
		};
	}

	private async saveQueue(state: QueueState): Promise<void> {
		await this.ctx.storage.put(QUEUE_KEY, state);
		if (state.jobs.length > 0) {
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
