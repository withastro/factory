import { describe, expect, it } from 'vitest';
import { normalizeIssueState } from '../src/github/issues.ts';
import { route } from '../src/triage/fsm.ts';
import {
	allTriageLabels,
	DEFAULT_TRIAGE_LABELS,
	type TriageLabelConfig,
} from '../src/triage/labels.ts';

const labels = DEFAULT_TRIAGE_LABELS;

describe('triage FSM', () => {
	it('routes opened issue to triage', () => {
		expect(
			route({ action: 'opened', issueState: 'open', issueLabels: [] }, labels),
		).toEqual({
			type: 'triage',
		});
	});

	it('routes reopened issue to triage', () => {
		expect(
			route(
				{ action: 'reopened', issueState: 'open', issueLabels: [] },
				labels,
			),
		).toEqual({
			type: 'triage',
		});
	});

	it('routes closed issue to cleanup', () => {
		expect(
			route(
				{ action: 'closed', issueState: 'closed', issueLabels: [] },
				labels,
			),
		).toEqual({
			type: 'cleanup',
		});
	});

	it('routes comment on fix-pending to verify-fix', () => {
		expect(
			route(
				{
					action: 'comment',
					issueState: 'open',
					issueLabels: ['triage: fix pending'],
				},
				labels,
			),
		).toEqual({ type: 'verify-fix' });
	});

	it('restarts triage when a comment finds a stranded in-progress issue', () => {
		expect(
			route(
				{
					action: 'comment',
					issueState: 'open',
					issueLabels: [labels.inProgress],
				},
				labels,
			),
		).toEqual({ type: 'triage' });
	});

	for (const label of [
		'triage: needs triage',
		'triage: needs reproduction',
		'triage: unable to reproduce',
		'triage: unable to fix',
		'triage: failed',
		'triage: fix rejected',
	]) {
		it(`routes comment on "${label}" to retriage`, () => {
			expect(
				route(
					{ action: 'comment', issueState: 'open', issueLabels: [label] },
					labels,
				),
			).toEqual({
				type: 'retriage',
				currentLabel: label,
			});
		});
	}

	for (const label of [
		'triage: fix verified',
		'triage: not actionable',
		'triage: skipped',
	]) {
		it(`skips comment on terminal label "${label}"`, () => {
			expect(
				route(
					{ action: 'comment', issueState: 'open', issueLabels: [label] },
					labels,
				).type,
			).toBe('skip');
		});
	}

	it('skips comment on issue with no triage label', () => {
		expect(
			route(
				{
					action: 'comment',
					issueState: 'open',
					issueLabels: ['bug', 'pkg: astro'],
				},
				labels,
			).type,
		).toBe('skip');
	});

	it('works with custom label names', () => {
		const customLabels: TriageLabelConfig = {
			...labels,
			fixPending: 'awaiting-confirmation',
			fixVerified: 'confirmed-fix',
		};
		expect(
			route(
				{
					action: 'comment',
					issueState: 'open',
					issueLabels: ['awaiting-confirmation'],
				},
				customLabels,
			),
		).toEqual({ type: 'verify-fix' });
	});
});

/**
 * A closed issue has been decided. Commenting on one used to run the
 * FixVerifier or the RetriageJudge regardless, and a re-triage could push a
 * fresh fix branch and open a pull request against an issue a maintainer had
 * already closed.
 */
describe('triage FSM on a closed issue', () => {
	it('skips a comment whatever the triage label says', () => {
		// Every label that would otherwise do work, including the two that
		// spend a model call before anything else happens.
		for (const label of allTriageLabels(labels)) {
			const action = route(
				{ action: 'comment', issueState: 'closed', issueLabels: [label] },
				labels,
			);
			expect(action.type, `comment on closed issue labelled "${label}"`).toBe(
				'skip',
			);
		}
	});

	it('skips a comment on an unlabelled closed issue', () => {
		expect(
			route(
				{ action: 'comment', issueState: 'closed', issueLabels: [] },
				labels,
			).type,
		).toBe('skip');
	});

	it('reports being closed as the reason, not the label', () => {
		const action = route(
			{
				action: 'comment',
				issueState: 'closed',
				issueLabels: ['triage: fix pending'],
			},
			labels,
		);
		expect(action).toEqual({ type: 'skip', reason: 'The issue is closed.' });
	});

	it('still cleans up the fix branch when the close itself is the event', () => {
		// The gate must not swallow the one action that only makes sense on a
		// closed issue.
		expect(
			route(
				{
					action: 'closed',
					issueState: 'closed',
					issueLabels: ['triage: fix pending'],
				},
				labels,
			),
		).toEqual({ type: 'cleanup' });
	});

	it('skips a reopen delivery for an issue that is closed again', () => {
		// The delivery says what happened; the state says what is true now.
		expect(
			route(
				{ action: 'reopened', issueState: 'closed', issueLabels: [] },
				labels,
			).type,
		).toBe('skip');
	});
});

describe('issue state normalization', () => {
	it('recognizes closed regardless of case or padding', () => {
		for (const state of ['closed', 'CLOSED', 'Closed', ' closed ']) {
			expect(normalizeIssueState(state)).toBe('closed');
		}
	});

	it('treats open and anything unrecognized as open', () => {
		// Failing open keeps triage running on a surprise value, rather than
		// silently switching it off for every issue in the repository.
		for (const state of ['open', 'OPEN', '', 'locked']) {
			expect(normalizeIssueState(state)).toBe('open');
		}
	});
});
