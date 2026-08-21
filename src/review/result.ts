import * as v from 'valibot';
import { createReviewResultSchema, type ReviewResult } from './contracts.ts';

export function extractReviewResult(
	data: Record<string, unknown[]>,
	severities: readonly string[],
	areas: readonly string[],
	addressableThreadIds: readonly string[] = [],
): ReviewResult {
	const writes = data.review;
	if (!writes?.length) {
		throw new Error(
			'The review agent completed without a structured review result.',
		);
	}
	return parseReviewResult(
		writes.at(-1),
		severities,
		areas,
		addressableThreadIds,
	);
}

export function parseReviewResult(
	value: unknown,
	severities: readonly string[],
	areas: readonly string[],
	addressableThreadIds: readonly string[] = [],
): ReviewResult {
	return v.parse(
		createReviewResultSchema(severities, areas, addressableThreadIds),
		withLegacyDefaults(value),
	);
}

function withLegacyDefaults(value: unknown): unknown {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		'addressedThreadIds' in value
	) {
		return value;
	}
	return { ...value, addressedThreadIds: [] };
}
