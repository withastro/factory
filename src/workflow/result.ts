import * as v from 'valibot';
import { createReviewResultSchema, type ReviewResult } from '../contracts/review.ts';

export function extractReviewResult(
	data: Record<string, unknown[]>,
	severities: readonly string[],
	areas: readonly string[],
): ReviewResult {
	const writes = data.review;
	if (!writes?.length) {
		throw new Error('The review agent completed without a structured review result.');
	}
	return v.parse(createReviewResultSchema(severities, areas), writes.at(-1));
}
