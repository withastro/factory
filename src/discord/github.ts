/**
 * GitHub access for the Discord assistant. Discord events carry no GitHub
 * installation, so the assistant finds its repository's installation itself.
 */

import { App } from 'octokit';
import type {
	GitHubCredentials,
	InstallationClient,
} from '../github/client.ts';
import { isGitHubStatus } from '../github/content.ts';
import { fetchIssueDetails } from '../github/issues.ts';

export interface AssistantRepository {
	installationId: number;
	owner: string;
	repo: string;
	defaultBranch: string;
	isPrivate: boolean;
}

export async function findAssistantRepository(
	credentials: GitHubCredentials,
	owner: string,
	repo: string,
): Promise<AssistantRepository> {
	const app = new App({
		appId: credentials.appId,
		privateKey: credentials.privateKey,
	});
	let installationId: number;
	try {
		const installation = await app.octokit.rest.apps.getRepoInstallation({
			owner,
			repo,
		});
		installationId = installation.data.id;
	} catch (error) {
		if (isGitHubStatus(error, 404)) {
			throw new Error(
				`The Factory GitHub App isn't installed on ${owner}/${repo}.`,
			);
		}
		throw error;
	}
	const client = await app.getInstallationOctokit(installationId);
	const { data } = await client.rest.repos.get({ owner, repo });
	return {
		installationId,
		owner,
		repo,
		defaultBranch: data.default_branch,
		isPrivate: data.private,
	};
}

/** Most comments rendered per linked issue, newest kept. */
const COMMENT_LIMIT = 30;
const BODY_LIMIT = 20_000;
const COMMENT_BODY_LIMIT = 4_000;

/**
 * Render an issue or pull request and its conversation as Markdown for the
 * assistant. Returns undefined when it doesn't exist.
 */
export async function renderLinkedIssue(
	client: InstallationClient,
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<string | undefined> {
	let details: Awaited<ReturnType<typeof fetchIssueDetails>>;
	try {
		details = await fetchIssueDetails(client, owner, repo, issueNumber);
	} catch (error) {
		if (isGitHubStatus(error, 404) || isGitHubStatus(error, 410)) {
			return undefined;
		}
		throw error;
	}
	const comments = details.comments.slice(-COMMENT_LIMIT);
	const omitted = details.comments.length - comments.length;
	return [
		`# ${owner}/${repo}#${details.number}: ${details.title}`,
		'',
		`- URL: ${details.url}`,
		`- State: ${details.state}`,
		`- Author: ${details.author.login} (${details.authorAssociation})`,
		`- Labels: ${details.labels.join(', ') || 'none'}`,
		`- Created: ${details.createdAt}`,
		'',
		'## Description',
		'',
		clip(details.body, BODY_LIMIT) || '_No description._',
		'',
		`## Comments (${details.comments.length})`,
		...(omitted > 0 ? ['', `_${omitted} older comments omitted._`] : []),
		...comments.flatMap((comment) => [
			'',
			`### ${comment.author.login}${comment.authorIsBot ? ' [bot]' : ''} (${comment.createdAt})`,
			'',
			clip(comment.body, COMMENT_BODY_LIMIT),
		]),
		'',
	].join('\n');
}

export async function createIssue(
	client: InstallationClient,
	owner: string,
	repo: string,
	issue: { title: string; body: string },
): Promise<{ number: number; url: string }> {
	const { data } = await client.rest.issues.create({
		owner,
		repo,
		title: issue.title,
		body: issue.body,
	});
	return { number: data.number, url: data.html_url };
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n\n… [truncated]`;
}
