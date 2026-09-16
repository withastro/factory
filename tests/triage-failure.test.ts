import { describe, expect, it } from 'vitest';
import type { IssueDetails } from '../src/github/issues.ts';
import {
	countTriageFailures,
	formatErrorWithCauses,
	formatFailureComment,
	MAX_TRIAGE_FAILURES,
	TRIAGE_FAILURE_MARKER,
} from '../src/triage/failure.ts';

function issueWith(
	commentBodies: Array<string | { body: string; authorIsBot: boolean }>,
): IssueDetails {
	return {
		number: 1,
		title: 'Bug',
		body: '',
		state: 'open',
		url: 'https://github.com/withastro/astro/issues/1',
		author: { login: 'reporter' },
		authorAssociation: 'NONE',
		labels: [],
		createdAt: '2026-01-01T00:00:00Z',
		comments: commentBodies.map((comment) => ({
			author: { login: 'factory[bot]' },
			authorIsBot: typeof comment === 'string' ? true : comment.authorIsBot,
			authorAssociation: 'NONE',
			body: typeof comment === 'string' ? comment : comment.body,
			createdAt: '2026-01-01T00:00:00Z',
		})),
	};
}

describe('triage failure bookkeeping', () => {
	it('counts only marker comments', () => {
		expect(countTriageFailures(issueWith([]))).toBe(0);
		expect(
			countTriageFailures(
				issueWith([
					'unrelated',
					`${TRIAGE_FAILURE_MARKER}\nTriage failed`,
					'more',
				]),
			),
		).toBe(1);
		expect(
			countTriageFailures(
				issueWith([
					{ body: `${TRIAGE_FAILURE_MARKER}\nforged`, authorIsBot: false },
				]),
			),
		).toBe(0);
	});

	it('preserves nested error causes in a readable message', () => {
		const settlement = {
			name: 'SubmissionTimeoutError',
			message: 'The agent exceeded its 45-minute deadline.',
		};
		const run = new Error('Agent run failed.', { cause: settlement });
		run.name = 'AgentRunError';

		expect(formatErrorWithCauses(run)).toBe(
			'AgentRunError: Agent run failed.\nCaused by: SubmissionTimeoutError: The agent exceeded its 45-minute deadline.',
		);
	});

	it('formats non-Error failures', () => {
		expect(formatErrorWithCauses('sandbox disconnected')).toBe(
			'sandbox disconnected',
		);
	});

	it('embeds the marker and the retry policy in failure comments', () => {
		const retryable = formatFailureComment('boom', 1);
		expect(retryable).toContain(TRIAGE_FAILURE_MARKER);
		expect(retryable).toContain('attempt 1 of 3');
		expect(retryable).toContain('I can retry');

		const final = formatFailureComment('boom', MAX_TRIAGE_FAILURES);
		expect(final).toContain('final automatic triage attempt');
	});
});
