import { describe, expect, it, vi } from 'vitest';
import {
	cleanLogText,
	loadCheckLogTail,
	MAX_CHECK_LOG_BYTES,
	tailLines,
} from '../src/author/github.ts';
import type { InstallationClient } from '../src/github/client.ts';

const ESC = '\u001b';

describe('check log cleaning', () => {
	it('strips colour codes, timestamps, and control characters from Actions logs', () => {
		const raw = [
			`\ufeff2026-09-26T18:28:10.1603942Z ${ESC}[36mastro:test: ${ESC}[0m${ESC}[31m✖ Can filter preloads ${ESC}[90m(47.29ms)${ESC}[39m${ESC}[39m`,
			`2026-09-26T18:28:10.1607710Z ${ESC}[36mastro:test: ${ESC}[0m  false !== true\r`,
			`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\ bell\u0007 nul\u0000 tab\tend`,
		].join('\n');
		expect(cleanLogText(raw)).toBe(
			[
				'astro:test: ✖ Can filter preloads (47.29ms)',
				'astro:test:   false !== true',
				'link bell nul tab\tend',
			].join('\n'),
		);
	});

	it('keeps the tail from a line boundary', () => {
		expect(tailLines('short', 10)).toBe('short');
		expect(tailLines('first line\nsecond\nthird', 14)).toBe('second\nthird');
	});

	it('returns a clean, bounded tail from the Actions API', async () => {
		const line = `2026-09-26T18:28:10.1Z ${ESC}[31merror${ESC}[39m in test\n`;
		const log = line.repeat(5_000);
		const client = {
			rest: {
				actions: {
					downloadJobLogsForWorkflowRun: vi.fn(async () => ({
						data: new TextEncoder().encode(log).buffer,
					})),
				},
			},
		} as unknown as InstallationClient;
		const tail = await loadCheckLogTail(client, {
			owner: 'withastro',
			repo: 'astro',
			jobId: 1,
		});
		expect(tail).not.toBeNull();
		expect(tail?.length).toBeLessThanOrEqual(MAX_CHECK_LOG_BYTES);
		expect(tail).not.toContain(ESC);
		expect(tail?.startsWith('error in test\n')).toBe(true);
	});
});
