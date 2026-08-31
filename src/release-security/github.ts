import type { InstallationClient } from '../github/client.ts';
import {
	RELEASE_BRANCH_PREFIX,
	RELEASE_SECURITY_TARGET,
	type ReleaseSecurityMode,
	type ReleaseSecurityResult,
	type ReleaseSecurityWorkflowParams,
	SMOKE_BRANCH_PREFIX,
	SMOKE_PR_TITLE,
} from './contracts.ts';
import {
	hasReleaseSecurityCommentMarker,
	sanitizedReleaseSecurityComment,
} from './public-output.ts';

export interface LiveReleaseSecurityTarget {
	owner: string;
	repo: string;
	pullNumber: number;
	pullUrl: string;
	pullTitle: string;
	pullBody: string;
	headRef: string;
	headSha: string;
	headRepository: string;
	baseRef: string;
	baseSha: string;
	baseRepository: string;
	state: string;
}

export function releaseSecurityMode(
	target: Pick<LiveReleaseSecurityTarget, 'headRef' | 'baseRef' | 'pullTitle'>,
): ReleaseSecurityMode | undefined {
	if (target.headRef === `${RELEASE_BRANCH_PREFIX}${target.baseRef}`) {
		return 'release';
	}
	if (
		target.headRef === `${SMOKE_BRANCH_PREFIX}${target.baseRef}` &&
		target.pullTitle === SMOKE_PR_TITLE
	) {
		return 'smoke';
	}
}

export async function loadLiveReleaseSecurityTarget(
	client: InstallationClient,
	owner: string,
	repo: string,
	pullNumber: number,
): Promise<LiveReleaseSecurityTarget> {
	const response = await client.rest.pulls.get({
		owner,
		repo,
		pull_number: pullNumber,
	});
	const pull = response.data;
	if (!pull.head.repo?.full_name || !pull.base.repo?.full_name) {
		throw new Error(
			'Pull request lookup returned incomplete repository state.',
		);
	}
	return {
		owner,
		repo,
		pullNumber,
		pullUrl: pull.html_url,
		pullTitle: pull.title,
		pullBody: pull.body ?? '',
		headRef: pull.head.ref,
		headSha: pull.head.sha.toLowerCase(),
		headRepository: pull.head.repo.full_name,
		baseRef: pull.base.ref,
		baseSha: pull.base.sha.toLowerCase(),
		baseRepository: pull.base.repo.full_name,
		state: pull.state,
	};
}

export function liveTargetMatches(
	input: ReleaseSecurityWorkflowParams,
	live: LiveReleaseSecurityTarget,
): boolean {
	return (
		live.state === 'open' &&
		`${live.owner}/${live.repo}` === RELEASE_SECURITY_TARGET &&
		live.headRepository === RELEASE_SECURITY_TARGET &&
		live.baseRepository === RELEASE_SECURITY_TARGET &&
		live.headSha === input.headSha &&
		live.headRef === input.headRef &&
		live.baseSha === input.baseSha &&
		live.baseRef === input.baseRef &&
		releaseSecurityMode(live) === input.mode
	);
}

export async function fetchPublishedRepositoryAdvisories(
	client: InstallationClient,
	input: Pick<ReleaseSecurityWorkflowParams, 'owner' | 'repo'>,
): Promise<unknown[]> {
	const advisories: unknown[] = [];
	for (let page = 1; page <= 10; page += 1) {
		const response = await client.request(
			'GET /repos/{owner}/{repo}/security-advisories',
			{
				owner: input.owner,
				repo: input.repo,
				state: 'published',
				per_page: 100,
				page,
			},
		);
		const batch = response.data as Array<{ withdrawn_at?: string | null }>;
		advisories.push(...batch.filter((advisory) => !advisory.withdrawn_at));
		if (batch.length < 100) return advisories;
	}
	throw new Error('Published advisory pagination exceeded 1,000 records.');
}

export async function postSanitizedReleaseSecurityComment(
	client: InstallationClient,
	input: ReleaseSecurityWorkflowParams,
	result: Pick<ReleaseSecurityResult, 'verdict' | 'reviewedSha'>,
	appId: string,
): Promise<void> {
	const managedIds: number[] = [];
	for (let page = 1; page <= 10; page += 1) {
		const response = await client.rest.issues.listComments({
			owner: input.owner,
			repo: input.repo,
			issue_number: input.pullNumber,
			per_page: 100,
			page,
		});
		for (const comment of response.data) {
			if (
				comment.body &&
				hasReleaseSecurityCommentMarker(comment.body) &&
				comment.performed_via_github_app?.id === Number(appId)
			) {
				managedIds.push(comment.id);
			}
		}
		if (response.data.length < 100) break;
	}

	const body = sanitizedReleaseSecurityComment(
		result,
		`${input.owner}/${input.repo}`,
		input.mode,
	);
	const existingId = managedIds.at(-1);
	if (existingId === undefined) {
		await client.rest.issues.createComment({
			owner: input.owner,
			repo: input.repo,
			issue_number: input.pullNumber,
			body,
		});
	} else {
		await client.rest.issues.updateComment({
			owner: input.owner,
			repo: input.repo,
			comment_id: existingId,
			body,
		});
	}

	for (const duplicateId of managedIds.slice(0, -1)) {
		await client.rest.issues.deleteComment({
			owner: input.owner,
			repo: input.repo,
			comment_id: duplicateId,
		});
	}
}
