/**
 * Where PR safety results go: the full record to the private R2 bucket, and
 * an alert to the private Discord security channel when a maintainer needs
 * to look. Nothing here is posted to GitHub.
 *
 * Pull request text and model output are untrusted. Alert text is flattened,
 * stripped of formatting that could break out of the message, and
 * truncated; the Discord client disables mentions.
 */

import { DISCORD_MESSAGE_LIMIT, truncate } from '../discord/client.ts';
import type {
	PrSafetyResult,
	PrSafetyVerdict,
	PrSafetyWorkflowParams,
} from './contracts.ts';
import type { SignalReport, SignalSeverity } from './signals.ts';
import { escapeInvisible } from './signals.ts';

const VERDICT_LABELS: Record<PrSafetyVerdict, string> = {
	CLEAN: 'Clean',
	SUSPICIOUS: 'Suspicious',
	MALICIOUS: 'Malicious',
	INCOMPLETE: 'Incomplete',
};

const VERDICT_ICONS: Record<PrSafetyVerdict, string> = {
	CLEAN: '🟢',
	SUSPICIOUS: '🟠',
	MALICIOUS: '🔴',
	INCOMPLETE: '⚪',
};

/**
 * Alert on anything a maintainer must look at. An incomplete review alerts
 * only when the rules found something serious, since a pull request that
 * makes the reviewer fail is otherwise invisible.
 */
export function shouldAlert(
	verdict: PrSafetyVerdict,
	totals: Record<SignalSeverity, number>,
): boolean {
	if (verdict === 'SUSPICIOUS' || verdict === 'MALICIOUS') return true;
	return verdict === 'INCOMPLETE' && totals.high > 0;
}

export function formatAlert(
	input: Pick<
		PrSafetyWorkflowParams,
		| 'owner'
		| 'repo'
		| 'pullNumber'
		| 'pullUrl'
		| 'pullTitle'
		| 'author'
		| 'authorAssociation'
	>,
	result: Pick<PrSafetyResult, 'verdict' | 'reviewedSha' | 'summary'>,
	totals: Record<SignalSeverity, number>,
): string {
	const lines = [
		`${VERDICT_ICONS[result.verdict]} **PR safety: ${VERDICT_LABELS[result.verdict]}** in \`${plain(`${input.owner}/${input.repo}`)}\` [#${input.pullNumber}](<${input.pullUrl}>)`,
		`> ${truncate(plain(input.pullTitle) || '(no title)', 200)}`,
		`By ${plain(input.author)} (${plain(input.authorAssociation)}) · commit ${result.reviewedSha.slice(0, 7)} · rule signals: ${totals.high} high, ${totals.medium} medium, ${totals.info} info`,
		'',
		truncate(plain(result.summary), 1_000),
		'',
		'The full report is attached. Nothing has been posted to GitHub.',
	];
	return truncate(lines.join('\n'), DISCORD_MESSAGE_LIMIT);
}

/** The private record: the model's report followed by the rule signals. */
export function formatPrivateReport(
	input: Pick<
		PrSafetyWorkflowParams,
		'owner' | 'repo' | 'pullNumber' | 'pullUrl' | 'author' | 'authorAssociation'
	>,
	result: PrSafetyResult,
	signals: SignalReport | undefined,
): string {
	const sections = [
		`# PR safety: ${input.owner}/${input.repo}#${input.pullNumber}`,
		'',
		`- Pull request: ${input.pullUrl}`,
		`- Author: ${input.author} (${input.authorAssociation})`,
		`- Reviewed commit: ${result.reviewedSha}`,
		`- Verdict: ${result.verdict}`,
		'',
		'## Summary',
		'',
		result.summary,
		'',
		'## Report',
		'',
		result.report,
		'',
		'## Rule signals',
		'',
	];
	if (!signals) {
		sections.push('Signals were not recorded.');
	} else if (signals.signals.length === 0) {
		sections.push('No rule signals.');
	} else {
		sections.push(
			`${signals.totals.high} high, ${signals.totals.medium} medium, ${signals.totals.info} info across ${signals.files} files${signals.truncated ? ' (truncated)' : ''}.`,
			'',
			'| Severity | Rule | Location | Detail |',
			'| --- | --- | --- | --- |',
			...signals.signals.map((signal) => {
				const location = signal.path
					? `${signal.path}${signal.line ? `:${signal.line}` : ''}${signal.occurrences > 1 ? ` (×${signal.occurrences})` : ''}`
					: 'pull request text';
				return `| ${signal.severity} | ${signal.rule} | ${cell(location)} | ${cell(signal.detail)}${signal.excerpt ? `<br>\`${cell(signal.excerpt).replaceAll('`', "'")}\`` : ''} |`;
			}),
		);
	}
	return `${sections.join('\n')}\n`;
}

export async function storePrivatePrSafetyReport(
	bucket: R2Bucket,
	input: PrSafetyWorkflowParams,
	result: PrSafetyResult,
	report: string,
): Promise<string> {
	const key = `pr-safety/${input.owner}/${input.repo}/${input.pullNumber}/${input.headSha}/${input.deliveryId}-${result.verdict.toLowerCase()}.md`;
	await bucket.put(key, report, {
		httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
		customMetadata: {
			deliveryId: input.deliveryId,
			verdict: result.verdict,
			reviewedSha: result.reviewedSha,
			pullNumber: String(input.pullNumber),
			author: input.author,
		},
	});
	return key;
}

function plain(text: string): string {
	return escapeInvisible(
		text.replaceAll(/[\r\n]+/g, ' ').replaceAll(/[`[\]<>*_~|]/g, ''),
	).trim();
}

function cell(text: string): string {
	return text.replaceAll('|', '\\|').replaceAll(/[\r\n]+/g, ' ');
}
