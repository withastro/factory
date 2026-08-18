import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AREAS,
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
				model: CODE_MODEL,
				verificationModel: VERIFICATION_MODEL,
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
		expect(config.triage.labels.needsTriage).toBe(DEFAULT_TRIAGE_LABELS.needsTriage);
	});

	it('lets a repository disable triage', () => {
		expect(parseFactoryConfig('version: 1\ntriage:\n  enabled: false').triage.enabled).toBe(
			false,
		);
	});

	it('parses a build command', () => {
		expect(
			parseFactoryConfig(`
version: 1
triage:
  buildCommand: pnpm install --frozen-lockfile && pnpm build
`).triage.buildCommand,
		).toBe('pnpm install --frozen-lockfile && pnpm build');
	});

	it('leaves the build command absent when none is configured', () => {
		expect(parseFactoryConfig('version: 1\ntriage:\n  enabled: true').triage.buildCommand).toBe(
			undefined,
		);
	});

	it('rejects a build command that is empty or spans lines', () => {
		for (const command of ['""', "'   '", '"pnpm build\\nrm -rf /"', '"pnpm build\\u0000"']) {
			expect(() =>
				parseFactoryConfig(`version: 1\ntriage:\n  buildCommand: ${command}`),
			).toThrow();
		}
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
		expect(parseFactoryConfig('version: 1\ntriage:\n  enabled: true').triage.previewRelease).toBe(
			undefined,
		);
	});

	it.each(['../secrets.yml', 'nested/dir/preview.yml', 'preview.txt', 'preview'])(
		'rejects an unsafe or unsupported preview workflow: %s',
		(workflow) => {
			expect(() =>
				parseFactoryConfig(`version: 1\ntriage:\n  previewRelease:\n    workflow: ${workflow}\n`),
			).toThrow();
		},
	);

	it('validates the triage skill override path', () => {
		expect(
			parseFactoryConfig('version: 1\ntriage:\n  skill: .agents/skills/triage').triage.skill,
		).toBe('.agents/skills/triage');
		expect(() =>
			parseFactoryConfig('version: 1\ntriage:\n  skill: skills/triage'),
		).toThrow();
	});

	it('rejects unknown versions', () => {
		expect(() => parseFactoryConfig('version: 2')).toThrow();
	});

	it('lets a repository choose a model per capability', () => {
		const config = parseFactoryConfig(`
version: 1
review:
  trigger:
    label: ai-review
  model: anthropic/claude-opus-4-6
triage:
  model: anthropic/claude-opus-4-6
  verificationModel: anthropic/claude-haiku-4-5
`);
		expect(config.review?.model).toBe('anthropic/claude-opus-4-6');
		expect(config.triage.model).toBe('anthropic/claude-opus-4-6');
		expect(config.triage.verificationModel).toBe('anthropic/claude-haiku-4-5');
	});

	it('keeps Workers AI available alongside Anthropic', () => {
		const config = parseFactoryConfig(`
version: 1
triage:
  model: cloudflare/@cf/moonshotai/kimi-k2.7-code
  verificationModel: anthropic/claude-haiku-4-5
`);
		// Workers AI ids carry their own slashes; only the first segment is the
		// provider, so the rest must survive intact.
		expect(config.triage.model).toBe('cloudflare/@cf/moonshotai/kimi-k2.7-code');
		expect(config.triage.verificationModel).toBe('anthropic/claude-haiku-4-5');
	});

	it('falls back to the built-in models for capabilities that name none', () => {
		const config = parseFactoryConfig('version: 1\ntriage:\n  model: anthropic/claude-opus-4-6');
		expect(config.triage.model).toBe('anthropic/claude-opus-4-6');
		expect(config.triage.verificationModel).toBe(VERIFICATION_MODEL);
	});

	it.each([
		'openai/gpt-5',
		'kimi-k2.6',
		'/claude-opus-4-6',
		'anthropic/',
		'Anthropic/claude-opus-4-6',
	])('rejects a model that names an unbundled provider or is malformed: %s', (model) => {
		expect(() => parseFactoryConfig(`version: 1\ntriage:\n  model: ${model}`)).toThrow();
	});

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
