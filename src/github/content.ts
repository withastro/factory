/**
 * Shared helpers for reading repository content through the GitHub API.
 */

import type { InstallationClient } from './client.ts';

export async function readRepositoryFile(
	client: InstallationClient,
	owner: string,
	repo: string,
	path: string,
	ref: string,
): Promise<string> {
	const response = await client.rest.repos.getContent({
		owner,
		repo,
		path,
		ref,
	});
	if (
		Array.isArray(response.data) ||
		response.data.type !== 'file' ||
		!('content' in response.data)
	) {
		throw new Error(`${path} must be a file.`);
	}
	return decodeText(response.data.content, response.data.encoding, path);
}

export function decodeText(
	content: string,
	encoding: string,
	path: string,
): string {
	if (encoding !== 'base64') {
		throw new Error(`${path} uses unsupported encoding ${encoding}.`);
	}

	const bytes = Uint8Array.from(
		Buffer.from(content.replaceAll('\n', ''), 'base64'),
	);
	if (bytes.includes(0)) {
		throw new Error(`${path} is binary; only text files are supported here.`);
	}

	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
			bytes,
		);
	} catch {
		throw new Error(`${path} is not valid UTF-8.`);
	}
}

export function isGitHubStatus(error: unknown, status: number): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		(error as { status?: unknown }).status === status
	);
}
