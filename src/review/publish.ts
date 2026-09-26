import type { InstallationClient } from '../github/client.ts';
import { isGitHubStatus } from '../github/content.ts';
import type { ReviewResult, ReviewWorkflowOutcome } from './contracts.ts';
import {
	formatInlineFinding,
	formatReviewBody,
	prepareReview,
	reviewMarker,
} from './diff.ts';
import {
	formatVerdictNotice,
	type ReviewVerdict,
	verdictMarker,
} from './verdict.ts';

export interface PublishReviewInput {
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	deliveryId: string;
}

/**
 * Publish a review. Label-triggered reviews are plain comments. Persona
 * reviews carry a verdict: APPROVE, REQUEST_CHANGES, or (for a stand-still) a
 * comment. Where GitHub refuses the verdict because the App opened the pull
 * request itself, the review falls back to a comment and the verdict lives in
 * its body and hidden marker.
 */
export async function publishReview(
	client: InstallationClient,
	input: PublishReviewInput,
	result: ReviewResult,
	verdict?: ReviewVerdict,
): Promise<ReviewWorkflowOutcome> {
	const pull = await client.rest.pulls.get({
		owner: input.owner,
		repo: input.repo,
		pull_number: input.pullNumber,
	});
	if (pull.data.state !== 'open' || pull.data.head.sha !== input.headSha) {
		return {
			outcome: 'stale',
			reason: 'The pull request changed before publication.',
		};
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

	const comments = prepared.inline.map((finding) => ({
		path: finding.path,
		line: finding.line,
		side: finding.side,
		body: formatInlineFinding(finding),
	}));
	const create = (event: ReviewEvent, fallback: boolean) =>
		client.rest.pulls.createReview({
			owner: input.owner,
			repo: input.repo,
			pull_number: input.pullNumber,
			commit_id: input.headSha,
			event,
			body: formatReviewBody(
				result,
				prepared.unanchored,
				verdict ? `${marker}\n${verdictMarker(verdict.kind)}` : marker,
				verdict ? formatVerdictNotice(verdict, { fallback }) : undefined,
			),
			comments,
			// A retry must repeat the marker lookup before another POST.
			request: { retries: 0 },
		});

	const event = reviewEvent(verdict);
	let review: Awaited<ReturnType<typeof create>>;
	let published: ReviewEvent = event;
	try {
		review = await create(event, false);
	} catch (error) {
		if (event === 'COMMENT' || !isOwnPullRequestRefusal(error)) throw error;
		published = 'COMMENT';
		review = await create('COMMENT', true);
	}

	return {
		outcome: 'published',
		reviewId: review.data.id,
		reviewUrl: review.data.html_url,
		comments: prepared.inline.length,
		...(verdict ? { verdict: verdict.kind, event: published } : {}),
	};
}

type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

function reviewEvent(verdict: ReviewVerdict | undefined): ReviewEvent {
	switch (verdict?.kind) {
		case 'approve':
			return 'APPROVE';
		case 'request-changes':
			return 'REQUEST_CHANGES';
		default:
			return 'COMMENT';
	}
}

/**
 * GitHub's 422 for approving or requesting changes on your own pull request
 * ("Can not approve your own pull request" / "Can not request changes on
 * your own pull request").
 */
function isOwnPullRequestRefusal(error: unknown): boolean {
	if (!isGitHubStatus(error, 422)) return false;
	const message = error instanceof Error ? error.message : String(error);
	const data = (error as { response?: { data?: unknown } }).response?.data;
	return /your own pull request/i.test(`${message} ${JSON.stringify(data)}`);
}
