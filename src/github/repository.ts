import type {
	ReviewAgentInput,
	ReviewWorkflowParams,
	SkillSnapshot,
} from '../contracts/review.ts';
import { parseRepositoryConfig, REPOSITORY_CONFIG_PATH } from './config.ts';
import type { InstallationClient } from './client.ts';
import {
	assertSkillFileBudget,
	createSkillSnapshot,
	MAX_SKILL_BYTES,
} from './skill.ts';

export type ReviewSetup =
	| { outcome: 'ignored'; reason: string }
	| { outcome: 'stale'; reason: string }
	| { outcome: 'ready'; agentInput: ReviewAgentInput };

export async function loadReviewSetup(
	client: InstallationClient,
	trigger: ReviewWorkflowParams,
): Promise<ReviewSetup> {
	const pull = await client.rest.pulls.get({
		owner: trigger.owner,
		repo: trigger.repo,
		pull_number: trigger.pullNumber,
	});

	if (pull.data.state !== 'open') {
		return { outcome: 'stale', reason: 'The pull request is no longer open.' };
	}
	if (pull.data.head.sha !== trigger.headSha) {
		return { outcome: 'stale', reason: 'The pull request head changed before review started.' };
	}

	let configSource: string;
	try {
		configSource = await readRepositoryFile(
			client,
			trigger.owner,
			trigger.repo,
			REPOSITORY_CONFIG_PATH,
			trigger.baseSha,
		);
	} catch (error) {
		if (isGitHubStatus(error, 404)) {
			return {
				outcome: 'ignored',
				reason: `${REPOSITORY_CONFIG_PATH} does not exist at the pull request base SHA.`,
			};
		}
		throw error;
	}

	const config = parseRepositoryConfig(configSource);
	if (config.trigger.label !== trigger.label) {
		return {
			outcome: 'ignored',
			reason: `Label "${trigger.label}" does not match configured label "${config.trigger.label}".`,
		};
	}
	const labels = pull.data.labels.map((label) => (typeof label === 'string' ? label : label.name));
	if (!labels.includes(config.trigger.label)) {
		return { outcome: 'stale', reason: 'The trigger label was removed before review started.' };
	}

	const skill = await readSkillSnapshot(
		client,
		trigger.owner,
		trigger.repo,
		config.review.skill,
		trigger.baseSha,
	);

	return {
		outcome: 'ready',
		agentInput: {
			deliveryId: trigger.deliveryId,
			installationId: trigger.installationId,
			repositoryId: trigger.repositoryId,
			owner: trigger.owner,
			repo: trigger.repo,
			pullNumber: trigger.pullNumber,
			baseSha: trigger.baseSha,
			headSha: trigger.headSha,
			title: pull.data.title,
			body: pull.data.body ?? '',
			triggerLabel: config.trigger.label,
			skill,
		},
	};
}

async function readSkillSnapshot(
	client: InstallationClient,
	owner: string,
	repo: string,
	directory: string,
	ref: string,
): Promise<SkillSnapshot> {
	const files: Record<string, string> = {};
	await readDirectory(client, owner, repo, directory, directory, ref, files);
	assertSkillFileBudget(files);
	return createSkillSnapshot(directory, files);
}

async function readDirectory(
	client: InstallationClient,
	owner: string,
	repo: string,
	root: string,
	path: string,
	ref: string,
	files: Record<string, string>,
): Promise<void> {
	const response = await client.rest.repos.getContent({ owner, repo, path, ref });
	if (!Array.isArray(response.data)) {
		throw new Error(`${path} must be a directory.`);
	}

	for (const entry of response.data) {
		if (entry.type === 'dir') {
			await readDirectory(client, owner, repo, root, entry.path, ref, files);
			continue;
		}
		if (entry.type !== 'file') {
			throw new Error(`Review skills cannot contain ${entry.type} entries (${entry.path}).`);
		}
		if (Object.keys(files).length >= 32) {
			throw new Error('The review skill contains too many files.');
		}
		if (entry.size > MAX_SKILL_BYTES) {
			throw new Error(`${entry.path} exceeds the review skill size limit.`);
		}

		const blob = await client.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
		const relativePath = entry.path.slice(root.length + 1);
		files[relativePath] = decodeText(blob.data.content, blob.data.encoding, entry.path);
		assertSkillFileBudget(files);
	}
}

async function readRepositoryFile(
	client: InstallationClient,
	owner: string,
	repo: string,
	path: string,
	ref: string,
): Promise<string> {
	const response = await client.rest.repos.getContent({ owner, repo, path, ref });
	if (Array.isArray(response.data) || response.data.type !== 'file' || !('content' in response.data)) {
		throw new Error(`${path} must be a file.`);
	}
	return decodeText(response.data.content, response.data.encoding, path);
}

function decodeText(content: string, encoding: string, path: string): string {
	if (encoding !== 'base64') {
		throw new Error(`${path} uses unsupported encoding ${encoding}.`);
	}

	const bytes = Uint8Array.from(Buffer.from(content.replaceAll('\n', ''), 'base64'));
	if (bytes.includes(0)) {
		throw new Error(`${path} is binary; review skills must contain text files only.`);
	}

	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		throw new Error(`${path} is not valid UTF-8.`);
	}
}

function isGitHubStatus(error: unknown, status: number): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		(error as { status?: unknown }).status === status
	);
}
