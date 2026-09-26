/**
 * What the code author persona writes to the pull request conversation: one
 * status comment carrying its ownership state (updated in place), and one
 * comment per feedback round. Model-authored text is contained so it can't
 * inject markup — in particular, it can't forge the state marker.
 */

import { personaSignature } from '../personas/personas.ts';
import { containModelMarkdown } from '../review/diff.ts';
import type { AuthorResult, AuthorState } from './contracts.ts';
import { AUTHOR_STATUS_MARKER, formatAuthorStateMarker } from './feedback.ts';

export const AUTHOR_DISCLOSURE =
	'These changes were made by an LLM. They may be wrong; review them like any other contribution.';

export type AuthorStatus =
	| { kind: 'idle' }
	| { kind: 'working'; round: number }
	| { kind: 'parked' }
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
		`Factory's code author persona addresses review feedback from maintainers and failing checks on this branch, pushing follow-up commits and replying to review threads. It never merges. Unassign **${login}** to take the pull request back; reassign it to start a fresh budget.`,
		'',
		`**Rounds used:** ${state.round} of ${maxRounds}`,
	];
	switch (status.kind) {
		case 'working':
			lines.push(`**Status:** working on round ${status.round}…`);
			break;
		case 'parked':
			lines.push(
				`**Status:** stopped — the round budget is used up. A maintainer needs to take it from here, or reassign **${login}** to continue.`,
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
}): string {
	const { result, push } = input;
	const lines = [
		`**Round ${input.round} of ${input.maxRounds}**`,
		'',
		containModelMarkdown(result.summary.trim()),
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
			`Replied to ${input.replies} review thread(s), resolved ${input.resolved}.`,
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

export function formatThreadReply(login: string, body: string): string {
	return `${containModelMarkdown(body.trim())}\n\n${personaSignature(login)}`;
}
