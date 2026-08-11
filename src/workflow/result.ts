import * as v from 'valibot';
import { reviewResultSchema, type ReviewResult } from '../contracts/review.ts';

export function extractReviewResult(data: Record<string, unknown[]>): ReviewResult {
	const writes = data.review;
	if (!writes?.length) {
		throw new Error('The review agent completed without a structured review result.');
	}
	return v.parse(reviewResultSchema, writes.at(-1));
}
