import { load as parseYaml } from 'js-yaml';
import * as v from 'valibot';
import type { SkillSnapshot } from '../contracts/review.ts';

export const MAX_SKILL_FILES = 32;
export const MAX_SKILL_BYTES = 256 * 1024;

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
		throw new Error(`Skill name "${metadata.name}" must match directory "${expectedName}".`);
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
		throw new Error(`A review skill may contain at most ${MAX_SKILL_FILES} files.`);
	}

	const bytes = entries.reduce(
		(total, [path, content]) => total + new TextEncoder().encode(path + content).byteLength,
		0,
	);
	if (bytes > MAX_SKILL_BYTES) {
		throw new Error(`A review skill may contain at most ${MAX_SKILL_BYTES} bytes.`);
	}
}
