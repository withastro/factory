import { describe, expect, it } from 'vitest';
import { DEFAULT_TRIAGE_LABELS } from '../src/triage/labels.ts';
import type { TriagePipelineResult } from '../src/triage/pipeline-contracts.ts';
import { resolveTriageLabel } from '../src/triage/resolve-label.ts';

const labels = DEFAULT_TRIAGE_LABELS;

function result(overrides: Partial<TriagePipelineResult> = {}): TriagePipelineResult {
	return {
		completedStage: 'fix',
		reproducible: true,
		skipped: false,
		skippedReason: null,
		verdict: 'bug',
		diagnosisConfidence: 'high',
		fixed: false,
		commitMessage: null,
		...overrides,
	};
}

const noExtras = { previewReleaseAvailable: false, prOpened: false };

describe('resolveTriageLabel', () => {
	it('maps skip reasons to their labels', () => {
		expect(
			resolveTriageLabel(result({ skipped: true, skippedReason: 'not-actionable' }), labels, noExtras),
		).toBe(labels.notActionable);
		expect(
			resolveTriageLabel(result({ skipped: true, skippedReason: 'missing-details' }), labels, noExtras),
		).toBe(labels.needsReproduction);
		expect(
			resolveTriageLabel(result({ skipped: true, skippedReason: 'host-specific' }), labels, noExtras),
		).toBe(labels.skipped);
	});

	it('maps reproduction and fix outcomes', () => {
		expect(resolveTriageLabel(result({ reproducible: false }), labels, noExtras)).toBe(
			labels.unableToReproduce,
		);
		expect(resolveTriageLabel(result({ fixed: false }), labels, noExtras)).toBe(
			labels.unableToFix,
		);
	});

	it('routes a fix by what the reporter can do next', () => {
		expect(
			resolveTriageLabel(result({ fixed: true }), labels, {
				previewReleaseAvailable: false,
				prOpened: true,
			}),
		).toBe(labels.fixVerified);
		expect(
			resolveTriageLabel(result({ fixed: true }), labels, {
				previewReleaseAvailable: true,
				prOpened: false,
			}),
		).toBe(labels.fixPending);
		// Fixed but nothing for the reporter to test: hand back to humans.
		expect(resolveTriageLabel(result({ fixed: true }), labels, noExtras)).toBe(
			labels.needsTriage,
		);
	});
});
