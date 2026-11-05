/**
 * Deterministic scoring over the model's categorical verdicts. The model
 * never computes or reports the overall risk level itself — only trusted
 * workflow code turns five `good`/`ok`/`poor` verdicts into one auditable
 * low/medium/high label, the same way a review's verdict is decided from
 * structured findings rather than taken from the model's own words.
 *
 * Weights and thresholds mirror Warp's `merge-risk` skill
 * (https://github.com/warpdotdev/common-skills/blob/main/.agents/skills/merge-risk/SKILL.md).
 */

import type { MergeRiskCategory, MergeRiskResult } from './contracts.ts';

const WEIGHTS: Record<MergeRiskCategory, number> = {
	impact: 2,
	verification: 2,
	rollbackCost: 1.5,
	errorDetection: 1,
	alignment: 1,
};

const VERDICT_SCORE: Record<'good' | 'ok' | 'poor', number> = {
	good: 1,
	ok: 2,
	poor: 3,
};

export type MergeRiskLevel = 'low' | 'medium' | 'high';

export interface MergeRiskScore {
	score: number;
	level: MergeRiskLevel;
}

export function scoreMergeRisk(result: MergeRiskResult): MergeRiskScore {
	let weighted = 0;
	let totalWeight = 0;
	for (const category of Object.keys(WEIGHTS) as MergeRiskCategory[]) {
		const weight = WEIGHTS[category];
		weighted += VERDICT_SCORE[result[category].verdict] * weight;
		totalWeight += weight;
	}
	const score = weighted / totalWeight;
	const level: MergeRiskLevel =
		score >= 2.25 ? 'high' : score >= 1.5 ? 'medium' : 'low';
	return { score, level };
}
