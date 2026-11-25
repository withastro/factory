/**
 * What the code author persona writes to the pull request conversation: one
 * status comment carrying its ownership state (updated in place), and one
 * comment per feedback round. Model-authored text is contained so it can't
 * inject markup — in particular, it can't forge the state marker.
 *
 * Both are kept short on purpose. A long review loop is otherwise a wall of
 * agent text that buries the human comments, so the visible part of each
 * comment is a headline and one line of facts, and everything else is folded
 * into a details block.
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
	const owner = `**${login}** owns this pull request`;
	const rounds = `${state.round} of ${maxRounds} rounds used`;
	const lines: string[] = [];
	switch (status.kind) {
		case 'working':
			lines.push(`${owner} · working on round ${status.round} · ${rounds}`);
			break;
		case 'handed-off':
			lines.push(
				`**${login}** handed this pull request to a human · ${rounds}`,
				'',
				`The round budget is used up and **${login}** unassigned itself. A maintainer needs to take it from here, or reassign **${login}** to continue with a fresh budget.`,
			);
			break;
		case 'failed':
			lines.push(
				`${owner} · round ${status.round} failed and will be retried on the next feedback · ${rounds}`,
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
			lines.push(`${owner} · waiting for feedback · ${rounds}`);
			break;
	}
	lines.push(
		'',
		'<details><summary>How this works</summary>',
		'',
		`Factory's code author persona works on this branch when a maintainer or Factory's reviewer requests changes, or when checks fail: it pushes follow-up commits, replies to review threads, and asks for another review. Comments alone never start a round, and it never merges. Unassign **${login}** to take the pull request back; reassign it to start a fresh budget.`,
		'',
		'</details>',
		'',
		personaSignature(login),
		AUTHOR_STATUS_MARKER,
		formatAuthorStateMarker(state),
	);
	return lines.join('\n');
}

/** What started a round: requested changes, failing checks, or both. */
export interface AuthorRoundTrigger {
	/** Who requested changes; the reviewer persona by its persona login. */
	changeRequests: readonly string[];
	/** Names of the failing checks the round looked at. */
	failingChecks: readonly string[];
}

/**
 * One round's summary: a single line saying what it did, why it ran, and who
 * it asked to review, with the agent's own write-up folded into a details
 * block. Only a call for a maintainer decision stays expanded. Round numbers
 * are left out on purpose; the status comment tracks the budget.
 */
export function formatAuthorRoundComment(input: {
	login: string;
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
	/** Absent for rounds loaded before the trigger was recorded. */
	trigger?: AuthorRoundTrigger;
}): string {
	const { result, push } = input;
	const heading =
		push.kind === 'pushed'
			? `**Pushed [\`${push.sha.slice(0, 7)}\`](${push.url})**`
			: push.kind === 'unchanged'
				? '**No code changes**'
				: '**Could not push changes**';

	const facts: string[] = [heading];
	const reason = formatTrigger(input.trigger);
	if (reason) facts.push(reason);
	if (input.replies > 0) {
		const outcome = [
			`${input.resolved} resolved`,
			...(input.declined > 0 ? [`${input.declined} disagreed`] : []),
		].join(', ');
		facts.push(`replied to ${plural(input.replies, 'thread')} (${outcome})`);
	}
	if (input.reviewersRequested.length > 0) {
		facts.push(`asked ${bold(input.reviewersRequested)} to review again`);
	}

	const lines = [facts.join(' · ')];
	if (push.kind === 'failed') {
		lines.push(
			'',
			`The changes could not be pushed, so no review threads were replied to or resolved: ${containModelMarkdown(push.detail)}`,
		);
	}
	if (result.needsHuman) {
		lines.push(
			'',
			'> [!IMPORTANT]',
			`> **A maintainer decision is needed:** ${containModelMarkdown(result.needsHuman.trim()).replaceAll('\n', '\n> ')}`,
		);
	}
	lines.push(
		'',
		`<details><summary>${push.kind === 'unchanged' ? 'Why nothing changed' : 'What changed'}</summary>`,
		'',
		containModelMarkdown(result.summary.trim(), { unwrapPlainFence: true }),
		'',
		'</details>',
		'',
		`<sub>— ${input.login} (Factory persona) · ${AUTHOR_DISCLOSURE}</sub>`,
	);
	return lines.join('\n');
}

function formatTrigger(trigger: AuthorRoundTrigger | undefined): string | null {
	if (!trigger) return null;
	const parts: string[] = [];
	if (trigger.changeRequests.length > 0) {
		parts.push(`changes requested by ${bold(trigger.changeRequests)}`);
	}
	if (trigger.failingChecks.length > 0) {
		const noun = trigger.failingChecks.length === 1 ? 'check' : 'checks';
		const names = trigger.failingChecks.map((name) =>
			containModelMarkdown(name),
		);
		parts.push(`failing ${noun} ${bold(names)}`);
	}
	return parts.length > 0 ? `ran for ${parts.join(' and ')}` : null;
}

function bold(values: readonly string[]): string {
	return values.map((value) => `**${value}**`).join(', ');
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
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
