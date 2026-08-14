/**
 * Maps a finished triage pipeline result to the issue's next state label.
 *
 * When a pull request was opened directly (autoPrOnFix), the issue is
 * considered verified. Otherwise a fix goes to "fix pending" when a preview
 * release is available for the reporter to test, or falls back to
 * "needs triage" when there is nothing for them to try.
 */

import type { TriagePipelineResult } from './pipeline-contracts.ts';
import type { TriageLabelConfig } from './labels.ts';

export function resolveTriageLabel(
	result: TriagePipelineResult,
	labels: TriageLabelConfig,
	options: { previewReleaseAvailable: boolean; prOpened: boolean },
): string {
	if (result.skipped) {
		if (result.skippedReason === 'not-actionable') return labels.notActionable;
		if (result.skippedReason === 'missing-details') return labels.needsReproduction;
		return labels.skipped;
	}
	if (!result.reproducible) return labels.unableToReproduce;
	if (result.fixed) {
		if (options.prOpened) return labels.fixVerified;
		return options.previewReleaseAvailable ? labels.fixPending : labels.needsTriage;
	}
	return labels.unableToFix;
}
