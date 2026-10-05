/**
 * How an advisory triage appears in Discord.
 *
 * A short announcement goes to the channel when the report arrives, and a
 * thread is started from it. The triage lands in the thread: a summary with
 * the full assessment, reporter reply, and fix brief attached as files, then
 * the reporter reply inline so a maintainer can copy it into the advisory.
 * When triage finishes, the announcement is edited to show the verdict.
 *
 * Report text is untrusted. It's quoted, truncated, and stripped of anything
 * that could break out of the formatting; the client disables mentions.
 */

import {
	DISCORD_MESSAGE_LIMIT,
	DISCORD_THREAD_NAME_LIMIT,
	type DiscordFile,
	splitMessage,
	truncate,
} from '../discord/client.ts';
import type { AdvisoryTriageResult, AdvisoryVerdict } from './contracts.ts';
import type { AdvisorySnapshot } from './github.ts';

export const VERDICT_LABELS: Record<AdvisoryVerdict, string> = {
	vulnerability: 'Vulnerability',
	'not-vulnerability': 'Not a vulnerability',
	duplicate: 'Duplicate',
	'needs-information': 'Needs information',
};

const VERDICT_ICONS: Record<AdvisoryVerdict, string> = {
	vulnerability: '🔴',
	'not-vulnerability': '🟢',
	duplicate: '⚪',
	'needs-information': '🟡',
};

export type AnnouncementStatus =
	| { kind: 'running' }
	| {
			kind: 'triaged';
			result: Pick<AdvisoryTriageResult, 'verdict' | 'confidence' | 'isBug'>;
	  }
	| { kind: 'failed' };

export function formatAnnouncement(
	repository: string,
	advisory: AdvisorySnapshot,
	status: AnnouncementStatus,
): string {
	const reporter = advisory.reporter
		? `@${plain(advisory.reporter)}`
		: 'unknown';
	const lines = [
		`🛡️ **New security report** in \`${plain(repository)}\`: [${advisory.ghsaId}](<${advisory.url}>)`,
		`> ${truncate(plain(advisory.summary), 300)}`,
		`Reported by ${reporter} · claimed severity: ${plain(advisory.severity ?? 'not specified')}`,
		formatStatusLine(status),
	];
	return truncate(lines.join('\n'), DISCORD_MESSAGE_LIMIT);
}

function formatStatusLine(status: AnnouncementStatus): string {
	switch (status.kind) {
		case 'running':
			return '⏳ Factory is triaging this report. Results will appear in the thread.';
		case 'failed':
			return '⚠️ Factory could not triage this report. Details are in the thread.';
		case 'triaged': {
			const { verdict, confidence, isBug } = status.result;
			const bug = verdict !== 'vulnerability' && isBug ? ' · real bug' : '';
			return `${VERDICT_ICONS[verdict]} Triage: **${VERDICT_LABELS[verdict]}** (${confidence} confidence${bug}). Details in the thread.`;
		}
	}
}

export function formatThreadName(advisory: AdvisorySnapshot): string {
	return truncate(
		`${advisory.ghsaId}: ${plain(advisory.summary)}`,
		DISCORD_THREAD_NAME_LIMIT,
	);
}

export interface TriageMessages {
	/** The first thread message, carrying the attachments. */
	summary: { content: string; files: DiscordFile[] };
	/** Follow-up thread messages: the reporter reply, ready to copy. */
	followUps: string[];
}

export function formatTriageMessages(
	advisory: AdvisorySnapshot,
	result: AdvisoryTriageResult,
): TriageMessages {
	const facts = [
		`${VERDICT_ICONS[result.verdict]} **${VERDICT_LABELS[result.verdict]}** · ${result.confidence} confidence`,
		`**${truncate(plain(result.title), 200)}**`,
		'',
		result.summary,
		'',
		`- Reproduction: ${reproductionLine(result)}`,
		result.verdict !== 'vulnerability'
			? `- Real bug worth fixing: ${result.isBug ? 'yes' : 'no'}`
			: undefined,
		result.duplicateOf?.length
			? `- Duplicate of: ${result.duplicateOf.join(', ')}`
			: undefined,
		result.severity
			? `- Suggested severity: ${result.severity.level}${result.severity.cvssVector ? ` (\`${result.severity.cvssVector}\`)` : ''}${result.severity.cwe ? ` · ${result.severity.cwe}` : ''}`
			: undefined,
		result.affectedPackages.length
			? `- Affected: ${result.affectedPackages
					.map(
						(entry) =>
							`\`${plain(entry.name)}\`${entry.vulnerableVersions ? ` ${plain(entry.vulnerableVersions)}` : ''}`,
					)
					.join(', ')}`
			: undefined,
		'',
		`Attached: the full assessment${result.fixBrief ? ', a fix brief for an agent to implement' : ''}, and the draft reply. The reply follows below. Review it before posting it on the [advisory](<${advisory.url}>).`,
	].filter((line): line is string => line !== undefined);

	const files: DiscordFile[] = [
		{ name: `${advisory.ghsaId}-assessment.md`, content: result.assessment },
		{
			name: `${advisory.ghsaId}-reporter-reply.md`,
			content: result.reporterReply,
		},
	];
	if (result.fixBrief) {
		files.push({
			name: `${advisory.ghsaId}-fix-brief.md`,
			content: result.fixBrief,
		});
	}

	return {
		summary: {
			content: truncate(facts.join('\n'), DISCORD_MESSAGE_LIMIT),
			files,
		},
		followUps: [
			'**Draft reply to the reporter**',
			...splitMessage(result.reporterReply),
		],
	};
}

export function formatFailureMessage(reason: string): string {
	return truncate(
		[
			'⚠️ **Triage failed.** The report still needs a human look.',
			'```',
			truncate(reason.replaceAll('```', "'''"), 1_500),
			'```',
		].join('\n'),
		DISCORD_MESSAGE_LIMIT,
	);
}

function reproductionLine(result: AdvisoryTriageResult): string {
	if (!result.reproduction.attempted) return 'not attempted';
	return result.reproduction.reproduced ? 'reproduced' : 'could not reproduce';
}

/**
 * Untrusted single-line text: no newlines, no markdown link or code
 * delimiters that could break out of the surrounding formatting.
 */
function plain(text: string): string {
	return text
		.replaceAll(/[\r\n]+/g, ' ')
		.replaceAll(/[`[\]<>]/g, '')
		.trim();
}
