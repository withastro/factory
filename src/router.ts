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
 *                                        loops). Bot filtering covers GitHub
 *                                        App accounts (`user.type === 'Bot'`)
 *                                        and known user-account bots such as
 *                                        astrobot-houston, so another bot's
 *                                        comment can never start a triage.
 */

import { isBotAuthor } from './github/bots.ts';
import { RELEASE_SECURITY_CHECK_NAMES } from './release-security/checks.ts';
import {
	RELEASE_BRANCH_PREFIX,
	RELEASE_SECURITY_TARGET,
	type ReleaseSecurityMode,
	type ReleaseSecurityWorkflowParams,
	SMOKE_BRANCH_PREFIX,
	SMOKE_PR_TITLE,
} from './release-security/contracts.ts';
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
	| { kind: 'release-security'; params: ReleaseSecurityWorkflowParams }
	| {
			kind: 'release-security-rerequest';
			params: ReleaseSecurityRerequestIntent;
	  }
	| { kind: 'none'; reason: string };

export interface ReleaseSecurityRerequestIntent {
	deliveryId: string;
	installationId: number;
	repositoryId: number;
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	mode: ReleaseSecurityMode;
	appId: number;
}

interface WebhookRepository {
	id: number;
	name: string;
	full_name?: string;
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
		html_url?: string;
		title?: string;
		body?: string | null;
		base: { ref: string; sha: string; repo?: { full_name?: string } };
		head: { ref?: string; sha: string; repo?: { full_name?: string } };
	};
	check_run?: {
		name?: string;
		head_sha?: string;
		details_url?: string;
		app?: { id?: number };
		pull_requests?: Array<{ number?: number; head?: { sha?: string } }>;
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

	const releaseSecurity = routeReleaseSecurityPullRequest(
		eventName,
		payload,
		base,
	);
	if (releaseSecurity) return releaseSecurity;

	const rerequest = routeReleaseSecurityRerequest(eventName, payload, base);
	if (rerequest) return rerequest;

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
		const commentAuthor = payload.comment?.user?.login;
		if (payload.comment?.user?.type === 'Bot' || isBotAuthor(commentAuthor)) {
			return {
				kind: 'none',
				reason: `Comment from bot (${commentAuthor ?? 'unknown'}).`,
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

function routeReleaseSecurityPullRequest(
	eventName: string,
	payload: WebhookPayload,
	base: Pick<
		ReleaseSecurityWorkflowParams,
		'deliveryId' | 'installationId' | 'repositoryId' | 'owner' | 'repo'
	>,
): Dispatch | undefined {
	if (
		eventName !== 'pull_request' ||
		!['opened', 'reopened', 'synchronize'].includes(payload.action ?? '')
	) {
		return;
	}
	const pull = payload.pull_request;
	const repository = payload.repository;
	if (!pull || !repository) return;
	if (repository.full_name !== RELEASE_SECURITY_TARGET) return;
	if (
		pull.head.repo?.full_name !== RELEASE_SECURITY_TARGET ||
		pull.base.repo?.full_name !== RELEASE_SECURITY_TARGET
	) {
		return {
			kind: 'none',
			reason: 'Release pull request must originate in the target repository.',
		};
	}
	const mode = releaseMode(pull.head.ref, pull.base.ref, pull.title);
	if (!mode) return;
	if (
		!pull.html_url ||
		!pull.title ||
		!isSha(pull.head.sha) ||
		!isSha(pull.base.sha)
	) {
		return {
			kind: 'none',
			reason: 'Release pull request is missing required metadata.',
		};
	}
	return {
		kind: 'release-security',
		params: {
			...base,
			pullNumber: pull.number,
			pullUrl: pull.html_url,
			pullTitle: pull.title,
			pullBody: pull.body ?? '',
			headRef: pull.head.ref as string,
			headSha: pull.head.sha.toLowerCase(),
			baseRef: pull.base.ref,
			baseSha: pull.base.sha.toLowerCase(),
			mode,
			trigger: 'pull-request',
		},
	};
}

function routeReleaseSecurityRerequest(
	eventName: string,
	payload: WebhookPayload,
	base: Pick<
		ReleaseSecurityRerequestIntent,
		'deliveryId' | 'installationId' | 'repositoryId' | 'owner' | 'repo'
	>,
): Dispatch | undefined {
	if (eventName !== 'check_run' || payload.action !== 'rerequested') return;
	if (payload.repository?.full_name !== RELEASE_SECURITY_TARGET) return;
	const check = payload.check_run;
	if (!check?.app?.id || !isSha(check.head_sha)) return;
	const mode = Object.entries(RELEASE_SECURITY_CHECK_NAMES).find(
		([, name]) => name === check.name,
	)?.[0] as ReleaseSecurityMode | undefined;
	if (!mode) return;
	const pullNumber = pullNumberFromCheck(check.details_url);
	if (!pullNumber) {
		return {
			kind: 'none',
			reason: 'Release security check has no valid PR URL.',
		};
	}
	const association = check.pull_requests?.find(
		(pullRequest) => pullRequest.number === pullNumber,
	);
	if (association?.head?.sha?.toLowerCase() !== check.head_sha?.toLowerCase()) {
		return {
			kind: 'none',
			reason: 'Release security check is not associated with its PR head.',
		};
	}
	return {
		kind: 'release-security-rerequest',
		params: {
			...base,
			pullNumber,
			headSha: check.head_sha.toLowerCase(),
			mode,
			appId: check.app.id,
		},
	};
}

function releaseMode(
	headRef: string | undefined,
	baseRef: string,
	title: string | undefined,
): ReleaseSecurityMode | undefined {
	if (headRef === `${RELEASE_BRANCH_PREFIX}${baseRef}`) return 'release';
	if (
		headRef === `${SMOKE_BRANCH_PREFIX}${baseRef}` &&
		title === SMOKE_PR_TITLE
	) {
		return 'smoke';
	}
}

function pullNumberFromCheck(
	detailsUrl: string | undefined,
): number | undefined {
	try {
		const url = new URL(detailsUrl ?? '');
		const match = /^\/withastro\/astro\/pull\/(\d+)$/.exec(url.pathname);
		if (url.origin !== 'https://github.com' || !match) return;
		const value = Number(match[1]);
		return Number.isInteger(value) && value > 0 ? value : undefined;
	} catch {
		return;
	}
}

function isSha(value: string | undefined): value is string {
	return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}
