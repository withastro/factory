import { useTool } from '@flue/runtime';
import { reviewResultSchema, type ReviewResult } from '../../contracts/review.ts';

export function useSubmitReviewTool(writeReview: (review: ReviewResult) => void): void {
	useTool({
		name: 'submit_review_findings',
		description:
			'Submit the final structured review. Call exactly once after completing the review.',
		input: reviewResultSchema,
		run({ data }) {
			writeReview(data);
			return {
				output: { accepted: true, findings: data.findings.length },
				terminate: true,
			};
		},
	});
}
