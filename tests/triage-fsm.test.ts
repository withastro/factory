import { describe, expect, it } from 'vitest';
import { route } from '../src/triage/fsm.ts';
import { DEFAULT_TRIAGE_LABELS, type TriageLabelConfig } from '../src/triage/labels.ts';

const labels = DEFAULT_TRIAGE_LABELS;

describe('triage FSM', () => {
	it('routes opened issue to triage', () => {
		expect(route({ action: 'opened', issueLabels: [] }, labels)).toEqual({ type: 'triage' });
	});

	it('routes reopened issue to triage', () => {
		expect(route({ action: 'reopened', issueLabels: [] }, labels)).toEqual({ type: 'triage' });
	});

	it('routes closed issue to cleanup', () => {
		expect(route({ action: 'closed', issueLabels: [] }, labels)).toEqual({ type: 'cleanup' });
	});

	it('routes comment on fix-pending to verify-fix', () => {
		expect(
			route({ action: 'comment', issueLabels: ['triage: fix pending'] }, labels),
		).toEqual({ type: 'verify-fix' });
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
			expect(route({ action: 'comment', issueLabels: [label] }, labels)).toEqual({
				type: 'retriage',
				currentLabel: label,
			});
		});
	}

	for (const label of ['triage: fix verified', 'triage: not actionable', 'triage: skipped']) {
		it(`skips comment on terminal label "${label}"`, () => {
			expect(route({ action: 'comment', issueLabels: [label] }, labels).type).toBe('skip');
		});
	}

	it('skips comment on issue with no triage label', () => {
		expect(
			route({ action: 'comment', issueLabels: ['bug', 'pkg: astro'] }, labels).type,
		).toBe('skip');
	});

	it('works with custom label names', () => {
		const customLabels: TriageLabelConfig = {
			...labels,
			fixPending: 'awaiting-confirmation',
			fixVerified: 'confirmed-fix',
		};
		expect(
			route({ action: 'comment', issueLabels: ['awaiting-confirmation'] }, customLabels),
		).toEqual({ type: 'verify-fix' });
	});
});
