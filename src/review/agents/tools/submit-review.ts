import { useTool } from '@flue/runtime';
import type { ReviewResult, ReviewResultSchema } from '../../contracts.ts';

export function useSubmitReviewTool(
	writeReview: (review: ReviewResult) => void,
	schema: ReviewResultSchema,
): void {
	useTool({
		name: 'submit_review_findings',
		description:
			'Submit the final structured review fields without GitHub comment formatting. Call exactly once after completing the review.',
		input: schema,
		run({ data }) {
			writeReview(data);
			return {
				output: { accepted: true, findings: data.findings.length },
				terminate: true,
			};
		},
	});
}
