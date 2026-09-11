import { describe, expect, it } from 'vitest';
import {
	adversaryBranchName,
	blueQualifies,
	type PurpleTeamResult,
} from '../src/adversary/contracts.ts';

const result: PurpleTeamResult = {
	changeType: 'bug-fix',
	contract: [
		{ requirement: 'Preserve the documented behavior.', source: 'README' },
	],
	qualification: {
		sameProblem: true,
		materiallyDifferent: true,
		verified: true,
		safeguardsPreserved: true,
		scopeAppropriate: true,
	},
	comparisons: [],
	recommendation: 'either',
	summary: 'Both solutions satisfy the contract.',
	decisiveCriteria: ['Regression coverage'],
	uncertainties: [],
	confidence: 'high',
};

describe('adversary contracts', () => {
	it('requires every purple qualification criterion', () => {
		expect(blueQualifies(result)).toBe(true);
		expect(
			blueQualifies({
				...result,
				qualification: { ...result.qualification, verified: false },
			}),
		).toBe(false);
	});

	it('binds alternative branches to the pull request and red head', () => {
		expect(adversaryBranchName(42, 'a'.repeat(40))).toBe(
			'factory/adversary/pr-42-aaaaaaaaaaaa',
		);
	});
});
