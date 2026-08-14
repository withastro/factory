import { describe, expect, it } from 'vitest';
import { extractReviewResult } from '../src/review/result.ts';

describe('structured review result extraction', () => {
	const severities = ['blocker', 'advisory'];
	const areas = ['correctness', 'security'];

	it('returns the latest valid review write', () => {
		expect(
			extractReviewResult(
				{
					review: [
						{ summary: 'Old result', findings: [] },
						{ summary: 'Final result', findings: [] },
					],
				},
				severities,
				areas,
			),
		).toEqual({ summary: 'Final result', findings: [] });
	});

	it('rejects missing or invalid review writes', () => {
		expect(() => extractReviewResult({}, severities, areas)).toThrow(
			'without a structured review result',
		);
		expect(() =>
			extractReviewResult({ review: [{ summary: '', findings: [] }] }, severities, areas),
		).toThrow();
	});

	it('rejects finding classifications not allowed by repository configuration', () => {
		const finding = {
			path: 'src/example.ts',
			line: 1,
			side: 'RIGHT',
			severity: 'blocker',
			area: 'correctness',
			title: 'Incorrect behavior',
			body: 'This change fails at runtime.',
		};
		const review = {
			summary: 'One issue found.',
			findings: [finding],
		};

		expect(
			extractReviewResult({ review: [review] }, severities, areas),
		).toEqual(review);
		expect(() =>
			extractReviewResult(
				{ review: [{ ...review, findings: [{ ...finding, severity: 'high' }] }] },
				severities,
				areas,
			),
		).toThrow();
		expect(() =>
			extractReviewResult(
				{ review: [{ ...review, findings: [{ ...finding, area: 'runtime' }] }] },
				severities,
				areas,
			),
		).toThrow();
	});
});
