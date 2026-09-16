/**
 * Failure-state bookkeeping. Failed triage runs post a marked comment; the
 * number of marker comments on the issue is the retry counter. The state
 * lives in GitHub itself, so it survives anything and maintainers can clear
 * it by removing the `failed` label / deleting the comments.
 */

import type { IssueDetails } from '../github/issues.ts';

export const MAX_TRIAGE_FAILURES = 3;
export const TRIAGE_FAILURE_MARKER = '<!-- factory:triage-failed -->';

/**
 * Render an error before it crosses a Workflow step boundary. Cloudflare
 * serializes step failures down to a name and message, so an Error.cause left
 * attached to AgentRunError would otherwise disappear before triage records
 * the failure on GitHub.
 */
export function formatErrorWithCauses(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;

	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			parts.push(`${current.name}: ${current.message}`);
			current = current.cause;
			continue;
		}
		if (typeof current === 'object') {
			const record = current as Record<string, unknown>;
			const name = typeof record.name === 'string' ? record.name : 'Error';
			const message =
				typeof record.message === 'string'
					? record.message
					: JSON.stringify(record);
			parts.push(`${name}: ${message}`);
			current = record.cause;
			continue;
		}
		parts.push(String(current));
		break;
	}

	return parts.join('\nCaused by: ');
}

export function countTriageFailures(issue: IssueDetails): number {
	return issue.comments.filter(
		(comment) =>
			comment.authorIsBot && comment.body.includes(TRIAGE_FAILURE_MARKER),
	).length;
}

export function formatFailureComment(
	errorMessage: string,
	attempt: number,
): string {
	const retryMessage =
		attempt >= MAX_TRIAGE_FAILURES
			? 'This was the final automatic triage attempt. I will not retry this issue again unless a maintainer clears the failure state manually.'
			: 'I can retry if a new comment provides more information or asks me to try again.';

	return `${TRIAGE_FAILURE_MARKER}
Triage failed unexpectedly (attempt ${attempt} of ${MAX_TRIAGE_FAILURES}).

${retryMessage}

Error:

\`\`\`
${errorMessage}
\`\`\``;
}
