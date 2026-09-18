import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AREAS,
	DEFAULT_INSTALL_COMMAND,
	DEFAULT_SEVERITIES,
	defaultFactoryConfig,
	parseFactoryConfig,
} from '../src/config.ts';
import {
	assertSkillFileBudget,
	createSkillSnapshot,
	MAX_SKILL_BYTES,
	validateSkillDirectory,
} from '../src/github/skill.ts';
import { CODE_MODEL, VERIFICATION_MODEL } from '../src/models.ts';
import { DEFAULT_TRIAGE_LABELS } from '../src/triage/labels.ts';

describe('factory configuration', () => {
	it('parses a review section with defaults applied', () => {
		expect(
			parseFactoryConfig(`
version: 1
review:
  trigger:
    label: ai-review
  skill: .agents/skills/astro-review
`),
		).toEqual({
			adversary: undefined,
			review: {
				trigger: { label: 'ai-review' },
				skill: '.agents/skills/astro-review',
				model: CODE_MODEL,
				severity: [...DEFAULT_SEVERITIES],
				areas: [...DEFAULT_AREAS],
			},
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
		});
	});

	it('uses the bundled review skill when no override is configured', () => {
		expect(
			parseFactoryConfig(`
version: 1
review:
  trigger:
    label: ai-review
`),
		).toMatchObject({
			review: {
				trigger: { label: 'ai-review' },
				skill: undefined,
				severity: [...DEFAULT_SEVERITIES],
				areas: [...DEFAULT_AREAS],
			},
		});
	});

	it('parses an opt-in adversary section with team models', () => {
		expect(
			parseFactoryConfig(`
version: 1
adversary:
  trigger:
    label: ai-adversary
  blueTeam:
    skill: .agents/skills/adversary-blue
    model: cloudflare-ai-gateway/claude-opus-4-6
  purpleTeam:
    skill: .agents/skills/adversary-purple
    model: cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.7-code
`),
		).toMatchObject({
			adversary: {
				trigger: { label: 'ai-adversary' },
				blueTeam: {
					skill: '.agents/skills/adversary-blue',
					model: 'cloudflare-ai-gateway/claude-opus-4-6',
				},
				purpleTeam: {
					skill: '.agents/skills/adversary-purple',
					model:
						'cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.7-code',
				},
			},
		});
	});

	it('keeps adversary disabled unless its section exists', () => {
		expect(parseFactoryConfig('version: 1').adversary).toBeUndefined();
	});

	it('defaults both adversary team models to the coding model', () => {
		expect(
			parseFactoryConfig(
				'version: 1\nadversary:\n  trigger:\n    label: ai-adversary',
			).adversary,
		).toMatchObject({
			blueTeam: { model: CODE_MODEL },
			purpleTeam: { model: CODE_MODEL },
		});
	});

	it('rejects colliding review and adversary labels case-insensitively', () => {
		expect(() =>
			parseFactoryConfig(`
version: 1
adversary:
  trigger:
    label: AI-REVIEW
review:
  trigger:
    label: ai-review
`),
		).toThrow('must differ');
	});

	it('accepts project-defined severity and area vocabularies', () => {
		expect(
			parseFactoryConfig(`
version: 1
review:
  trigger:
    label: ai-review
  skill: .agents/skills/astro-review
  severity: [blocker, advisory]
  areas: [correctness, error-handling]
`),
		).toMatchObject({
			review: {
				severity: ['blocker', 'advisory'],
				areas: ['correctness', 'error-handling'],
			},
		});
	});

	it('rejects empty, duplicate, or markup-bearing classifications', () => {
		for (const classification of ['[]', '[high, HIGH]', '["**security**"]']) {
			expect(() =>
				parseFactoryConfig(`
version: 1
review:
  trigger:
    label: ai-review
  skill: .agents/skills/astro-review
  severity: ${classification}
  areas: [correctness]
`),
			).toThrow();
		}
	});

	it('enables triage with all defaults when the section is absent', () => {
		expect(parseFactoryConfig('version: 1')).toEqual(defaultFactoryConfig());
	});

	it('merges triage label overrides over the defaults', () => {
		const config = parseFactoryConfig(`
version: 1
triage:
  autoPrOnFix: true
  labels:
    fixPending: awaiting-confirmation
`);
		expect(config.triage.autoPrOnFix).toBe(true);
		expect(config.triage.labels.fixPending).toBe('awaiting-confirmation');
		expect(config.triage.labels.needsTriage).toBe(
			DEFAULT_TRIAGE_LABELS.needsTriage,
		);
	});

	it('lets a repository disable triage', () => {
		expect(
			parseFactoryConfig('version: 1\ntriage:\n  enabled: false').triage
				.enabled,
		).toBe(false);
	});

	it('installs with pnpm and builds nothing by default', () => {
		const triage = parseFactoryConfig('version: 1').triage;
		expect(triage.installCommand).toEqual([...DEFAULT_INSTALL_COMMAND]);
		expect(triage.buildCommand).toEqual([]);
	});

	it('accepts a single command as a plain string', () => {
		expect(
			parseFactoryConfig('version: 1\ntriage:\n  buildCommand: pnpm build')
				.triage.buildCommand,
		).toEqual(['pnpm build']);
	});

	it('accepts one command per line as a YAML list', () => {
		expect(
			parseFactoryConfig(`
version: 1
triage:
  installCommand:
    - pnpm install --no-frozen-lockfile
    - git clone --depth 1 https://github.com/withastro/compiler.git .compiler || true
  buildCommand:
    - pnpm build
`).triage,
		).toMatchObject({
			installCommand: [
				'pnpm install --no-frozen-lockfile',
				'git clone --depth 1 https://github.com/withastro/compiler.git .compiler || true',
			],
			buildCommand: ['pnpm build'],
		});
	});

	it('reads a block scalar as one command per line', () => {
		// Same meaning as the list form: no `&&` required to sequence steps.
		expect(
			parseFactoryConfig(`
version: 1
triage:
  buildCommand: |
    pnpm --filter astro build

    pnpm --filter "@astrojs/*" build
`).triage.buildCommand,
		).toEqual([
			'pnpm --filter astro build',
			'pnpm --filter "@astrojs/*" build',
		]);
	});

	it('lets a repository switch the default install off with an empty list', () => {
		expect(
			parseFactoryConfig('version: 1\ntriage:\n  installCommand: []').triage
				.installCommand,
		).toEqual([]);
	});

	it('rejects an empty command string and unusable characters', () => {
		// An empty string is a mistake; `installCommand: []` is how you mean it.
		for (const command of [
			'""',
			"'   '",
			'"pnpm build\\u0000"',
			'"pnpm\\u001bbuild"',
		]) {
			expect(() =>
				parseFactoryConfig(`version: 1\ntriage:\n  buildCommand: ${command}`),
			).toThrow();
		}
	});

	it('rejects more commands than a bootstrap should need', () => {
		const commands = Array.from(
			{ length: 21 },
			(_, index) => `    - echo ${index}`,
		).join('\n');
		expect(() =>
			parseFactoryConfig(`version: 1\ntriage:\n  buildCommand:\n${commands}`),
		).toThrow();
	});

	it('parses an opt-in preview release workflow with the default check name', () => {
		expect(
			parseFactoryConfig(`
version: 1
triage:
  previewRelease:
    workflow: factory-preview.yml
`).triage.previewRelease,
		).toEqual({
			workflow: 'factory-preview.yml',
			checkName: 'factory/preview-release',
			checkApp: 'github-actions',
			allowedHosts: ['pkg.pr.new'],
		});
	});

	it('normalizes the workflow path a maintainer is most likely to write', () => {
		expect(
			parseFactoryConfig(`
version: 1
triage:
  previewRelease:
    workflow: .github/workflows/factory-preview.yml
`).triage.previewRelease?.workflow,
		).toBe('factory-preview.yml');
	});

	it('lets a repository override the check name, app, and trusted hosts', () => {
		expect(
			parseFactoryConfig(`
version: 1
triage:
  previewRelease:
    workflow: preview.yaml
    check: ci/preview
    checkApp: buildkite
    allowedHosts:
      - previews.corp.test
`).triage.previewRelease,
		).toEqual({
			workflow: 'preview.yaml',
			checkName: 'ci/preview',
			checkApp: 'buildkite',
			allowedHosts: ['previews.corp.test'],
		});
	});

	it('leaves preview releases off when the section is absent', () => {
		expect(
			parseFactoryConfig('version: 1\ntriage:\n  enabled: true').triage
				.previewRelease,
		).toBe(undefined);
	});

	it.each([
		'../secrets.yml',
		'nested/dir/preview.yml',
		'preview.txt',
		'preview',
	])('rejects an unsafe or unsupported preview workflow: %s', (workflow) => {
		expect(() =>
			parseFactoryConfig(
				`version: 1\ntriage:\n  previewRelease:\n    workflow: ${workflow}\n`,
			),
		).toThrow();
	});

	it('validates the triage skill override path', () => {
		expect(
			parseFactoryConfig('version: 1\ntriage:\n  skill: .agents/skills/triage')
				.triage.skill,
		).toBe('.agents/skills/triage');
		expect(() =>
			parseFactoryConfig('version: 1\ntriage:\n  skill: skills/triage'),
		).toThrow();
	});

	it('validates the PR writer skill path', () => {
		expect(
			parseFactoryConfig(
				'version: 1\ntriage:\n  prWriterSkill: .agents/skills/astro-pr-writer',
			).triage.prWriterSkill,
		).toBe('.agents/skills/astro-pr-writer');
		expect(() =>
			parseFactoryConfig(
				'version: 1\ntriage:\n  prWriterSkill: skills/astro-pr-writer',
			),
		).toThrow();
	});

	it('rejects unknown versions', () => {
		expect(() => parseFactoryConfig('version: 2')).toThrow();
	});

	it('lets a repository choose gateway-routed Anthropic models', () => {
		const config = parseFactoryConfig(`
version: 1
review:
  trigger:
    label: ai-review
  model: cloudflare-ai-gateway/claude-opus-4-6
triage:
  model: cloudflare-ai-gateway/claude-opus-4-6
  verificationModel: cloudflare-ai-gateway/claude-haiku-4-5
`);
		expect(config.review?.model).toBe('cloudflare-ai-gateway/claude-opus-4-6');
		expect(config.triage.model).toBe('cloudflare-ai-gateway/claude-opus-4-6');
		expect(config.triage.verificationModel).toBe(
			'cloudflare-ai-gateway/claude-haiku-4-5',
		);
	});

	it('routes Workers AI through the same gateway provider', () => {
		const config = parseFactoryConfig(`
version: 1
triage:
  model: cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.7-code
  verificationModel: cloudflare-ai-gateway/claude-haiku-4-5
`);
		// Gateway model ids carry their own routing and vendor segments; only the
		// first segment is the provider, so the rest must survive intact.
		expect(config.triage.model).toBe(
			'cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.7-code',
		);
		expect(config.triage.verificationModel).toBe(
			'cloudflare-ai-gateway/claude-haiku-4-5',
		);
	});

	it('normalizes legacy direct-provider names to gateway routes', () => {
		const config = parseFactoryConfig(`
version: 1
triage:
  model: anthropic/claude-opus-4-6
  verificationModel: cloudflare/@cf/moonshotai/kimi-k2.6
`);

		expect(config.triage.model).toBe('cloudflare-ai-gateway/claude-opus-4-6');
		expect(config.triage.verificationModel).toBe(
			'cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6',
		);
	});

	it('falls back to the built-in models for capabilities that name none', () => {
		const config = parseFactoryConfig(
			'version: 1\ntriage:\n  model: cloudflare-ai-gateway/claude-opus-4-6',
		);
		expect(config.triage.model).toBe('cloudflare-ai-gateway/claude-opus-4-6');
		expect(config.triage.verificationModel).toBe(VERIFICATION_MODEL);
	});

	it.each([
		'openai/gpt-5',
		'kimi-k2.6',
		'/claude-opus-4-6',
		'anthropic/',
		'cloudflare/',
		'cloudflare-ai-gateway/',
		'Anthropic/claude-opus-4-6',
		'Cloudflare-ai-gateway/claude-opus-4-6',
	])(
		'rejects a model that names an unbundled provider or is malformed: %s',
		(model) => {
			expect(() =>
				parseFactoryConfig(`version: 1\ntriage:\n  model: ${model}`),
			).toThrow();
		},
	);

	it.each([
		'.agents/skills/review/',
		'.agents/skills/../review',
		'/agents/skills/review',
		'.github/skills/review',
		'.agents/skills/Review',
	])('rejects an unsafe or unsupported skill directory: %s', (path) => {
		expect(() => validateSkillDirectory(path)).toThrow();
	});
});

describe('skill snapshots', () => {
	const skill = `---
name: astro-review
description: Reviews an Astro pull request.
---

# Instructions
`;

	it('requires frontmatter name to match the configured directory', () => {
		expect(
			createSkillSnapshot('.agents/skills/astro-review', { 'SKILL.md': skill }),
		).toEqual({
			name: 'astro-review',
			directory: '.agents/skills/astro-review',
			files: { 'SKILL.md': skill },
		});
		expect(() =>
			createSkillSnapshot('.agents/skills/other-review', { 'SKILL.md': skill }),
		).toThrow('must match directory');
	});

	it('enforces file-count and aggregate-byte limits', () => {
		const tooMany = Object.fromEntries(
			Array.from({ length: 33 }, (_, index) => [`${index}.md`, 'x']),
		);
		expect(() => assertSkillFileBudget(tooMany)).toThrow('at most 32 files');
		expect(() =>
			assertSkillFileBudget({ 'SKILL.md': 'x'.repeat(MAX_SKILL_BYTES) }),
		).toThrow(`at most ${MAX_SKILL_BYTES} bytes`);
	});
});
