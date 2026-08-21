import { describe, expect, it } from 'vitest';
import {
	extractReviewResult,
	parseReviewResult,
} from '../src/review/result.ts';

describe('structured review result extraction', () => {
	const severities = ['blocker', 'advisory'];
	const areas = ['correctness', 'security'];

	it('returns the latest valid review write', () => {
		expect(
			extractReviewResult(
				{
					review: [
						{ summary: 'Old result', findings: [], addressedThreadIds: [] },
						{ summary: 'Final result', findings: [], addressedThreadIds: [] },
					],
				},
				severities,
				areas,
			),
		).toEqual({
			summary: 'Final result',
			findings: [],
			addressedThreadIds: [],
		});
	});

	it('defaults addressed thread IDs on results persisted before follow-up support', () => {
		const persisted = { summary: 'Legacy result', findings: [] };
		const expected = {
			summary: 'Legacy result',
			findings: [],
			addressedThreadIds: [],
		};
		expect(
			extractReviewResult({ review: [persisted] }, severities, areas),
		).toEqual(expected);
		expect(parseReviewResult(persisted, severities, areas)).toEqual(expected);
	});

	it('rejects missing or invalid review writes', () => {
		expect(() => extractReviewResult({}, severities, areas)).toThrow(
			'without a structured review result',
		);
		expect(() =>
			extractReviewResult(
				{ review: [{ summary: '', findings: [], addressedThreadIds: [] }] },
				severities,
				areas,
			),
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
			addressedThreadIds: [],
		};

		expect(
			extractReviewResult({ review: [review] }, severities, areas),
		).toEqual(review);
		expect(() =>
			extractReviewResult(
				{
					review: [{ ...review, findings: [{ ...finding, severity: 'high' }] }],
				},
				severities,
				areas,
			),
		).toThrow();
		expect(() =>
			extractReviewResult(
				{
					review: [{ ...review, findings: [{ ...finding, area: 'runtime' }] }],
				},
				severities,
				areas,
			),
		).toThrow();
	});

	it('accepts only unique addressed thread IDs supplied in the review context', () => {
		const review = {
			summary: 'Prior feedback checked.',
			findings: [],
			addressedThreadIds: ['thread-a'],
		};

		expect(
			extractReviewResult({ review: [review] }, severities, areas, [
				'thread-a',
				'thread-b',
			]),
		).toEqual(review);
		expect(() =>
			extractReviewResult(
				{ review: [{ ...review, addressedThreadIds: ['thread-c'] }] },
				severities,
				areas,
				['thread-a', 'thread-b'],
			),
		).toThrow();
		expect(() =>
			extractReviewResult(
				{
					review: [{ ...review, addressedThreadIds: ['thread-a', 'thread-a'] }],
				},
				severities,
				areas,
				['thread-a', 'thread-b'],
			),
		).toThrow();
	});
});
