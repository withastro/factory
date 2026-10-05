/**
 * What the code author persona writes to the pull request conversation: one
 * status comment carrying its ownership state (updated in place), and one
 * comment per feedback round. Model-authored text is contained so it can't
 * inject markup — in particular, it can't forge the state marker.
 */

import {
	AUTHOR_DECLINED_MARKER,
	personaSignature,
} from '../personas/personas.ts';
import { containModelMarkdown } from '../review/markdown.ts';
import type { AuthorResult, AuthorState } from './contracts.ts';
import { AUTHOR_STATUS_MARKER, formatAuthorStateMarker } from './feedback.ts';

export const AUTHOR_DISCLOSURE =
	'These changes were made by an LLM. They may be wrong; review them like any other contribution.';

export type AuthorStatus =
	| { kind: 'idle' }
	| { kind: 'working'; round: number }
	| { kind: 'handed-off' }
	| { kind: 'failed'; round: number; reason: string };

export function formatAuthorStatusComment(input: {
	login: string;
	maxRounds: number;
	state: AuthorState;
	status: AuthorStatus;
}): string {
	const { login, maxRounds, state, status } = input;
	const lines = [
		`### ${login} owns this pull request`,
		'',
		`Factory's code author persona works on this branch when a maintainer or Factory's reviewer requests changes, or when checks fail: it pushes follow-up commits, replies to review threads, and asks for another review. It never merges. Unassign **${login}** to take the pull request back; reassign it to start a fresh budget.`,
		'',
		`**Rounds used:** ${state.round} of ${maxRounds}`,
	];
	switch (status.kind) {
		case 'working':
			lines.push(`**Status:** working on round ${status.round}…`);
			break;
		case 'handed-off':
			lines.push(
				`**Status:** handed off — the round budget is used up and **${login}** unassigned itself. A maintainer needs to take it from here, or reassign **${login}** to continue with a fresh budget.`,
			);
			break;
		case 'failed':
			lines.push(
				`**Status:** round ${status.round} failed and will be retried on the next feedback.`,
				'',
				'<details><summary>Error</summary>',
				'',
				'```',
				status.reason.replaceAll('```', "'''").slice(0, 3_000),
				'```',
				'',
				'</details>',
			);
			break;
		case 'idle':
			lines.push('**Status:** waiting for feedback.');
			break;
	}
	lines.push(
		'',
		personaSignature(login),
		AUTHOR_STATUS_MARKER,
		formatAuthorStateMarker(state),
	);
	return lines.join('\n');
}

export function formatAuthorRoundComment(input: {
	login: string;
	round: number;
	maxRounds: number;
	result: AuthorResult;
	push:
		| { kind: 'pushed'; sha: string; url: string }
		| { kind: 'unchanged' }
		| { kind: 'failed'; detail: string };
	replies: number;
	resolved: number;
	declined: number;
	/** Whose review was requested again after this round. */
	reviewersRequested: readonly string[];
}): string {
	const { result, push } = input;
	const heading =
		push.kind === 'pushed'
			? 'applied the requested changes'
			: push.kind === 'unchanged'
				? 'responded without code changes'
				: 'could not push its changes';
	const lines = [
		`**Round ${input.round} of ${input.maxRounds}: ${heading}**`,
		'',
		containModelMarkdown(result.summary.trim(), { unwrapPlainFence: true }),
		'',
	];
	switch (push.kind) {
		case 'pushed':
			lines.push(`Pushed [\`${push.sha.slice(0, 12)}\`](${push.url}).`);
			break;
		case 'unchanged':
			lines.push('No code changes this round.');
			break;
		case 'failed':
			lines.push(
				`The changes could not be pushed, so no review threads were replied to or resolved: ${containModelMarkdown(push.detail)}`,
			);
			break;
	}
	if (input.replies > 0) {
		lines.push(
			`Replied to ${input.replies} review thread(s), resolved ${input.resolved}${input.declined > 0 ? `, disagreed with ${input.declined}` : ''}.`,
		);
	}
	if (input.reviewersRequested.length > 0) {
		lines.push(
			`Asked ${input.reviewersRequested.map((login) => `**${login}**`).join(', ')} to review again.`,
		);
	}
	if (result.needsHuman) {
		lines.push(
			'',
			'> [!IMPORTANT]',
			`> **A maintainer decision is needed:** ${containModelMarkdown(result.needsHuman.trim()).replaceAll('\n', '\n> ')}`,
		);
	}
	lines.push('', `*${AUTHOR_DISCLOSURE}*`, personaSignature(input.login));
	return lines.join('\n');
}

export function formatThreadReply(
	login: string,
	body: string,
	declined = false,
): string {
	const reply = `${containModelMarkdown(body.trim())}\n\n${personaSignature(login)}`;
	// Contained model text can't contain `<`, so the marker can't be forged
	// from the reply body.
	return declined ? `${reply}\n${AUTHOR_DECLINED_MARKER}` : reply;
}

/** Posted when the round budget runs out and the persona steps away. */
export function formatAuthorHandoffComment(input: {
	login: string;
	maxRounds: number;
}): string {
	return [
		`### ${input.login} is handing this pull request to a human`,
		'',
		`All ${input.maxRounds} rounds are used and changes are still being requested, so **${input.login}** has unassigned itself and made no further changes. A maintainer needs to take it from here, or reassign **${input.login}** for a fresh budget.`,
		'',
		'An outstanding "changes requested" review may still block merging until it is dismissed or the reviewer approves.',
		'',
		personaSignature(input.login),
	].join('\n');
}
