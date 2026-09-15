import { describe, expect, it } from 'vitest';
import {
	adversaryBranchName,
	adversarySandboxId,
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

	it('builds bounded DNS-label-safe sandbox ids', () => {
		const input = {
			repositoryId: 348060227,
			pullNumber: 17736,
			deliveryId: '560CE130_B10A 11F1/862F/F478BF7BDFDE',
		};

		for (const team of ['blue', 'purple', 'publisher'] as const) {
			const id = adversarySandboxId(team, input);
			expect(id.length).toBeLessThanOrEqual(63);
			expect(id).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
		}
	});
});
