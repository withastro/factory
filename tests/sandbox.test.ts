import { describe, expect, it } from 'vitest';
import { redactToken, shellQuote, triageSandboxId } from '../src/triage/sandbox-utils.ts';

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

	it('redacts push tokens and clone auth headers from error output', () => {
		expect(redactToken('fatal: https://x-access-token:ghs_abc123@github.com/x/y.git')).toBe(
			'fatal: https://x-access-token:***@github.com/x/y.git',
		);
		expect(redactToken('config Authorization: basic eGhzX3NlY3JldA== rejected')).toBe(
			'config Authorization: basic *** rejected',
		);
	});
});
