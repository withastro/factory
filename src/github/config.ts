import { load as parseYaml } from 'js-yaml';
import * as v from 'valibot';

export const REPOSITORY_CONFIG_PATHS = [
	'.github/astro-review.yml',
	'.github/astro-review.yaml',
] as const;
export const DEFAULT_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const DEFAULT_AREAS = [
	'design',
	'correctness',
	'security',
	'runtime',
	'completeness',
	'error-handling',
	'tests',
	'maintainability',
	'documentation',
	'changeset',
] as const;

const classificationValueSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1),
	v.maxLength(50),
	v.regex(/^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/),
);
const classificationListSchema = v.pipe(
	v.array(classificationValueSchema),
	v.minLength(1),
	v.maxLength(50),
	v.check(
		(values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
		'Classification values must be unique.',
	),
);

const repositoryConfigSchema = v.object({
	version: v.literal(1),
	trigger: v.object({
		label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50)),
	}),
	review: v.object({
		skill: v.pipe(v.string(), v.trim(), v.minLength(1)),
		severity: v.optional(classificationListSchema),
		areas: v.optional(classificationListSchema),
	}),
});

export interface RepositoryConfig {
	version: 1;
	trigger: { label: string };
	review: {
		skill: string;
		severity: string[];
		areas: string[];
	};
}

export function parseRepositoryConfig(source: string): RepositoryConfig {
	const config = v.parse(repositoryConfigSchema, parseYaml(source));
	return {
		...config,
		review: {
			skill: validateSkillDirectory(config.review.skill),
			severity: config.review.severity ?? [...DEFAULT_SEVERITIES],
			areas: config.review.areas ?? [...DEFAULT_AREAS],
		},
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
