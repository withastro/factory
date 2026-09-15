import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	exec: vi.fn(),
	exists: vi.fn(),
	mkdir: vi.fn(),
	readFile: vi.fn(),
	readFileBuffer: vi.fn(),
	readdir: vi.fn<(path: string) => Promise<string[]>>(),
	rm: vi.fn(),
	stat: vi.fn(),
	writeFile: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('@flue/runtime/cloudflare', () => ({
	cloudflareSandbox: vi.fn((_sandbox, options: { cwd: string }) => ({
		createSandbox: vi.fn(async () => ({
			cwd: options.cwd,
			exec: mocks.exec,
			exists: mocks.exists,
			mkdir: mocks.mkdir,
			readFile: mocks.readFile,
			readFileBuffer: mocks.readFileBuffer,
			readdir: mocks.readdir,
			resolvePath: (path: string) =>
				path.startsWith('/') ? path : `${options.cwd}/${path}`,
			rm: mocks.rm,
			stat: mocks.stat,
			writeFile: mocks.writeFile,
		})),
	})),
}));

import {
	ADVERSARY_ARTIFACT_DIR,
	type AdversarySandbox,
	adversaryAgentSandbox,
	BLUE_DIR,
	BLUE_PATCH_PATH,
	captureBluePatch,
	RED_DIR,
} from '../src/adversary/sandbox.ts';

describe('adversary agent sandbox', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.exec.mockImplementation(async (command: string) => {
			const path = command.match(/-- '([^']*)'$/)?.[1];
			const findPath = command.match(/find .*?(\/[A-Za-z0-9._/-]+)/)?.[1];
			const readPath = command.match(
				/base64 -w 0 -- .*?(\/[A-Za-z0-9._/-]+)/,
			)?.[1];
			let stdout = '';
			if (command.startsWith('realpath ')) stdout = `${path}\n`;
			if (findPath) stdout = `${(await mocks.readdir(findPath)).join('\0')}\0`;
			if (readPath) {
				stdout = Buffer.from(await mocks.readFile(readPath)).toString('base64');
			}
			return {
				exitCode: 0,
				stderr: '',
				stdout,
			};
		});
		mocks.readdir.mockResolvedValue([]);
	});

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
			const factory = adversaryAgentSandbox({} as AdversarySandbox, {
				cwd,
				mountedSkillName: skill,
			});
			const environment = await factory.createSandbox({ id: 'test' });

			expect(await environment.readdir(skillsDir)).toEqual(['other-skill']);
			expect(await environment.readdir(`${cwd}/src`)).toEqual([skill]);
		},
	);

	it('denies blue filesystem access outside its checkout', async () => {
		const factory = adversaryAgentSandbox({} as AdversarySandbox, {
			cwd: BLUE_DIR,
			mountedSkillName: 'astro-adversary-blue',
		});
		const environment = await factory.createSandbox({ id: 'test' });

		await expect(environment.readFile('/etc/passwd')).rejects.toThrow(
			'Sandbox read denied outside the agent workspace.',
		);
		await expect(
			environment.writeFile('/usr/bin/file', 'broken'),
		).rejects.toThrow('Sandbox write denied outside the agent workspace.');
		expect(mocks.readFile).not.toHaveBeenCalled();
		expect(mocks.writeFile).not.toHaveBeenCalled();
	});

	it('lets purple inspect both trees without modifying the source patch', async () => {
		mocks.readFile.mockResolvedValue('patch');
		const factory = adversaryAgentSandbox({} as AdversarySandbox, {
			cwd: RED_DIR,
			mountedSkillName: 'astro-adversary-purple',
			readablePaths: [RED_DIR, BLUE_DIR, BLUE_PATCH_PATH],
			writablePaths: [RED_DIR, BLUE_DIR],
		});
		const environment = await factory.createSandbox({ id: 'test' });

		await environment.readFile(BLUE_PATCH_PATH);
		await environment.writeFile(`${BLUE_DIR}/solution.ts`, 'solution');
		await expect(
			environment.writeFile(BLUE_PATCH_PATH, 'changed'),
		).rejects.toThrow('Sandbox write denied outside the agent workspace.');
		await expect(
			environment.writeFile(`${ADVERSARY_ARTIFACT_DIR}/other.patch`, 'changed'),
		).rejects.toThrow('Sandbox write denied outside the agent workspace.');
		expect(mocks.readFile).toHaveBeenCalledWith(BLUE_PATCH_PATH);
		expect(mocks.writeFile).toHaveBeenCalledWith(
			expect.stringMatching(/^\/tmp\/factory-agent-write-/),
			'solution',
		);
		expect(mocks.exec).toHaveBeenCalledWith(
			expect.stringContaining(
				`runuser --user sandbox-agent -- env HOME=/home/sandbox-agent`,
			),
			expect.objectContaining({ timeoutMs: 30_000 }),
		);
	});

	it('rejects a symlink that resolves outside an allowed tree', async () => {
		mocks.exec.mockImplementation(async (command: string) => ({
			exitCode: 0,
			stderr: '',
			stdout: command.startsWith('realpath ') ? '/usr/bin/file\n' : '',
		}));
		const factory = adversaryAgentSandbox({} as AdversarySandbox, {
			cwd: BLUE_DIR,
			mountedSkillName: 'astro-adversary-blue',
		});
		const environment = await factory.createSandbox({ id: 'test' });

		await expect(
			environment.writeFile('system-file', 'broken'),
		).rejects.toThrow('Sandbox write denied outside the agent workspace.');
		expect(mocks.writeFile).not.toHaveBeenCalled();
	});

	it('denies an execution working directory outside the checkout', async () => {
		const factory = adversaryAgentSandbox({} as AdversarySandbox, {
			cwd: BLUE_DIR,
			mountedSkillName: 'astro-adversary-blue',
		});
		const environment = await factory.createSandbox({ id: 'test' });

		await expect(environment.exec('pwd', { cwd: '/tmp' })).rejects.toThrow(
			'Sandbox read denied outside the agent workspace.',
		);
		expect(mocks.exec).toHaveBeenCalledTimes(1);
	});

	it('runs shell commands as the unprivileged agent user', async () => {
		const factory = adversaryAgentSandbox({} as AdversarySandbox, {
			cwd: BLUE_DIR,
			mountedSkillName: 'astro-adversary-blue',
		});
		const environment = await factory.createSandbox({ id: 'test' });

		await environment.exec('whoami');
		expect(mocks.exec).toHaveBeenCalledWith(
			expect.stringContaining(
				`runuser --user sandbox-agent -- env HOME=/home/sandbox-agent`,
			),
			expect.objectContaining({ timeoutMs: 1_800_000 }),
		);
	});

	it('stages large writes instead of putting content in a command argument', async () => {
		const content = 'x'.repeat(256 * 1_024);
		const factory = adversaryAgentSandbox({} as AdversarySandbox, {
			cwd: BLUE_DIR,
			mountedSkillName: 'astro-adversary-blue',
		});
		const environment = await factory.createSandbox({ id: 'test' });

		await environment.writeFile(`${BLUE_DIR}/large.txt`, content);
		expect(mocks.writeFile).toHaveBeenCalledWith(
			expect.stringMatching(/^\/tmp\/factory-agent-write-/),
			content,
		);
		expect(
			mocks.exec.mock.calls.every(([command]) => !command.includes(content)),
		).toBe(true);
	});

	it('captures agent-controlled Git state as the unprivileged user', async () => {
		const sha = 'a'.repeat(40);
		const exec = vi
			.fn()
			.mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: '' })
			.mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: '' })
			.mockResolvedValueOnce({
				exitCode: 0,
				stderr: '',
				stdout: `12\n${'b'.repeat(64)}  ${BLUE_PATCH_PATH}\n`,
			});
		const sandbox = { exec };

		await captureBluePatch(sandbox, sha);
		expect(exec.mock.calls[0]?.[0]).toContain('runuser --user sandbox-agent');
		expect(exec.mock.calls[0]?.[0]).toContain('git -C');
		expect(exec.mock.calls[0]?.[0]).toContain('add -A');
		expect(exec.mock.calls[1]?.[0]).toContain(
			'install -o root -g root -m 0444',
		);
		expect(exec.mock.calls[1]?.[0]).not.toContain('git -C');
	});
});
