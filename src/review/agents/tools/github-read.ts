import { useTool } from '@flue/runtime';
import * as v from 'valibot';
import {
	createInstallationClient,
	credentialsFromProcess,
	type InstallationClient,
} from '../../../github/client.ts';
import type { ReviewAgentInput } from '../../contracts.ts';

const pageSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(30));
const repositoryPathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(4_096));
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export function useGitHubReviewTools(reviewContext: ReviewAgentInput): void {
	useTool({
		name: 'get_pull_request_context',
		description: 'Read the title, description, and immutable commit SHAs for the pull request.',
		run() {
			return {
				output: {
					owner: reviewContext.owner,
					repository: reviewContext.repo,
					pullNumber: reviewContext.pullNumber,
					title: reviewContext.title,
					body: reviewContext.body,
					baseSha: reviewContext.baseSha,
					headSha: reviewContext.headSha,
				},
			};
		},
	});

	useTool({
		name: 'list_changed_files',
		description: 'List one page of files changed by the pull request. Pages contain up to 100 files.',
		input: v.object({ page: v.optional(pageSchema) }),
		async run({ data }) {
			const page = data.page ?? 1;
			const client = await reviewClient(reviewContext);
			const response = await client.rest.pulls.listFiles({
				owner: reviewContext.owner,
				repo: reviewContext.repo,
				pull_number: reviewContext.pullNumber,
				per_page: 100,
				page,
			});
			return {
				output: {
					page,
					hasNextPage: response.data.length === 100,
					files: response.data.map((file) => ({
						path: file.filename,
						status: file.status,
						additions: file.additions,
						deletions: file.deletions,
						changes: file.changes,
						hasPatch: typeof file.patch === 'string',
					})),
				},
			};
		},
	});

	useTool({
		name: 'get_file_diff',
		description: 'Read the GitHub diff patch for one changed file.',
		input: v.object({ path: repositoryPathSchema }),
		async run({ data }) {
			assertRepositoryPath(data.path);
			const file = await findChangedFile(
				await reviewClient(reviewContext),
				reviewContext,
				data.path,
			);
			return {
				output: {
					path: file.filename,
					status: file.status,
					patch: file.patch ?? null,
					message: file.patch ? null : 'GitHub omitted this patch; use read_file for context.',
				},
			};
		},
	});

	useTool({
		name: 'read_file',
		description:
			'Read up to 400 numbered lines from a repository file at the exact base or head commit.',
		input: v.object({
			path: repositoryPathSchema,
			version: v.picklist(['base', 'head']),
			startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
			lineCount: v.optional(
				v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(400)),
			),
		}),
		async run({ data }) {
			assertRepositoryPath(data.path);
			const client = await reviewClient(reviewContext);
			const ref = data.version === 'base' ? reviewContext.baseSha : reviewContext.headSha;
			const response = await client.rest.repos.getContent({
				owner: reviewContext.owner,
				repo: reviewContext.repo,
				path: data.path,
				ref,
			});
			if (Array.isArray(response.data) || response.data.type !== 'file') {
				throw new Error(`${data.path} is not a file.`);
			}

			const blob = await client.rest.git.getBlob({
				owner: reviewContext.owner,
				repo: reviewContext.repo,
				file_sha: response.data.sha,
			});
			if (blob.data.size === null || blob.data.size > 2 * 1024 * 1024) {
				throw new Error(`${data.path} exceeds the 2 MiB review limit.`);
			}

			const source = decodeBlob(blob.data.content, blob.data.encoding, data.path);
			const lines = source.split('\n');
			const startLine = data.startLine ?? 1;
			const lineCount = data.lineCount ?? 200;
			const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
			return {
				output: {
					path: data.path,
					version: data.version,
					startLine,
					endLine: startLine + selected.length - 1,
					totalLines: lines.length,
					content: selected
						.map((line, index) => `${startLine + index}: ${line}`)
						.join('\n'),
				},
			};
		},
	});
}

async function reviewClient(reviewContext: ReviewAgentInput): Promise<InstallationClient> {
	return createInstallationClient(credentialsFromProcess(), reviewContext.installationId);
}

async function findChangedFile(
	client: InstallationClient,
	reviewContext: ReviewAgentInput,
	path: string,
) {
	for (let page = 1; page <= 30; page += 1) {
		const response = await client.rest.pulls.listFiles({
			owner: reviewContext.owner,
			repo: reviewContext.repo,
			pull_number: reviewContext.pullNumber,
			per_page: 100,
			page,
		});
		const match = response.data.find((file) => file.filename === path);
		if (match) return match;
		if (response.data.length < 100) break;
	}
	throw new Error(`${path} is not changed by this pull request.`);
}

function assertRepositoryPath(path: string): void {
	if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
		throw new Error('Repository paths must be safe relative paths.');
	}
}

function decodeBlob(content: string, encoding: string, path: string): string {
	if (encoding !== 'base64') throw new Error(`${path} uses unsupported encoding ${encoding}.`);
	const bytes = Uint8Array.from(Buffer.from(content.replaceAll('\n', ''), 'base64'));
	if (bytes.includes(0)) throw new Error(`${path} is binary.`);
	try {
		return utf8Decoder.decode(bytes);
	} catch {
		throw new Error(`${path} is not valid UTF-8.`);
	}
}
