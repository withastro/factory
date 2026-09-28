import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('@flue/runtime/cloudflare', () => ({ cloudflareSandbox: vi.fn() }));

import { commitAndPushFastForward } from '../src/triage/sandbox.ts';

type Reply = { exitCode: number; stdout?: string; stderr?: string };

function fakeSandbox(reply: (command: string) => Reply) {
	const commands: string[] = [];
	const sandbox = {
		commands,
		writeFile: vi.fn(async () => undefined),
		exec: vi.fn(async (command: string) => {
			commands.push(command);
			return reply(command);
		}),
	};
	return sandbox;
}

const options = {
	owner: 'withastro',
	repo: 'astro',
	branch: 'factory/fix-12',
	message: 'fix: address review',
	token: 'ghs_secret',
	dirty: true,
};

describe('fast-forward push for owned branches', () => {
	it('commits and pushes without force', async () => {
		const sandbox = fakeSandbox((command) =>
			command.includes('rev-parse')
				? { exitCode: 0, stdout: `${'c'.repeat(40)}\n` }
				: { exitCode: 0 },
		);
		const result = await commitAndPushFastForward(sandbox as never, options);
		expect(result).toEqual({
			pushed: true,
			sha: 'c'.repeat(40),
			detail: 'pushed',
		});
		const push = sandbox.commands.find((command) =>
			command.includes('git push'),
		);
		expect(push).toBeDefined();
		expect(push).not.toMatch(/push -f|--force/);
	});

	it('rebases onto commits pushed meanwhile, then pushes again', async () => {
		let pushes = 0;
		const sandbox = fakeSandbox((command) => {
			if (command.includes('git push')) {
				pushes += 1;
				return pushes === 1
					? { exitCode: 1, stderr: ' ! [rejected] (fetch first)' }
					: { exitCode: 0 };
			}
			if (command.includes('rev-parse'))
				return { exitCode: 0, stdout: 'd'.repeat(40) };
			return { exitCode: 0 };
		});
		const result = await commitAndPushFastForward(sandbox as never, options);
		expect(result.pushed).toBe(true);
		expect(pushes).toBe(2);
		const rebase = sandbox.commands.find((command) =>
			command.includes('git rebase FETCH_HEAD'),
		);
		expect(rebase).toBeDefined();
		expect(rebase).not.toContain('git pull');
	});

	it('aborts a conflicting rebase and reports without leaking the token', async () => {
		const sandbox = fakeSandbox((command) => {
			if (command.includes('git push'))
				return { exitCode: 1, stderr: ' ! [rejected] non-fast-forward' };
			if (command.includes('git rebase FETCH_HEAD'))
				return {
					exitCode: 1,
					stderr:
						'CONFLICT in src/a.ts; from https://x-access-token:ghs_secret@github.com/withastro/astro.git',
				};
			return { exitCode: 0 };
		});
		const result = await commitAndPushFastForward(sandbox as never, options);
		expect(result.pushed).toBe(false);
		expect(result.detail).toMatch(/conflict/);
		expect(result.detail).not.toContain('ghs_secret');
		expect(
			sandbox.commands.some((command) =>
				command.includes('git rebase --abort'),
			),
		).toBe(true);
	});
});
