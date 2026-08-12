import type {
	ReviewResult,
	ReviewWorkflowOutcome,
} from '../contracts/review.ts';
import type { InstallationClient } from './client.ts';
import {
	formatInlineFinding,
	formatReviewBody,
	prepareReview,
	reviewMarker,
} from './diff.ts';

export interface PublishReviewInput {
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	deliveryId: string;
}

export async function publishReview(
	client: InstallationClient,
	input: PublishReviewInput,
	result: ReviewResult,
): Promise<ReviewWorkflowOutcome> {
	const pull = await client.rest.pulls.get({
		owner: input.owner,
		repo: input.repo,
		pull_number: input.pullNumber,
	});
	if (pull.data.state !== 'open' || pull.data.head.sha !== input.headSha) {
		return { outcome: 'stale', reason: 'The pull request changed before publication.' };
	}

	const marker = reviewMarker(input.deliveryId, input.headSha);
	const reviews = await client.paginate(client.rest.pulls.listReviews, {
		owner: input.owner,
		repo: input.repo,
		pull_number: input.pullNumber,
		per_page: 100,
	});
	const existing = reviews.find((review) => review.body?.includes(marker));
	if (existing) {
		return {
			outcome: 'already-published',
			reviewId: existing.id,
			reviewUrl: existing.html_url,
		};
	}

	const files = await client.paginate(client.rest.pulls.listFiles, {
		owner: input.owner,
		repo: input.repo,
		pull_number: input.pullNumber,
		per_page: 100,
	});
	const prepared = prepareReview(
		result,
		files.map((file) => ({ filename: file.filename, patch: file.patch })),
	);

	const review = await client.rest.pulls.createReview({
		owner: input.owner,
		repo: input.repo,
		pull_number: input.pullNumber,
		commit_id: input.headSha,
		event: 'COMMENT',
		body: formatReviewBody(result, prepared.unanchored, marker),
		comments: prepared.inline.map((finding) => ({
			path: finding.path,
			line: finding.line,
			side: finding.side,
			body: formatInlineFinding(finding),
		})),
	});

	return {
		outcome: 'published',
		reviewId: review.data.id,
		reviewUrl: review.data.html_url,
		comments: prepared.inline.length,
	};
}
