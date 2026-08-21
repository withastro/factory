/**
 * The factory's front door: maps a GitHub webhook delivery to a capability
 * dispatch. This is deliberately a pure, deterministic rule table — all the
 * intelligence lives in the capability agents behind it. Keeping this surface
 * small and data-in/data-out is what will later allow alternate router
 * implementations (e.g. an LLM router configured in markdown) to slot in.
 *
 * Routing rules:
 * - `pull_request.labeled`            → review (label match is checked later
 *                                        against repository configuration)
 * - `issues.opened|reopened|closed`   → triage
 * - `issue_comment.created`           → triage, unless the comment is on a
 *                                        pull request or written by a bot
 *                                        (bot filtering prevents self-trigger
 *                                        loops)
 */

import type { TriageWorkflowParams } from './triage/contracts.ts';

export interface ReviewIntentParams {
	deliveryId: string;
	installationId: number;
	repositoryId: number;
	owner: string;
	repo: string;
	pullNumber: number;
	label: string;
	baseSha: string;
	baseRef: string;
	headSha: string;
}

export type Dispatch =
	| { kind: 'review'; params: ReviewIntentParams }
	| { kind: 'triage'; params: TriageWorkflowParams }
	| { kind: 'none'; reason: string };

interface WebhookRepository {
	id: number;
	name: string;
	private: boolean;
	default_branch: string;
	owner: { login: string };
}

interface WebhookPayload {
	action?: string;
	installation?: { id: number };
	repository?: WebhookRepository;
	label?: { name: string };
	pull_request?: {
		number: number;
		base: { ref: string; sha: string };
		head: { sha: string };
	};
	issue?: {
		number: number;
		pull_request?: unknown;
	};
	comment?: {
		user?: { login?: string; type?: string };
	};
}

export function routeDelivery(
	eventName: string,
	payload: WebhookPayload,
	deliveryId: string,
): Dispatch {
	const repository = payload.repository;
	if (!repository) {
		return { kind: 'none', reason: 'The delivery has no repository.' };
	}
	const installationId = payload.installation?.id;
	if (!installationId) {
		return { kind: 'none', reason: 'The delivery has no installation.' };
	}

	const base = {
		deliveryId,
		installationId,
		repositoryId: repository.id,
		owner: repository.owner.login,
		repo: repository.name,
	};

	if (eventName === 'pull_request' && payload.action === 'labeled') {
		const pull = payload.pull_request;
		const label = payload.label;
		if (!pull || !label) {
			return {
				kind: 'none',
				reason: 'The labeled delivery is missing pull request data.',
			};
		}
		return {
			kind: 'review',
			params: {
				...base,
				pullNumber: pull.number,
				label: label.name,
				baseSha: pull.base.sha,
				baseRef: pull.base.ref,
				headSha: pull.head.sha,
			},
		};
	}

	if (eventName === 'issues') {
		const action = payload.action;
		if (action !== 'opened' && action !== 'reopened' && action !== 'closed') {
			return { kind: 'none', reason: `Unhandled issues action: ${action}.` };
		}
		if (!payload.issue) {
			return { kind: 'none', reason: 'The issues delivery has no issue.' };
		}
		return {
			kind: 'triage',
			params: {
				...base,
				issueNumber: payload.issue.number,
				defaultBranch: repository.default_branch,
				issueAction: action,
				repoIsPrivate: repository.private,
			},
		};
	}

	if (eventName === 'issue_comment' && payload.action === 'created') {
		const issue = payload.issue;
		if (!issue) {
			return { kind: 'none', reason: 'The comment delivery has no issue.' };
		}
		if (issue.pull_request) {
			return {
				kind: 'none',
				reason: 'The comment is on a pull request, not an issue.',
			};
		}
		if (payload.comment?.user?.type === 'Bot') {
			return {
				kind: 'none',
				reason: `Comment from bot (${payload.comment.user.login ?? 'unknown'}).`,
			};
		}
		return {
			kind: 'triage',
			params: {
				...base,
				issueNumber: issue.number,
				defaultBranch: repository.default_branch,
				issueAction: 'comment',
				commentAuthor: payload.comment?.user?.login,
				repoIsPrivate: repository.private,
			},
		};
	}

	return {
		kind: 'none',
		reason: `Unhandled event: ${eventName}.${payload.action ?? ''}`,
	};
}
