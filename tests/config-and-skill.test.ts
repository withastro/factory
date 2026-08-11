import { describe, expect, it } from 'vitest';
import { parseRepositoryConfig, validateSkillDirectory } from '../src/github/config.ts';
import {
	assertSkillFileBudget,
	createSkillSnapshot,
	MAX_SKILL_BYTES,
} from '../src/github/skill.ts';

describe('repository configuration', () => {
	it('parses a valid versioned configuration', () => {
		expect(
			parseRepositoryConfig(`
version: 1
trigger:
  label: astro-review
review:
  skill: .agents/skills/astro-review
`),
		).toEqual({
			version: 1,
			trigger: { label: 'astro-review' },
			review: { skill: '.agents/skills/astro-review' },
		});
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

describe('review skill snapshots', () => {
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
