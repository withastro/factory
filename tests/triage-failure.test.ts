import { describe, expect, it } from 'vitest';
import type { IssueDetails } from '../src/github/issues.ts';
import {
	countTriageFailures,
	formatFailureComment,
	MAX_TRIAGE_FAILURES,
	TRIAGE_FAILURE_MARKER,
} from '../src/triage/failure.ts';

function issueWith(commentBodies: string[]): IssueDetails {
	return {
		number: 1,
		title: 'Bug',
		body: '',
		state: 'open',
		url: 'https://github.com/withastro/astro/issues/1',
		author: { login: 'reporter' },
		labels: [],
		createdAt: '2026-01-01T00:00:00Z',
		comments: commentBodies.map((body) => ({
			author: { login: 'factory[bot]' },
			authorIsBot: true,
			authorAssociation: 'NONE',
			body,
			createdAt: '2026-01-01T00:00:00Z',
		})),
	};
}

describe('triage failure bookkeeping', () => {
	it('counts only marker comments', () => {
		expect(countTriageFailures(issueWith([]))).toBe(0);
		expect(
			countTriageFailures(
				issueWith(['unrelated', `${TRIAGE_FAILURE_MARKER}\nTriage failed`, 'more']),
			),
		).toBe(1);
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
