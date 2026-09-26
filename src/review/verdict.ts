/**
 * The reviewer persona's verdict: whether a review approves, requests
 * changes, or declares a stand-still that needs a human.
 *
 * Severities are configured most severe first. Every severity except the
 * least severe blocks approval, so with the defaults (critical, high,
 * medium, low) only `low` findings can ride along on an approval.
 *
 * Findings from earlier reviews that are still unresolved keep blocking with
 * the severity they were published with. The author persona can answer such
 * a finding by declining it; if the reviewer then still stands by it, the two
 * personas disagree and neither can move the pull request forward.
 */

import type { Finding, UnresolvedReviewThread } from './contracts.ts';

export type ReviewVerdict =
	| { kind: 'approve' }
	| { kind: 'request-changes' }
	/** Every blocking finding left is one the author persona has declined. */
	| { kind: 'stand-still'; disputed: UnresolvedReviewThread[] };

export function isBlockingSeverity(
	severity: string | null | undefined,
	severities: readonly string[],
): boolean {
	// A finding whose severity can't be read is treated as blocking.
	if (!severity) return true;
	const index = severities.findIndex(
		(value) => value.toLowerCase() === severity.toLowerCase(),
	);
	if (index === -1) return true;
	return severities.length > 1 && index < severities.length - 1;
}

export function decideReviewVerdict(input: {
	findings: readonly Pick<Finding, 'severity'>[];
	severities: readonly string[];
	/** Unresolved Factory threads the reviewer was asked to reassess. */
	threads: readonly UnresolvedReviewThread[];
	/** The threads the reviewer judged addressed (they get resolved). */
	addressedThreadIds: readonly string[];
}): ReviewVerdict {
	const blocking = (severity: string | null | undefined) =>
		isBlockingSeverity(severity, input.severities);
	const addressed = new Set(input.addressedThreadIds);

	const newBlocking = input.findings.filter((finding) =>
		blocking(finding.severity),
	);
	const standing = input.threads.filter(
		(thread) => !addressed.has(thread.threadId) && blocking(thread.severity),
	);

	if (newBlocking.length === 0 && standing.length === 0) {
		return { kind: 'approve' };
	}
	if (
		newBlocking.length === 0 &&
		standing.every((thread) => thread.authorDisputed === true)
	) {
		return { kind: 'stand-still', disputed: standing };
	}
	return { kind: 'request-changes' };
}

/**
 * Hidden marker on a persona review naming its verdict. The review's GitHub
 * state carries the verdict too, except where GitHub refuses it: an App
 * can't approve or request changes on a pull request it opened itself (every
 * triage fix), so there the review is posted as a comment and this marker is
 * what the author persona acts on. Only trusted when this App wrote it.
 */
export function verdictMarker(kind: ReviewVerdict['kind']): string {
	return `<!-- factory-review-verdict:${kind} -->`;
}

export const CHANGES_REQUESTED_VERDICT_MARKER =
	verdictMarker('request-changes');

/** The visible verdict line at the top of a persona review. */
export function formatVerdictNotice(
	verdict: ReviewVerdict,
	options: { fallback: boolean },
): string {
	const lines: string[] = [];
	switch (verdict.kind) {
		case 'approve':
			lines.push('**Verdict: approved.** No blocking findings remain.');
			break;
		case 'request-changes':
			lines.push('**Verdict: changes requested.**');
			break;
		case 'stand-still':
			lines.push(
				'**Verdict: stand-still. A human needs to take over.**',
				'',
				'The author disagreed with these findings and the reviewer still stands by them, so the personas have stopped here:',
				'',
				...verdict.disputed.map(
					(thread) =>
						`- [${thread.path}${thread.line ? `:${thread.line}` : ''}](${thread.url})`,
				),
			);
			break;
	}
	if (options.fallback && verdict.kind !== 'stand-still') {
		lines.push(
			'',
			`<sub>GitHub doesn't let Factory ${verdict.kind === 'approve' ? 'approve' : 'request changes on'} a pull request it opened, so this verdict is recorded as a comment.</sub>`,
		);
	}
	return lines.join('\n');
}
