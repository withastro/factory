/**
 * Publishing a merge-risk assessment: exactly one comment per pull request,
 * found and updated by a marker on every re-assessment rather than piling up
 * a new comment each time (the same pattern triage uses for its evolving
 * status comment).
 */

import type { InstallationClient } from '../github/client.ts';
import { upsertIssueComment } from '../github/issues.ts';
import type { MergeRiskCategory, MergeRiskResult } from './contracts.ts';
import { type MergeRiskLevel, scoreMergeRisk } from './scoring.ts';

export const MERGE_RISK_MARKER = '<!-- factory:merge-risk -->';

const LEVEL_LABEL: Record<MergeRiskLevel, string> = {
	low: 'Low',
	medium: 'Medium',
	high: 'High',
};

const LEVEL_ICON: Record<MergeRiskLevel, string> = {
	low: '🟢',
	medium: '🟡',
	high: '🔴',
};

const VERDICT_ICON: Record<MergeRiskResult['alignment']['verdict'], string> = {
	good: '✅',
	ok: '👀',
	poor: '⚠️',
};

const CATEGORY_LABEL: Record<MergeRiskCategory, string> = {
	alignment: 'Alignment',
	impact: 'Impact',
	verification: 'Verification',
	rollbackCost: 'Rollback cost',
	errorDetection: 'Error detection',
};

// Impact and verification drive the score most; lead with them.
const CATEGORY_ORDER: MergeRiskCategory[] = [
	'impact',
	'verification',
	'rollbackCost',
	'alignment',
	'errorDetection',
];

export function formatMergeRiskComment(
	result: MergeRiskResult,
	headSha: string,
): string {
	const { level } = scoreMergeRisk(result);
	const lines = [
		`${LEVEL_ICON[level]} **Merge risk: ${LEVEL_LABEL[level]}**`,
		'',
	];

	for (const category of CATEGORY_ORDER) {
		const entry = result[category];
		lines.push(
			`**${CATEGORY_LABEL[category]} (${VERDICT_ICON[entry.verdict]}):**`,
		);
		if (entry.notes.length === 0) {
			lines.push('No gaps noted.');
		} else {
			lines.push(...entry.notes.map((note) => `- ${note}`));
		}
		lines.push('');
	}

	lines.push(result.summary.trim(), '');
	lines.push(
		`<sub>Assessed at commit \`${headSha.slice(0, 7)}\` by Factory, an LLM-based tool, after automated review. This is a risk signal, not a decision — it never blocks or approves a merge.</sub>`,
	);
	return lines.join('\n').trim();
}

export async function publishMergeRiskComment(
	client: InstallationClient,
	input: { owner: string; repo: string; pullNumber: number },
	result: MergeRiskResult,
	headSha: string,
): Promise<{ commentId: number; level: MergeRiskLevel }> {
	const { level } = scoreMergeRisk(result);
	const body = formatMergeRiskComment(result, headSha);
	const commentId = await upsertIssueComment(
		client,
		input.owner,
		input.repo,
		input.pullNumber,
		MERGE_RISK_MARKER,
		body,
	);
	return { commentId, level };
}
