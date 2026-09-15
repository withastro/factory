import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	readdir: vi.fn<(path: string) => Promise<string[]>>(),
}));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('@flue/runtime/cloudflare', () => ({
	cloudflareSandbox: vi.fn(() => ({
		createSandbox: vi.fn(async () => ({
			cwd: '/',
			exec: vi.fn(),
			readdir: mocks.readdir,
		})),
	})),
}));

import {
	type AdversarySandbox,
	adversaryAgentSandbox,
	BLUE_DIR,
	RED_DIR,
} from '../src/adversary/sandbox.ts';

describe('adversary agent sandbox', () => {
	it.each([
		[BLUE_DIR, 'astro-adversary-blue'],
		[RED_DIR, 'astro-adversary-purple'],
	])(
		'hides the mounted skill in %s from workspace discovery',
		async (cwd, skill) => {
			const skillsDir = `${cwd}/.agents/skills`;
			mocks.readdir.mockImplementation(async (path) =>
				path === skillsDir ? [skill, 'other-skill'] : [skill],
			);
			const factory = adversaryAgentSandbox({} as AdversarySandbox, cwd, skill);
			const environment = await factory.createSandbox({ id: 'test' });

			expect(await environment.readdir(skillsDir)).toEqual(['other-skill']);
			expect(await environment.readdir(`${cwd}/src`)).toEqual([skill]);
		},
	);
});
