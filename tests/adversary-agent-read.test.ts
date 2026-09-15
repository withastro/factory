import type { AgentReply } from '@flue/runtime';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAdversaryAgentResult } from '../src/adversary/agent-read.ts';

const resultSchema = v.object({ solved: v.boolean() });
type StepCallback = (context: { attempt: number }) => Promise<string | null>;

function reply(solved: boolean): AgentReply {
	return {
		text: '',
		data: { result: [{ solved }] },
		submissionId: 'sub-1',
	};
}

describe('readAdversaryAgentResult', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns a settled result from the first observation', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const names: string[] = [];
		const step = {
			do: async (name: string, _config: unknown, callback: StepCallback) => {
				names.push(name);
				return callback({ attempt: 1 });
			},
		};

		await expect(
			readAdversaryAgentResult(
				step,
				'blue',
				'sub-1',
				async () => reply(true),
				resultSchema,
			),
		).resolves.toEqual({ solved: true });
		expect(names).toEqual(['read blue result']);
	});

	it('reattaches after a bounded observation elapses', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'info').mockImplementation(() => {});
		let reads = 0;
		const step = {
			do: async (_name: string, _config: unknown, callback: StepCallback) =>
				callback({ attempt: 1 }),
		};
		const result = readAdversaryAgentResult(
			step,
			'purple',
			'sub-1',
			(signal) => {
				reads++;
				if (reads > 1) return Promise.resolve(reply(true));
				return new Promise((_, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					});
				});
			},
			resultSchema,
		);

		await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
		await expect(result).resolves.toEqual({ solved: true });
		expect(reads).toBe(2);
	});

	it('does not hide agent failures', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const failure = new Error('agent failed');
		const step = {
			do: async (_name: string, _config: unknown, callback: StepCallback) =>
				callback({ attempt: 1 }),
		};

		await expect(
			readAdversaryAgentResult(
				step,
				'blue',
				'sub-1',
				async () => {
					throw failure;
				},
				resultSchema,
			),
		).rejects.toBe(failure);
	});
});
