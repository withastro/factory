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
	/** The issue's state *now*, which is not implied by `action`. */
	issueState: 'open' | 'closed';
	issueLabels: string[];
}

export function route(
	event: TriageFsmEvent,
	labels: TriageLabelConfig,
): TriageAction {
	// Issue closed → clean up the fix branch. Checked before the state gate
	// below, which this action would otherwise always trip.
	if (event.action === 'closed') {
		return { type: 'cleanup' };
	}

	// Everything past this point acts *on* the issue: running the pipeline,
	// force-pushing a fix branch, opening a pull request. A closed issue has
	// been decided, so none of that is wanted — a comment on one used to run
	// the FixVerifier or the RetriageJudge anyway, and a re-triage could push a
	// fresh fix branch and open a pull request for an issue a maintainer had
	// already closed.
	//
	// This is a separate question from `action`, which only says what just
	// happened: a delivery for a reopened issue can still find it closed again
	// by the time the workflow reads it, and comment deliveries carry no state
	// at all.
	if (event.issueState === 'closed') {
		return { type: 'skip', reason: 'The issue is closed.' };
	}

	// Issue opened or reopened → run triage.
	if (event.action === 'opened' || event.action === 'reopened') {
		return { type: 'triage' };
	}

	// Comment created → route based on the current label.
	const current = currentTriageLabel(event.issueLabels, labels);

	// A comment can recover a workflow that stopped before recording a final
	// state. Comments queued during a healthy run are routed against its fresh
	// final label after the per-issue coordinator releases them.
	if (current === labels.inProgress) {
		return { type: 'triage' };
	}

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
