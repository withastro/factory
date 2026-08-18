/**
 * Repository configuration: `.github/factory.yml` in the target repository.
 *
 * Every section is optional. A repository with no configuration file at all
 * gets triage with all defaults and no review capability. A configured review
 * section uses the bundled review skill unless the repository provides an
 * override. Configuration is always read from maintainer controlled content
 * (the default branch or the pull request's target branch), never from PR heads
 * or forks.
 */

import { load as parseYaml } from 'js-yaml';
import * as v from 'valibot';
import type { InstallationClient } from './github/client.ts';
import { isGitHubStatus, readRepositoryFile } from './github/content.ts';
import { validateSkillDirectory } from './github/skill.ts';
import {
	CODE_MODEL,
	isSupportedModel,
	MODEL_PROVIDERS,
	VERIFICATION_MODEL,
} from './models.ts';
import { DEFAULT_TRIAGE_LABELS, type TriageLabelConfig } from './triage/labels.ts';
import {
	DEFAULT_PREVIEW_CHECK_APP,
	DEFAULT_PREVIEW_CHECK_NAME,
	DEFAULT_PREVIEW_HOSTS,
} from './triage/preview-release.ts';

export const REPOSITORY_CONFIG_PATHS = ['.github/factory.yml', '.github/factory.yaml'] as const;

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

const labelNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50));

/**
 * A `<provider>/<model>` specifier. Validated here rather than at the first
 * model call so a typo surfaces as a configuration error instead of failing
 * partway through an agent run.
 */
const modelSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1),
	v.maxLength(200),
	v.check(
		isSupportedModel,
		`A model must be "<provider>/<model>", where provider is one of: ${MODEL_PROVIDERS.join(', ')}.`,
	),
);

/**
 * A shell command run in the sandbox checkout.
 *
 * Deliberately unrestricted apart from its shape: it is maintainer-authored
 * content read from the default branch, and it runs in a sandbox that holds no
 * credentials, so it grants nothing the repository's own CI doesn't already
 * have. Control characters are rejected so the command stays a single
 * inspectable line in logs rather than something that can smuggle in extra
 * statements past a reviewer reading the config.
 */
const commandSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1),
	v.maxLength(500),
	v.check((value) => !/[\u0000-\u001f\u007f]/.test(value), 'A command must be a single line.'),
);

const factoryConfigSchema = v.object({
	version: v.literal(1),
	review: v.optional(
		v.object({
			trigger: v.object({ label: labelNameSchema }),
			skill: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
			model: v.optional(modelSchema),
			severity: v.optional(classificationListSchema),
			areas: v.optional(classificationListSchema),
		}),
	),
	triage: v.optional(
		v.object({
			enabled: v.optional(v.boolean()),
			autoPrOnFix: v.optional(v.boolean()),
			skill: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
			model: v.optional(modelSchema),
			verificationModel: v.optional(modelSchema),
			buildCommand: v.optional(commandSchema),
			previewRelease: v.optional(
				v.object({
					workflow: v.pipe(
						v.string(),
						v.trim(),
						v.minLength(1),
						v.maxLength(200),
						// The dispatch API wants a bare filename, but writing the path
						// you'd see in the repository is the obvious mistake to make.
						v.transform((value) => value.replace(/^\.github\/workflows\//, '')),
						v.regex(/^[A-Za-z0-9._-]+\.ya?ml$/),
					),
					check: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100))),
					checkApp: v.optional(
						v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
					),
					allowedHosts: v.optional(
						v.pipe(
							v.array(
								v.pipe(
									v.string(),
									v.trim(),
									v.minLength(1),
									v.maxLength(253),
									v.regex(/^[A-Za-z0-9.-]+$/),
								),
							),
							v.minLength(1),
							v.maxLength(10),
						),
					),
				}),
			),
			labels: v.optional(v.partial(v.object(labelConfigShape()))),
		}),
	),
});

function labelConfigShape() {
	return Object.fromEntries(
		Object.keys(DEFAULT_TRIAGE_LABELS).map((key) => [key, labelNameSchema]),
	) as Record<keyof TriageLabelConfig, typeof labelNameSchema>;
}

export interface ReviewConfig {
	trigger: { label: string };
	/** Repository skill override; the bundled default skill is used when absent. */
	skill: string | undefined;
	/** `<provider>/<model>` for the reviewer agent. */
	model: string;
	severity: string[];
	areas: string[];
}

/**
 * Opt-in preview releases. `workflow` is a maintainer-owned
 * `workflow_dispatch` workflow file in `.github/workflows`; `checkName` is the
 * check run that workflow publishes its results to.
 *
 * `checkApp` and `allowedHosts` are the trust boundary for the reported
 * results: the check must come from the expected app, and the URLs it reports
 * must live on an expected host, because the workflow producing them has run
 * agent-authored build scripts.
 */
export interface PreviewReleaseConfig {
	workflow: string;
	checkName: string;
	checkApp: string;
	allowedHosts: string[];
}

export interface TriageConfig {
	enabled: boolean;
	autoPrOnFix: boolean;
	/** Repository skill override; the bundled default skill is used when absent. */
	skill: string | undefined;
	/** `<provider>/<model>` for the reproduce/diagnose/fix pipeline agent. */
	model: string;
	/**
	 * `<provider>/<model>` for the small classification agents (fix
	 * verification, retriage decisions). These read conversation text and get
	 * no tools, so they do not need a coding model.
	 */
	verificationModel: string;
	/**
	 * Shell command that builds the checkout before the pipeline agent starts,
	 * run once from the repository root. Absent means no build happens: the
	 * agent gets a bare checkout and has to bootstrap the repository itself
	 * from the skill's instructions.
	 *
	 * A monorepo whose packages resolve through built output (`dist/`) needs
	 * this, or every reproduction attempt fails on the unbuilt workspace rather
	 * than on the reported bug.
	 */
	buildCommand: string | undefined;
	/** Absent means the repository publishes no preview releases. */
	previewRelease: PreviewReleaseConfig | undefined;
	labels: TriageLabelConfig;
}

export interface FactoryConfig {
	review: ReviewConfig | undefined;
	triage: TriageConfig;
}

/** Configuration used when the repository has no factory.yml at all. */
export function defaultFactoryConfig(): FactoryConfig {
	return {
		review: undefined,
		triage: {
			enabled: true,
			autoPrOnFix: false,
			skill: undefined,
			model: CODE_MODEL,
			verificationModel: VERIFICATION_MODEL,
			buildCommand: undefined,
			previewRelease: undefined,
			labels: { ...DEFAULT_TRIAGE_LABELS },
		},
	};
}

export function parseFactoryConfig(source: string): FactoryConfig {
	const config = v.parse(factoryConfigSchema, parseYaml(source));
	return {
		review: config.review
			? {
					trigger: config.review.trigger,
					skill: config.review.skill
						? validateSkillDirectory(config.review.skill)
						: undefined,
					model: config.review.model ?? CODE_MODEL,
					severity: config.review.severity ?? [...DEFAULT_SEVERITIES],
					areas: config.review.areas ?? [...DEFAULT_AREAS],
				}
			: undefined,
		triage: {
			enabled: config.triage?.enabled ?? true,
			autoPrOnFix: config.triage?.autoPrOnFix ?? false,
			skill: config.triage?.skill ? validateSkillDirectory(config.triage.skill) : undefined,
			model: config.triage?.model ?? CODE_MODEL,
			verificationModel: config.triage?.verificationModel ?? VERIFICATION_MODEL,
			buildCommand: config.triage?.buildCommand,
			previewRelease: config.triage?.previewRelease
				? {
						workflow: config.triage.previewRelease.workflow,
						checkName: config.triage.previewRelease.check ?? DEFAULT_PREVIEW_CHECK_NAME,
						checkApp: config.triage.previewRelease.checkApp ?? DEFAULT_PREVIEW_CHECK_APP,
						allowedHosts: config.triage.previewRelease.allowedHosts ?? [
							...DEFAULT_PREVIEW_HOSTS,
						],
					}
				: undefined,
			labels: { ...DEFAULT_TRIAGE_LABELS, ...config.triage?.labels },
		},
	};
}

/**
 * Load `.github/factory.yml` at the given ref. Returns the all-defaults
 * configuration when neither config path exists.
 */
export async function loadFactoryConfig(
	client: InstallationClient,
	owner: string,
	repo: string,
	ref: string,
): Promise<{ config: FactoryConfig; explicit: boolean }> {
	for (const path of REPOSITORY_CONFIG_PATHS) {
		try {
			const source = await readRepositoryFile(client, owner, repo, path, ref);
			return { config: parseFactoryConfig(source), explicit: true };
		} catch (error) {
			if (!isGitHubStatus(error, 404)) throw error;
		}
	}
	return { config: defaultFactoryConfig(), explicit: false };
}
