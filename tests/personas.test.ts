import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AUTHOR_MAX_ROUNDS,
	parseFactoryConfig,
} from '../src/config.ts';
import { CODE_MODEL } from '../src/models.ts';
import {
	checkPersonaAssignment,
	personaSignature,
	resolvePersona,
} from '../src/personas/personas.ts';

const CONFIG = `
version: 1
review:
  trigger:
    label: ai-review
personas:
  triage:
    login: astro-triage
  reviewer:
    login: astro-reviewer
  author:
    login: astro-author
`;

describe('persona configuration', () => {
	it('parses personas with author defaults', () => {
		expect(parseFactoryConfig(CONFIG).personas).toEqual({
			triage: { login: 'astro-triage' },
			reviewer: { login: 'astro-reviewer' },
			author: {
				login: 'astro-author',
				skill: undefined,
				model: CODE_MODEL,
				maxRounds: DEFAULT_AUTHOR_MAX_ROUNDS,
			},
		});
	});

	it('parses author overrides', () => {
		expect(
			parseFactoryConfig(`
version: 1
personas:
  author:
    login: astro-author
    skill: .agents/skills/author
    model: cloudflare-ai-gateway/claude-opus-4-6
    maxRounds: 3
`).personas?.author,
		).toMatchObject({
			skill: '.agents/skills/author',
			maxRounds: 3,
		});
	});

	it('leaves personas off when none are configured', () => {
		expect(parseFactoryConfig('version: 1\n').personas).toBeUndefined();
	});

	it('rejects personas sharing a login', () => {
		expect(() =>
			parseFactoryConfig(`
version: 1
personas:
  triage:
    login: astro-bot
  author:
    login: Astro-Bot
`),
		).toThrow(/different GitHub login/);
	});

	it('requires a review section for the reviewer persona', () => {
		expect(() =>
			parseFactoryConfig(`
version: 1
personas:
  reviewer:
    login: astro-reviewer
`),
		).toThrow(/requires a review section/);
	});

	it('rejects logins that are not GitHub user logins', () => {
		for (const login of ['factory[bot]', '-leading', 'has space']) {
			expect(() =>
				parseFactoryConfig(`
version: 1
personas:
  triage:
    login: "${login}"
`),
			).toThrow();
		}
	});
});

describe('persona resolution', () => {
	const personas = parseFactoryConfig(CONFIG).personas;

	it('resolves logins case-insensitively', () => {
		expect(resolvePersona(personas, 'Astro-Triage')).toBe('triage');
		expect(resolvePersona(personas, 'astro-reviewer')).toBe('reviewer');
		expect(resolvePersona(personas, 'astro-author')).toBe('author');
		expect(resolvePersona(personas, 'maintainer')).toBeUndefined();
		expect(resolvePersona(undefined, 'astro-triage')).toBeUndefined();
	});

	it('acts on an assignment only while the persona is still assigned', () => {
		expect(
			checkPersonaAssignment(personas, 'triage', 'astro-triage', [
				'someone',
				'astro-triage',
			]),
		).toBeUndefined();
		expect(
			checkPersonaAssignment(personas, 'triage', 'astro-triage', ['someone']),
		).toMatch(/unassigned/);
		expect(
			checkPersonaAssignment(personas, 'triage', 'astro-author', [
				'astro-author',
			]),
		).toMatch(/not the triage persona/);
	});

	it('signs without mentioning the persona account', () => {
		expect(personaSignature('astro-author')).not.toContain('@');
	});
});
