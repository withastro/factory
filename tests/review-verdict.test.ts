import { describe, expect, it } from 'vitest';
import type { UnresolvedReviewThread } from '../src/review/contracts.ts';
import {
	decideReviewVerdict,
	formatVerdictNotice,
	isBlockingSeverity,
} from '../src/review/verdict.ts';

const severities = ['critical', 'high', 'medium', 'low'];

function thread(
	threadId: string,
	overrides: Partial<UnresolvedReviewThread> = {},
): UnresolvedReviewThread {
	return {
		threadId,
		commentId: `c-${threadId}`,
		reviewId: 'r1',
		reviewHeadSha: 'a'.repeat(40),
		body: 'finding',
		path: 'src/a.ts',
		line: 3,
		originalLine: 3,
		diffSide: 'RIGHT',
		startLine: null,
		originalStartLine: null,
		startDiffSide: null,
		subjectType: 'LINE',
		isOutdated: false,
		diffHunk: '',
		url: `https://github.com/o/r/pull/1#${threadId}`,
		commentUpdatedAt: '2026-09-26T00:00:00Z',
		commentCount: 1,
		severity: 'high',
		authorDisputed: false,
		authorReply: null,
		...overrides,
	};
}

const decide = (
	input: Partial<Parameters<typeof decideReviewVerdict>[0]> = {},
) =>
	decideReviewVerdict({
		findings: [],
		severities,
		threads: [],
		addressedThreadIds: [],
		...input,
	});

describe('review verdict', () => {
	it('only the least severe severity rides along on an approval', () => {
		expect(isBlockingSeverity('low', severities)).toBe(false);
		expect(isBlockingSeverity('LOW', severities)).toBe(false);
		expect(isBlockingSeverity('medium', severities)).toBe(true);
		expect(isBlockingSeverity('critical', severities)).toBe(true);
		// Unreadable or unknown severities block.
		expect(isBlockingSeverity(null, severities)).toBe(true);
		expect(isBlockingSeverity('spicy', severities)).toBe(true);
	});

	it('approves with no findings, or only low ones', () => {
		expect(decide()).toEqual({ kind: 'approve' });
		expect(decide({ findings: [{ severity: 'low' }] })).toEqual({
			kind: 'approve',
		});
		expect(decide({ threads: [thread('T1', { severity: 'low' })] })).toEqual({
			kind: 'approve',
		});
	});

	it('requests changes for new medium-or-worse findings', () => {
		expect(decide({ findings: [{ severity: 'medium' }] })).toEqual({
			kind: 'request-changes',
		});
	});

	it('keeps an unaddressed earlier finding blocking until it is addressed', () => {
		expect(decide({ threads: [thread('T1')] })).toEqual({
			kind: 'request-changes',
		});
		expect(
			decide({ threads: [thread('T1')], addressedThreadIds: ['T1'] }),
		).toEqual({ kind: 'approve' });
	});

	it("accepting the author's pushback resolves the dispute", () => {
		expect(
			decide({
				threads: [thread('T1', { authorDisputed: true })],
				addressedThreadIds: ['T1'],
			}),
		).toEqual({ kind: 'approve' });
	});

	it('is a stand-still when every blocking finding left is one the author declined', () => {
		const disputed = thread('T1', { authorDisputed: true });
		expect(
			decide({ threads: [disputed, thread('T2', { severity: 'low' })] }),
		).toEqual({ kind: 'stand-still', disputed: [disputed] });
	});

	it('is not a stand-still while other work is pending', () => {
		const disputed = thread('T1', { authorDisputed: true });
		// A new blocking finding still goes back to the author.
		expect(
			decide({ threads: [disputed], findings: [{ severity: 'high' }] }),
		).toEqual({ kind: 'request-changes' });
		// So does a finding the author hasn't answered.
		expect(decide({ threads: [disputed, thread('T2')] })).toEqual({
			kind: 'request-changes',
		});
	});

	it('names the disputed threads in a stand-still notice', () => {
		const notice = formatVerdictNotice(
			{ kind: 'stand-still', disputed: [thread('T1')] },
			{ fallback: false },
		);
		expect(notice).toContain('stand-still');
		expect(notice).toContain('[src/a.ts:3](https://github.com/o/r/pull/1#T1)');
		expect(
			formatVerdictNotice({ kind: 'approve' }, { fallback: true }),
		).toContain("doesn't let Factory approve");
	});
});
