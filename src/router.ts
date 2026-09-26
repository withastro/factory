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
 * - `issues.assigned`,                → persona assignment (the assignee is
 *   `pull_request.assigned`,            resolved against the repository's
 *   `pull_request.review_requested`     configured personas later)
 * - human activity on a Factory       → code author (whether the author
 *   pull request: reviews, review        persona owns the pull request is
 *   comments, comments, and failed       checked later against live state)
 *   check suites / workflow runs
 */

import { FACTORY_BRANCH_PREFIX } from './author/contracts.ts';
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

/** Where a persona assignment landed. */
export type PersonaSubject =
	| { type: 'issue'; issueNumber: number }
	| {
			type: 'pull_request';
			pullNumber: number;
			baseRef: string;
			baseSha: string;
			headSha: string;
	  };

/**
 * An issue or pull request was assigned to someone, or someone's review was
 * requested. Whether `login` is a persona is decided later, against the
 * repository's configuration.
 */
export interface PersonaAssignmentIntent {
	deliveryId: string;
	installationId: number;
	repositoryId: number;
	owner: string;
	repo: string;
	defaultBranch: string;
	repoIsPrivate: boolean;
	login: string;
	signal: 'assigned' | 'review-requested';
	subject: PersonaSubject;
}

export type AuthorActivity =
	| 'review'
	| 'review-comment'
	| 'comment'
	| 'check-failure';

/**
 * Human activity on a pull request the code author persona may own. Ownership
 * (open, same-repository `factory/` branch, assigned to the persona) is
 * checked later against live state.
 */
export interface AuthorActivityIntent {
	deliveryId: string;
	installationId: number;
	repositoryId: number;
	owner: string;
	repo: string;
	defaultBranch: string;
	repoIsPrivate: boolean;
	pullNumber: number;
	activity: AuthorActivity;
	actor?: string;
}

export type Dispatch =
	| { kind: 'review'; params: ReviewIntentParams }
	| { kind: 'persona-assignment'; params: PersonaAssignmentIntent }
	| { kind: 'author-activity'; params: AuthorActivityIntent }
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
	sender?: WebhookUser;
	assignee?: WebhookUser | null;
	requested_reviewer?: WebhookUser;
	pull_request?: {
		number: number;
		html_url?: string;
		title?: string;
		body?: string | null;
		assignees?: WebhookUser[] | null;
		base: { ref: string; sha: string; repo?: { full_name?: string } };
		head: { ref?: string; sha: string; repo?: { full_name?: string } };
	};
	review?: { user?: WebhookUser | null; state?: string };
	check_suite?: {
		conclusion?: string | null;
		head_branch?: string | null;
		pull_requests?: Array<{ number?: number }>;
	};
	workflow_run?: {
		conclusion?: string | null;
		head_branch?: string | null;
		head_repository?: { full_name?: string } | null;
		pull_requests?: Array<{ number?: number }>;
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
		assignees?: WebhookUser[] | null;
	};
	comment?: {
		user?: WebhookUser | null;
	};
}

interface WebhookUser {
	login?: string;
	type?: string;
}

/** GitHub App accounts, plus user accounts known to be bots. */
function isBot(user: WebhookUser | null | undefined): boolean {
	return user?.type === 'Bot' || isBotAuthor(user?.login);
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

	const repositoryContext = {
		...base,
		defaultBranch: repository.default_branch,
		repoIsPrivate: repository.private,
	};

	const assignment = routePersonaAssignment(
		eventName,
		payload,
		repositoryContext,
	);
	if (assignment) return assignment;

	const authorActivity = routeAuthorActivity(
		eventName,
		payload,
		repositoryContext,
	);
	if (authorActivity) return authorActivity;

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
		// Pull request comments were routed to the author capability above.
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

type RepositoryContext = Pick<
	PersonaAssignmentIntent,
	| 'deliveryId'
	| 'installationId'
	| 'repositoryId'
	| 'owner'
	| 'repo'
	| 'defaultBranch'
	| 'repoIsPrivate'
>;

function routePersonaAssignment(
	eventName: string,
	payload: WebhookPayload,
	context: RepositoryContext,
): Dispatch | undefined {
	if (eventName === 'issues' && payload.action === 'assigned') {
		if (!payload.issue) {
			return { kind: 'none', reason: 'The issues delivery has no issue.' };
		}
		return personaAssignment(payload.assignee, context, 'assigned', {
			type: 'issue',
			issueNumber: payload.issue.number,
		});
	}

	if (
		eventName === 'pull_request' &&
		(payload.action === 'assigned' || payload.action === 'review_requested')
	) {
		const pull = payload.pull_request;
		if (!pull) {
			return {
				kind: 'none',
				reason: `The ${payload.action} delivery is missing pull request data.`,
			};
		}
		const assigned = payload.action === 'assigned';
		// A team review request has no `requested_reviewer`; personas are users.
		return personaAssignment(
			assigned ? payload.assignee : payload.requested_reviewer,
			context,
			assigned ? 'assigned' : 'review-requested',
			{
				type: 'pull_request',
				pullNumber: pull.number,
				baseRef: pull.base.ref,
				baseSha: pull.base.sha,
				headSha: pull.head.sha,
			},
		);
	}
}

function personaAssignment(
	user: WebhookUser | null | undefined,
	context: RepositoryContext,
	signal: PersonaAssignmentIntent['signal'],
	subject: PersonaSubject,
): Dispatch {
	const login = user?.login;
	if (!login) {
		return {
			kind: 'none',
			reason: `The ${signal} delivery names no user.`,
		};
	}
	if (isBot(user)) {
		return { kind: 'none', reason: `${signal} to a bot (${login}).` };
	}
	return {
		kind: 'persona-assignment',
		params: { ...context, login, signal, subject },
	};
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out']);

function routeAuthorActivity(
	eventName: string,
	payload: WebhookPayload,
	context: RepositoryContext,
): Dispatch | undefined {
	const activity = (
		pullNumber: number,
		kind: AuthorActivity,
		actor?: string,
	): Dispatch => ({
		kind: 'author-activity',
		params: {
			...context,
			pullNumber,
			activity: kind,
			...(actor ? { actor } : {}),
		},
	});

	if (
		(eventName === 'pull_request_review' && payload.action === 'submitted') ||
		(eventName === 'pull_request_review_comment' &&
			payload.action === 'created')
	) {
		const pull = payload.pull_request;
		const author =
			eventName === 'pull_request_review'
				? payload.review?.user
				: payload.comment?.user;
		if (!pull) {
			return {
				kind: 'none',
				reason: 'The review delivery has no pull request.',
			};
		}
		// Bot feedback — including Factory's own replies and reviews — never
		// starts the author, so the persona can't feed itself.
		if (isBot(author)) {
			return {
				kind: 'none',
				reason: `Review activity from bot (${author?.login ?? 'unknown'}).`,
			};
		}
		if (!isOwnableFactoryPull(pull)) {
			return {
				kind: 'none',
				reason: 'Review activity on a pull request no persona can own.',
			};
		}
		return activity(
			pull.number,
			eventName === 'pull_request_review' ? 'review' : 'review-comment',
			author?.login,
		);
	}

	if (eventName === 'issue_comment' && payload.action === 'created') {
		const issue = payload.issue;
		// Comments on issues belong to triage; only pull request comments here.
		if (!issue?.pull_request) return;
		const author = payload.comment?.user;
		if (isBot(author)) {
			return {
				kind: 'none',
				reason: `Comment from bot (${author?.login ?? 'unknown'}).`,
			};
		}
		// The comment payload omits the head branch; an unassigned pull request
		// can't be owned, which filters out nearly every other comment cheaply.
		if (!issue.assignees?.length) {
			return {
				kind: 'none',
				reason: 'The comment is on an unassigned pull request.',
			};
		}
		return activity(issue.number, 'comment', author?.login);
	}

	if (eventName === 'check_suite' && payload.action === 'completed') {
		const suite = payload.check_suite;
		return failedRun(
			suite?.conclusion,
			suite?.head_branch,
			suite?.pull_requests,
			true,
			activity,
		);
	}

	if (eventName === 'workflow_run' && payload.action === 'completed') {
		const run = payload.workflow_run;
		return failedRun(
			run?.conclusion,
			run?.head_branch,
			run?.pull_requests,
			run?.head_repository?.full_name === `${context.owner}/${context.repo}`,
			activity,
		);
	}
}

function failedRun(
	conclusion: string | null | undefined,
	headBranch: string | null | undefined,
	pullRequests: Array<{ number?: number }> | undefined,
	sameRepository: boolean,
	activity: (pullNumber: number, kind: AuthorActivity) => Dispatch,
): Dispatch {
	if (!conclusion || !FAILED_CONCLUSIONS.has(conclusion)) {
		return {
			kind: 'none',
			reason: `Checks concluded ${conclusion ?? 'unknown'}.`,
		};
	}
	if (!sameRepository || !headBranch?.startsWith(FACTORY_BRANCH_PREFIX)) {
		return {
			kind: 'none',
			reason: 'Failed checks are not on a Factory branch.',
		};
	}
	const pullNumber = pullRequests?.find(
		(pull) => typeof pull.number === 'number' && pull.number > 0,
	)?.number;
	if (!pullNumber) {
		return { kind: 'none', reason: 'Failed checks have no pull request.' };
	}
	return activity(pullNumber, 'check-failure');
}

/**
 * A pull request the author persona could own: an assigned, same-repository
 * pull request from a Factory branch. Assignment to the persona itself is
 * checked against configuration later.
 */
function isOwnableFactoryPull(
	pull: NonNullable<WebhookPayload['pull_request']>,
): boolean {
	return (
		(pull.assignees?.length ?? 0) > 0 &&
		(pull.head.ref ?? '').startsWith(FACTORY_BRANCH_PREFIX) &&
		pull.head.repo?.full_name !== undefined &&
		pull.head.repo.full_name === pull.base.repo?.full_name
	);
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
