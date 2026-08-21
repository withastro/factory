/**
 * Skill snapshots: a named directory of markdown/text files that gets mounted
 * into an agent's workspace. Snapshots come either from the factory's bundled
 * defaults or from the target repository (default-branch content only).
 */

import { load as parseYaml } from 'js-yaml';
import * as v from 'valibot';
import type { InstallationClient } from './client.ts';
import { decodeText } from './content.ts';

export const MAX_SKILL_FILES = 32;
export const MAX_SKILL_BYTES = 256 * 1024;

export const skillSnapshotSchema = v.object({
	name: v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
	directory: v.pipe(v.string(), v.trim(), v.minLength(1)),
	files: v.record(v.string(), v.string()),
});

export type SkillSnapshot = v.InferOutput<typeof skillSnapshotSchema>;

const skillMetadataSchema = v.object({
	name: v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
	description: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_024)),
});

export function createSkillSnapshot(
	directory: string,
	files: Record<string, string>,
): SkillSnapshot {
	const skillSource = files['SKILL.md'];
	if (!skillSource) {
		throw new Error(`${directory}/SKILL.md is required.`);
	}

	const metadata = parseSkillMetadata(skillSource);
	const expectedName = directory.split('/').at(-1);
	if (metadata.name !== expectedName) {
		throw new Error(
			`Skill name "${metadata.name}" must match directory "${expectedName}".`,
		);
	}

	return { name: metadata.name, directory, files };
}

export function parseSkillMetadata(source: string): {
	name: string;
	description: string;
} {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
	if (!match?.[1]) {
		throw new Error('SKILL.md must start with YAML frontmatter.');
	}

	return v.parse(skillMetadataSchema, parseYaml(match[1]));
}

export function assertSkillFileBudget(files: Record<string, string>): void {
	const entries = Object.entries(files);
	if (entries.length > MAX_SKILL_FILES) {
		throw new Error(`A skill may contain at most ${MAX_SKILL_FILES} files.`);
	}

	const bytes = entries.reduce(
		(total, [path, content]) =>
			total + new TextEncoder().encode(path + content).byteLength,
		0,
	);
	if (bytes > MAX_SKILL_BYTES) {
		throw new Error(`A skill may contain at most ${MAX_SKILL_BYTES} bytes.`);
	}
}

export function validateSkillDirectory(path: string): string {
	if (path.includes('\\') || path.startsWith('/') || path.endsWith('/')) {
		throw new Error('A skill must be a relative directory path.');
	}

	const parts = path.split('/');
	if (
		parts.length !== 3 ||
		parts[0] !== '.agents' ||
		parts[1] !== 'skills' ||
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parts[2] ?? '')
	) {
		throw new Error('A skill must match .agents/skills/<skill-name>.');
	}

	return parts.join('/');
}

/**
 * Read a skill directory from the target repository at an immutable ref.
 * Applies the same file-count and byte budgets as bundled skills.
 */
export async function readSkillSnapshot(
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
	const response = await client.rest.repos.getContent({
		owner,
		repo,
		path,
		ref,
	});
	if (!Array.isArray(response.data)) {
		throw new Error(`${path} must be a directory.`);
	}

	for (const entry of response.data) {
		if (entry.type === 'dir') {
			await readDirectory(client, owner, repo, root, entry.path, ref, files);
			continue;
		}
		if (entry.type !== 'file') {
			throw new Error(
				`Skills cannot contain ${entry.type} entries (${entry.path}).`,
			);
		}
		if (Object.keys(files).length >= MAX_SKILL_FILES) {
			throw new Error('The skill contains too many files.');
		}
		if (entry.size > MAX_SKILL_BYTES) {
			throw new Error(`${entry.path} exceeds the skill size limit.`);
		}

		const blob = await client.rest.git.getBlob({
			owner,
			repo,
			file_sha: entry.sha,
		});
		const relativePath = entry.path.slice(root.length + 1);
		files[relativePath] = decodeText(
			blob.data.content,
			blob.data.encoding,
			entry.path,
		);
		assertSkillFileBudget(files);
	}
}
