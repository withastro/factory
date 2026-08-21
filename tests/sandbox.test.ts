import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

import { ensureTriageWorkspace } from '../src/triage/sandbox.ts';
import {
	BUILD_TIMEOUT_SECONDS,
	checkoutCommandScript,
	commandStageLabel,
	existingFixFetchScript,
	fixBranchCheckoutCommand,
	INSTALL_TIMEOUT_SECONDS,
	redactToken,
	REPO_DIR,
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
		expect(checkoutCommandScript('pnpm build')).toBe(`cd ${REPO_DIR} && pnpm build`);
	});

	it('leaves shell operators in a configured command for sh to interpret', () => {
		// Quoting the command would turn this into one unfindable executable
		// name, which is the failure mode a "safety" refactor would introduce.
		const script = checkoutCommandScript('git clone https://example.com/x.git || true');
		expect(script).toContain('|| true');
		expect(script).not.toContain(shellQuote('git clone https://example.com/x.git || true'));
		// The composed script is still a single argument to a single `sh -c`.
		expect(shellQuote(script)).toBe(`'cd /repo && git clone https://example.com/x.git || true'`);
	});

	it('pins a retried fix branch to the verified commit', () => {
		const sha = 'a'.repeat(40);
		const fetch = existingFixFetchScript('factory/fix-139', sha);
		expect(fetch).toContain("fetch --no-tags origin 'refs/heads/factory/fix-139'");
		expect(fetch).toContain(`[ "$fetched" = '${sha}' ]`);
		// A branch that moved has to say so: the pin fails every retry, and
		// `test` alone would fail with nothing on stderr.
		expect(fetch).toContain('moved to $fetched');
		expect(fixBranchCheckoutCommand('factory/fix-139', sha)).toBe(
			`git checkout -B 'factory/fix-139' '${sha}'`,
		);
		expect(fixBranchCheckoutCommand('factory/fix-140')).toBe(
			`git checkout -B 'factory/fix-140'`,
		);
	});

	it('rejects an unsafe fix commit before building git commands', () => {
		expect(() => existingFixFetchScript('factory/fix-139', 'main; rm -rf /')).toThrow(
			'Unsafe git commit',
		);
	});

	it('names the stage and position of a command that fails', () => {
		expect(commandStageLabel('install', 1, 3)).toBe('install 2/3');
		// A lone command needs no position; "build 1/1" is just noise.
		expect(commandStageLabel('build', 0, 1)).toBe('build');
	});

	it('gives install and build long enough for a cold monorepo', () => {
		expect(INSTALL_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(600);
		expect(BUILD_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(INSTALL_TIMEOUT_SECONDS);
	});

	it('keeps an existing checkout when a bootstrap step retries', async () => {
		const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
		const setup = vi.fn();

		expect(await ensureTriageWorkspace({ exec }, setup)).toBe(false);
		expect(exec).toHaveBeenCalledWith(expect.stringContaining('test -d /repo/.git'));
		expect(setup).not.toHaveBeenCalled();
	});

	it('recreates a checkout lost with a replacement container', async () => {
		const exec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
		const setup = vi.fn().mockResolvedValue(undefined);

		expect(await ensureTriageWorkspace({ exec }, setup)).toBe(true);
		expect(setup).toHaveBeenCalledOnce();
	});

	it('redacts push tokens and clone auth headers from error output', () => {
		expect(redactToken('fatal: https://x-access-token:ghs_abc123@github.com/x/y.git')).toBe(
			'fatal: https://x-access-token:***@github.com/x/y.git',
		);
		expect(redactToken('config Authorization: basic eGhzX3NlY3JldA== rejected')).toBe(
			'config Authorization: basic *** rejected',
		);
	});
});
