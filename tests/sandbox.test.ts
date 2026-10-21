import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('@flue/runtime/cloudflare', () => ({
	cloudflareSandbox: vi.fn(() => ({
		createSandbox: vi.fn(async () => ({ exec: mocks.exec })),
	})),
}));

import {
	ensureTriageWorkspace,
	triageAgentSandbox,
} from '../src/triage/sandbox.ts';
import {
	AGENT_COMMAND_MAX_TIMEOUT_SECONDS,
	AGENT_COMMAND_TIMEOUT_SECONDS,
	BUILD_TIMEOUT_SECONDS,
	boundAgentCommand,
	checkoutCommandScript,
	commandStageLabel,
	configureCheckoutScript,
	INSTALL_TIMEOUT_SECONDS,
	REPO_DIR,
	redactToken,
	shellQuote,
	triageSandboxId,
} from '../src/triage/sandbox-utils.ts';

describe('triage sandbox helpers', () => {
	it('builds DNS-label-safe sandbox ids', () => {
		const id = triageSandboxId(123456, 789, 'AbC-123_xyz!');
		expect(id).toBe('t-123456-789-abc123xyz');
		expect(id.length).toBeLessThanOrEqual(63);
		expect(id).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
	});

	it('truncates long delivery ids without a trailing hyphen', () => {
		const id = triageSandboxId(123456789, 987654, 'x'.repeat(80));
		expect(id.length).toBeLessThanOrEqual(63);
		expect(id.endsWith('-')).toBe(false);
	});

	it('quotes shell metacharacters safely', () => {
		expect(shellQuote('plain')).toBe("'plain'");
		expect(shellQuote(`it's; rm -rf /`)).toBe(`'it'\\''s; rm -rf /'`);
		expect(shellQuote('a`b$(c)')).toBe("'a`b$(c)'");
	});

	it('runs configured commands from the checkout', () => {
		expect(checkoutCommandScript('pnpm build')).toBe(
			`cd ${REPO_DIR} && pnpm build`,
		);
	});

	it('leaves shell operators in a configured command for sh to interpret', () => {
		// Quoting the command would turn this into one unfindable executable
		// name, which is the failure mode a "safety" refactor would introduce.
		const script = checkoutCommandScript(
			'git clone https://example.com/x.git || true',
		);
		expect(script).toContain('|| true');
		expect(script).not.toContain(
			shellQuote('git clone https://example.com/x.git || true'),
		);
		// The composed script is still a single argument to a single `sh -c`.
		expect(shellQuote(script)).toBe(
			`'cd /repo && git clone https://example.com/x.git || true'`,
		);
	});

	it('names the stage and position of a command that fails', () => {
		expect(commandStageLabel('install', 1, 3)).toBe('install 2/3');
		// A lone command needs no position; "build 1/1" is just noise.
		expect(commandStageLabel('build', 0, 1)).toBe('build');
	});

	it('gives install and build long enough for a cold monorepo', () => {
		expect(INSTALL_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(600);
		expect(BUILD_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(
			INSTALL_TIMEOUT_SECONDS,
		);
	});

	it('keeps an existing checkout when a bootstrap step retries', async () => {
		const exec = vi
			.fn()
			.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
		const setup = vi.fn();

		expect(await ensureTriageWorkspace({ exec }, setup)).toBe(false);
		expect(exec).toHaveBeenCalledWith(
			expect.stringContaining('test -d /repo/.git'),
		);
		expect(setup).not.toHaveBeenCalled();
	});

	it('recreates a checkout lost with a replacement container', async () => {
		const exec = vi
			.fn()
			.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
		const setup = vi.fn().mockResolvedValue(undefined);

		expect(await ensureTriageWorkspace({ exec }, setup)).toBe(true);
		expect(setup).toHaveBeenCalledOnce();
	});

	it('redacts push tokens and clone auth headers from error output', () => {
		expect(
			redactToken(
				'fatal: https://x-access-token:ghs_abc123@github.com/x/y.git',
			),
		).toBe('fatal: https://x-access-token:***@github.com/x/y.git');
		expect(
			redactToken('config Authorization: basic eGhzX3NlY3JldA== rejected'),
		).toBe('config Authorization: basic *** rejected');
		expect(
			redactToken(
				'fatal: header Authorization: bearer ghs_abc123 rejected',
			),
		).toBe('fatal: header Authorization: bearer *** rejected');
		expect(redactToken('Authorization: token ghp_abc123')).toBe(
			'Authorization: token ***',
		);
	});
});

describe('triage checkout git config', () => {
	it('disables automatic gc and maintenance in the checkout', () => {
		const script = configureCheckoutScript({
			fixBranch: 'factory/fix-1',
			removeOrigin: false,
		});
		expect(script).toContain("git config gc.auto '0'");
		expect(script).toContain("git config maintenance.auto 'false'");
		expect(script).toContain("git checkout -B 'factory/fix-1'");
		expect(script).not.toContain('git remote remove origin');
	});

	it('removes origin from private checkouts', () => {
		expect(
			configureCheckoutScript({ fixBranch: 'b', removeOrigin: true }),
		).toMatch(/&& git remote remove origin$/);
	});
});

describe('triage agent command bounds', () => {
	it('defaults an unbounded command to the agent timeout', () => {
		expect(boundAgentCommand('git blame x', undefined)).toEqual({
			command: `timeout -k 5 ${AGENT_COMMAND_TIMEOUT_SECONDS} bash -c 'git blame x'`,
			seconds: AGENT_COMMAND_TIMEOUT_SECONDS,
			timeoutMs: (AGENT_COMMAND_TIMEOUT_SECONDS + 15) * 1_000,
		});
	});

	it('honors a requested timeout up to the ceiling', () => {
		expect(boundAgentCommand('pnpm test', 1_200_000).seconds).toBe(1_200);
		expect(boundAgentCommand('pnpm test', 10 * 3_600_000).seconds).toBe(
			AGENT_COMMAND_MAX_TIMEOUT_SECONDS,
		);
		expect(boundAgentCommand('true', 100).seconds).toBe(1);
	});
});

describe('triage agent sandbox', () => {
	beforeEach(() => {
		mocks.exec.mockReset();
	});

	it('runs agent commands under a timeout', async () => {
		mocks.exec.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });
		const environment = await triageAgentSandbox(
			{} as Parameters<typeof triageAgentSandbox>[0],
		).createSandbox({ id: 'test' });

		const result = await environment.exec('git log', { cwd: REPO_DIR });

		expect(result).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
		expect(mocks.exec).toHaveBeenCalledWith(
			`timeout -k 5 ${AGENT_COMMAND_TIMEOUT_SECONDS} bash -c 'git log'`,
			{
				cwd: REPO_DIR,
				timeoutMs: (AGENT_COMMAND_TIMEOUT_SECONDS + 15) * 1_000,
			},
		);
	});

	it('tells the agent when a command was killed for timing out', async () => {
		mocks.exec.mockResolvedValue({
			exitCode: 124,
			stdout: '',
			stderr: 'partial',
		});
		const environment = await triageAgentSandbox(
			{} as Parameters<typeof triageAgentSandbox>[0],
		).createSandbox({ id: 'test' });

		const result = await environment.exec('git blame x', { timeoutMs: 30_000 });

		expect(result.exitCode).toBe(124);
		expect(result.stderr).toMatch(
			/^partial\n\[factory\] Command timed out after 30 seconds/,
		);
	});
});
