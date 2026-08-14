/**
 * Triage FSM. Decides which handler to run based on the GitHub event type and
 * the issue's current triage label. Ported from triagebot-action's router.
 *
 * Bot-authored comments are filtered out before events reach this function
 * (the webhook router drops comments whose author is a Bot account), so the
 * FSM only sees human activity.
 */

import {
	currentTriageLabel,
	retriageableLabels,
	type TriageLabelConfig,
} from './labels.ts';

export type TriageAction =
	| { type: 'triage' }
	| { type: 'verify-fix' }
	| { type: 'retriage'; currentLabel: string }
	| { type: 'cleanup' }
	| { type: 'skip'; reason: string };

export interface TriageFsmEvent {
	action: 'opened' | 'reopened' | 'closed' | 'comment';
	issueLabels: string[];
}

export function route(event: TriageFsmEvent, labels: TriageLabelConfig): TriageAction {
	// Issue opened or reopened → run triage.
	if (event.action === 'opened' || event.action === 'reopened') {
		return { type: 'triage' };
	}

	// Issue closed → clean up the fix branch.
	if (event.action === 'closed') {
		return { type: 'cleanup' };
	}

	// Comment created → route based on the current label.
	const current = currentTriageLabel(event.issueLabels, labels);

	// Fix pending → run fix verification.
	if (current === labels.fixPending) {
		return { type: 'verify-fix' };
	}

	// Re-triageable label → potentially re-triage.
	if (current !== null && retriageableLabels(labels).includes(current)) {
		return { type: 'retriage', currentLabel: current };
	}

	// Terminal label or no triage label → do nothing.
	return {
		type: 'skip',
		reason: current ? `Terminal label: ${current}` : 'No triage label on issue',
	};
}
