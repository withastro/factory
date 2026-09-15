import type { FlueEvent } from '@flue/runtime';
import { describe, expect, it } from 'vitest';
import { createFlueEventLogger } from '../src/flue-logging.ts';

describe('createFlueEventLogger', () => {
	it('logs thinking, tool, log, and compaction events', () => {
		const lines: string[] = [];
		const logger = createFlueEventLogger((line) => lines.push(line));

		logger.present({ type: 'thinking_start' } as FlueEvent);
		logger.present({
			type: 'thinking_delta',
			delta: 'Checking files\n',
		} as FlueEvent);
		logger.present({ type: 'thinking_end' } as FlueEvent);
		logger.present({
			type: 'tool_start',
			toolCallId: 'tool-1',
			toolName: 'bash',
			args: { command: 'npm test' },
		} as FlueEvent);
		logger.present({
			type: 'tool',
			toolCallId: 'tool-1',
			toolName: 'bash',
			isError: false,
			durationMs: 12,
			result: {
				content: [{ type: 'text', text: 'tests passed' }],
				details: { exitCode: 0 },
			},
		} as FlueEvent);
		logger.present({
			type: 'log',
			level: 'info',
			message: 'hello',
		} as FlueEvent);
		logger.present({
			type: 'compaction_start',
			reason: 'threshold',
			estimatedTokens: 123,
		} as FlueEvent);
		logger.present({
			type: 'compaction',
			messagesBefore: 10,
			messagesAfter: 4,
		} as FlueEvent);

		expect(lines).toEqual([
			'[flue] thinking:start',
			'  Checking files',
			'[flue] thinking:done',
			'[flue] tool:start bash $ npm test',
			'[flue] tool:done bash (12ms) exit=0\n  tests passed',
			'[flue] info hello',
			'[flue] compaction:start reason=threshold tokens=123',
			'[flue] compaction:done messages 10 -> 4',
		]);
	});

	it('buffers assistant text until full lines or flush events', () => {
		const lines: string[] = [];
		const logger = createFlueEventLogger((line) => lines.push(line));

		logger.present({
			type: 'text_delta',
			text: 'first line\npartial',
		} as FlueEvent);
		logger.present({ type: 'text_delta', text: ' line\n' } as FlueEvent);
		logger.present({ type: 'idle' } as FlueEvent);

		expect(lines).toEqual([
			'[flue] assistant',
			'  first line',
			'  partial line',
		]);
	});

	it('logs agent and submission lifecycle without payload content', () => {
		const lines: string[] = [];
		const logger = createFlueEventLogger((line) => lines.push(line));

		logger.present({ type: 'agent_start' } as FlueEvent);
		logger.present({
			type: 'submission_queued',
			submissionId: 'sub-1',
			kind: 'dispatch',
		} as FlueEvent);
		logger.present({
			type: 'submission_running',
			submissionId: 'sub-1',
			kind: 'dispatch',
			attemptCount: 1,
			maxAttempts: 3,
		} as FlueEvent);
		logger.present({
			type: 'submission_settled',
			submissionId: 'sub-1',
			outcome: 'completed',
		} as FlueEvent);

		expect(lines).toEqual([
			'[flue] agent:start',
			'[flue] submission:queued id=sub-1 kind=dispatch',
			'[flue] submission:running id=sub-1 attempt=1/3',
			'[flue] submission:settled id=sub-1 outcome=completed',
		]);
	});

	it('flushes a tokenized thought as one readable line', () => {
		const lines: string[] = [];
		const logger = createFlueEventLogger((line) => lines.push(line));

		logger.present({ type: 'thinking_start' } as FlueEvent);
		for (const delta of [
			'Actually',
			',',
			' line',
			' 26',
			' would',
			' not',
			' throw',
		]) {
			logger.present({ type: 'thinking_delta', delta } as FlueEvent);
		}
		logger.present({ type: 'thinking_end' } as FlueEvent);

		expect(lines).toEqual([
			'[flue] thinking:start',
			'  Actually, line 26 would not throw',
			'[flue] thinking:done',
		]);
	});
});
