import { describe, expect, it } from 'vitest';
import { extractReviewResult } from '../src/workflow/result.ts';

describe('structured review result extraction', () => {
	it('returns the latest valid review write', () => {
		expect(
			extractReviewResult({
				review: [
					{ summary: 'Old result', findings: [] },
					{ summary: 'Final result', findings: [] },
				],
			}),
		).toEqual({ summary: 'Final result', findings: [] });
	});

	it('rejects missing or invalid review writes', () => {
		expect(() => extractReviewResult({})).toThrow('without a structured review result');
		expect(() => extractReviewResult({ review: [{ summary: '', findings: [] }] })).toThrow();
	});
});
