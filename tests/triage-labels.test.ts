import { describe, expect, it } from 'vitest';
import {
	allTriageLabels,
	currentTriageLabel,
	DEFAULT_TRIAGE_LABELS,
	labelAppearance,
	retriageableLabels,
	TRIAGE_LABEL_APPEARANCE,
	terminalLabels,
} from '../src/triage/labels.ts';

describe('triage labels', () => {
	it('keeps the state label sets disjoint and complete', () => {
		const all = allTriageLabels(DEFAULT_TRIAGE_LABELS);
		expect(all).toHaveLength(11);
		expect(all).not.toContain(DEFAULT_TRIAGE_LABELS.prFixVerified);

		const retriageable = retriageableLabels(DEFAULT_TRIAGE_LABELS);
		const terminal = terminalLabels(DEFAULT_TRIAGE_LABELS);
		for (const label of retriageable) expect(terminal).not.toContain(label);
		// fixPending and inProgress have dedicated FSM routes.
		expect([...retriageable, ...terminal]).toHaveLength(9);
		expect(all).toEqual(
			expect.arrayContaining([
				DEFAULT_TRIAGE_LABELS.fixPending,
				DEFAULT_TRIAGE_LABELS.inProgress,
			]),
		);
	});

	it('finds the current triage label among unrelated labels', () => {
		expect(
			currentTriageLabel(
				['bug', 'triage: fix pending', 'pkg: astro'],
				DEFAULT_TRIAGE_LABELS,
			),
		).toBe('triage: fix pending');
		expect(currentTriageLabel(['bug'], DEFAULT_TRIAGE_LABELS)).toBeNull();
	});

	it('resolves appearances for renamed labels', () => {
		const custom = {
			...DEFAULT_TRIAGE_LABELS,
			fixPending: 'awaiting-confirmation',
		};
		expect(labelAppearance('awaiting-confirmation', custom)).toEqual(
			TRIAGE_LABEL_APPEARANCE.fixPending,
		);
		expect(labelAppearance('unrelated', custom)).toBeUndefined();
	});

	it('defines an appearance for every label so creation always has colors', () => {
		for (const key of Object.keys(DEFAULT_TRIAGE_LABELS)) {
			const appearance =
				TRIAGE_LABEL_APPEARANCE[key as keyof typeof DEFAULT_TRIAGE_LABELS];
			expect(appearance.color).toMatch(/^[0-9a-f]{6}$/);
			expect(appearance.description.length).toBeGreaterThan(0);
		}
	});
});
