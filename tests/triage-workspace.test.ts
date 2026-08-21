/**
 * Regression tests for the workspace layout that let a reproduction step
 * destroy the checkout it was supposed to produce a fix in.
 *
 * The reproduce skill used to say `rm -rf <triageDir>/.git`, with `triageDir`
 * a relative path inside `/repo`. An agent that resolved that placeholder to
 * the checkout deleted `/repo/.git`, and the run died at push time with
 * "not a git repository" after the fix had already been written.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPO_DIR, TRIAGE_DIR } from '../src/triage/sandbox-utils.ts';

// Read the markdown from disk: the `.md` imports in default-skill.ts are
// resolved by the Worker build's vite plugin and aren't available here.
const SKILL_DIR = 'skills/triage';
const files = Object.fromEntries(
	readdirSync(SKILL_DIR)
		.filter((name) => name.endsWith('.md'))
		.map((name) => [name, readFileSync(`${SKILL_DIR}/${name}`, 'utf8')]),
);

describe('triage scratch directory', () => {
	it('is a sibling of the checkout, never nested inside it', () => {
		expect(TRIAGE_DIR.startsWith('/')).toBe(true);
		expect(TRIAGE_DIR.startsWith(`${REPO_DIR}/`)).toBe(false);
		expect(TRIAGE_DIR).not.toBe(REPO_DIR);
	});
});

describe('bundled triage skill', () => {
	it('never instructs deleting a .git directory', () => {
		for (const [name, content] of Object.entries(files)) {
			const offenders = content
				.split('\n')
				.filter((line) => /rm\s+-rf?[^\n]*\.git\b/.test(line));
			expect(
				offenders,
				`${name} tells the agent to delete a .git directory`,
			).toEqual([]);
		}
	});

	it('does not point the triage directory inside the checkout', () => {
		for (const [name, content] of Object.entries(files)) {
			// A bare `triage/gh-N` is a relative path, which resolves inside the
			// checkout when the agent's shell is cwd'd there.
			const offenders = content
				.split('\n')
				.filter((line) => /(?<![/\w])triage\/(gh-|current|issue-)/.test(line));
			expect(
				offenders,
				`${name} uses a checkout-relative triage directory`,
			).toEqual([]);
		}
	});
});
