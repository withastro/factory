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
import {
	DEFAULT_TRIAGE_LABELS,
	type TriageLabelConfig,
} from './triage/labels.ts';
import {
	DEFAULT_PREVIEW_CHECK_APP,
	DEFAULT_PREVIEW_CHECK_NAME,
	DEFAULT_PREVIEW_HOSTS,
} from './triage/preview-release.ts';

export const REPOSITORY_CONFIG_PATHS = [
	'.github/factory.yml',
	'.github/factory.yaml',
] as const;

export const DEFAULT_SEVERITIES = [
	'critical',
	'high',
	'medium',
	'low',
] as const;
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

/**
 * Install step used when a repository configures none.
 *
 * Defaulted rather than left empty because nearly every repository the factory
 * runs on is a pnpm workspace, and an uninstalled checkout can't reproduce
 * anything. The lockfile is deliberately not frozen: the agent may add a
 * dependency while building a reproduction, and a run that dies on a lockfile
 * mismatch has failed for a reason that has nothing to do with the bug.
 *
 * A repository that isn't a pnpm workspace has to say so with
 * `installCommand: []`, or its own install command.
 */
export const DEFAULT_INSTALL_COMMAND = [
	'pnpm install --no-frozen-lockfile',
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
		(values) =>
			new Set(values.map((value) => value.toLowerCase())).size ===
			values.length,
		'Classification values must be unique.',
	),
);

const labelNameSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1),
	v.maxLength(50),
);

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

const MAX_COMMANDS = 20;
const MAX_COMMAND_LENGTH = 500;

/**
 * Raw text for one or more shell commands.
 *
 * Deliberately unrestricted apart from its shape: commands are
 * maintainer-authored content read from the default branch, and they run in a
 * sandbox that holds no credentials, so they grant nothing the repository's own
 * CI doesn't already have. Tabs and newlines are allowed because YAML block
 * scalars carry them; the remaining control characters are rejected so a
 * command can't hide extra statements from someone reading the config.
 */
const commandTextSchema = v.pipe(
	v.string(),
	v.maxLength(MAX_COMMANDS * MAX_COMMAND_LENGTH),
	v.check(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: checked un purpose
		(value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
		'A command must not contain control characters.',
	),
);

/**
 * Split configured command text into one command per line, so all three ways of
 * writing this in YAML mean the same thing:
 *
 *     buildCommand: pnpm build
 *     buildCommand: [pnpm install, pnpm build]
 *     buildCommand: |
 *       pnpm install
 *       pnpm build
 *
 * Splitting on newlines rather than treating a block scalar as one script keeps
 * every command independently reportable, and gives each line `&&` semantics
 * without anyone having to write `&&`: the runner stops at the first failure.
 * The cost is that a command cannot span lines, so multi-line shell constructs
 * have to be written on one line.
 */
function splitCommands(value: string | string[]): string[] {
	return (Array.isArray(value) ? value : [value])
		.flatMap((entry) => entry.split('\n'))
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/** Bounds applied to the split result, whichever syntax produced it. */
const splitCommandsSchema = v.pipe(
	v.array(v.pipe(v.string(), v.maxLength(MAX_COMMAND_LENGTH))),
	v.maxLength(MAX_COMMANDS),
);

const commandListSchema = v.union([
	// A string has to name at least one command: writing an empty one is a
	// mistake, not a way to say "do nothing".
	v.pipe(
		commandTextSchema,
		v.transform((value: string) => splitCommands(value)),
		v.minLength(1),
		splitCommandsSchema,
	),
	// An empty list is how a repository switches a defaulted command off.
	v.pipe(
		v.array(commandTextSchema),
		v.transform((value: string[]) => splitCommands(value)),
		splitCommandsSchema,
	),
]);

const factoryConfigSchema = v.object({
	version: v.literal(1),
	adversary: v.optional(
		v.object({
			trigger: v.object({ label: labelNameSchema }),
			blueTeam: v.optional(
				v.object({
					skill: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
					model: v.optional(modelSchema),
				}),
			),
			purpleTeam: v.optional(
				v.object({
					skill: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
					model: v.optional(modelSchema),
				}),
			),
		}),
	),
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
			prWriterSkill: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
			model: v.optional(modelSchema),
			verificationModel: v.optional(modelSchema),
			installCommand: v.optional(commandListSchema),
			buildCommand: v.optional(commandListSchema),
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
					check: v.optional(
						v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
					),
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

export interface AdversaryConfig {
	trigger: { label: string };
	blueTeam: {
		skill: string | undefined;
		model: string;
	};
	purpleTeam: {
		skill: string | undefined;
		model: string;
	};
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
	/** Repository skill with additional pull request writing guidance. */
	prWriterSkill: string | undefined;
	/** `<provider>/<model>` for the reproduce/diagnose/fix pipeline agent. */
	model: string;
	/**
	 * `<provider>/<model>` for the small classification agents (fix
	 * verification, retriage decisions). These read conversation text and get
	 * no tools, so they do not need a coding model.
	 */
	verificationModel: string;
	/**
	 * Commands that install the checkout's dependencies, run in order from the
	 * repository root before {@link buildCommand}. Defaults to
	 * {@link DEFAULT_INSTALL_COMMAND}; an empty list means no install.
	 */
	installCommand: string[];
	/**
	 * Commands that build the checkout, run in order from the repository root
	 * after {@link installCommand} and before the pipeline agent starts. Empty
	 * by default, because most repositories don't need building to reproduce a
	 * bug.
	 *
	 * A monorepo whose packages resolve through built output (`dist/`) does need
	 * it, or every reproduction attempt fails on the unbuilt workspace rather
	 * than on the reported bug.
	 */
	buildCommand: string[];
	/** Absent means the repository publishes no preview releases. */
	previewRelease: PreviewReleaseConfig | undefined;
	labels: TriageLabelConfig;
}

export interface FactoryConfig {
	adversary: AdversaryConfig | undefined;
	review: ReviewConfig | undefined;
	triage: TriageConfig;
}

/** Configuration used when the repository has no factory.yml at all. */
export function defaultFactoryConfig(): FactoryConfig {
	return {
		adversary: undefined,
		review: undefined,
		triage: {
			enabled: true,
			autoPrOnFix: false,
			skill: undefined,
			prWriterSkill: undefined,
			model: CODE_MODEL,
			verificationModel: VERIFICATION_MODEL,
			installCommand: [...DEFAULT_INSTALL_COMMAND],
			buildCommand: [],
			previewRelease: undefined,
			labels: { ...DEFAULT_TRIAGE_LABELS },
		},
	};
}

export function parseFactoryConfig(source: string): FactoryConfig {
	const config = v.parse(factoryConfigSchema, parseYaml(source));
	if (
		config.adversary &&
		config.review &&
		config.adversary.trigger.label.toLowerCase() ===
			config.review.trigger.label.toLowerCase()
	) {
		throw new Error('Adversary and review trigger labels must differ.');
	}
	return {
		adversary: config.adversary
			? {
					trigger: config.adversary.trigger,
					blueTeam: {
						skill: config.adversary.blueTeam?.skill
							? validateSkillDirectory(config.adversary.blueTeam.skill)
							: undefined,
						model: config.adversary.blueTeam?.model ?? CODE_MODEL,
					},
					purpleTeam: {
						skill: config.adversary.purpleTeam?.skill
							? validateSkillDirectory(config.adversary.purpleTeam.skill)
							: undefined,
						model: config.adversary.purpleTeam?.model ?? CODE_MODEL,
					},
				}
			: undefined,
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
			skill: config.triage?.skill
				? validateSkillDirectory(config.triage.skill)
				: undefined,
			prWriterSkill: config.triage?.prWriterSkill
				? validateSkillDirectory(config.triage.prWriterSkill)
				: undefined,
			model: config.triage?.model ?? CODE_MODEL,
			verificationModel: config.triage?.verificationModel ?? VERIFICATION_MODEL,
			installCommand: config.triage?.installCommand ?? [
				...DEFAULT_INSTALL_COMMAND,
			],
			buildCommand: config.triage?.buildCommand ?? [],
			previewRelease: config.triage?.previewRelease
				? {
						workflow: config.triage.previewRelease.workflow,
						checkName:
							config.triage.previewRelease.check ?? DEFAULT_PREVIEW_CHECK_NAME,
						checkApp:
							config.triage.previewRelease.checkApp ??
							DEFAULT_PREVIEW_CHECK_APP,
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
