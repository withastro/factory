import { load as parseYaml } from 'js-yaml';
import * as v from 'valibot';

export const REPOSITORY_CONFIG_PATH = '.github/astro-review.yml';

const repositoryConfigSchema = v.object({
	version: v.literal(1),
	trigger: v.object({
		label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50)),
	}),
	review: v.object({
		skill: v.pipe(v.string(), v.trim(), v.minLength(1)),
	}),
});

export type RepositoryConfig = v.InferOutput<typeof repositoryConfigSchema>;

export function parseRepositoryConfig(source: string): RepositoryConfig {
	const config = v.parse(repositoryConfigSchema, parseYaml(source));
	return {
		...config,
		review: { skill: validateSkillDirectory(config.review.skill) },
	};
}

export function validateSkillDirectory(path: string): string {
	if (path.includes('\\') || path.startsWith('/') || path.endsWith('/')) {
		throw new Error('review.skill must be a relative directory path.');
	}

	const parts = path.split('/');
	if (
		parts.length !== 3 ||
		parts[0] !== '.agents' ||
		parts[1] !== 'skills' ||
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parts[2] ?? '')
	) {
		throw new Error('review.skill must match .agents/skills/<skill-name>.');
	}

	return parts.join('/');
}
