import { describe, expect, it } from 'vitest';
import { isBotAuthor, KNOWN_USER_TYPE_BOT_LOGINS } from '../src/github/bots.ts';

describe('isBotAuthor', () => {
	it('flags GitHub App account logins by their [bot] suffix', () => {
		expect(isBotAuthor('factory[bot]')).toBe(true);
		expect(isBotAuthor('astro-build[bot]')).toBe(true);
		expect(isBotAuthor('github-actions[bot]')).toBe(true);
	});

	it('flags known user-account bots that GitHub types as User', () => {
		expect(isBotAuthor('astrobot-houston')).toBe(true);
		expect(KNOWN_USER_TYPE_BOT_LOGINS.has('astrobot-houston')).toBe(true);
	});

	it('does not flag human logins', () => {
		expect(isBotAuthor('matthewp')).toBe(false);
		expect(isBotAuthor('ilovesusu')).toBe(false);
		expect(isBotAuthor('someone[bot]ish')).toBe(false);
	});

	it('is safe for missing logins', () => {
		expect(isBotAuthor(undefined)).toBe(false);
		expect(isBotAuthor('')).toBe(false);
	});
});
