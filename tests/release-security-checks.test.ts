import { describe, expect, it, vi } from 'vitest';
import type { InstallationClient } from '../src/github/client.ts';
import {
	completeReleaseSecurityChecks,
	startReleaseSecurityCheck,
} from '../src/release-security/checks.ts';

const input = {
	owner: 'withastro',
	repo: 'astro',
	pullNumber: 123,
	pullUrl: 'https://github.com/withastro/astro/pull/123',
	headSha: 'a'.repeat(40),
	deliveryId: 'delivery-id',
	mode: 'release' as const,
	trigger: 'pull-request' as const,
};

function createClient(
	checks: Array<{ id: number; external_id: string; status: string }> = [],
) {
	const listForRef = vi.fn(async () => ({ data: { check_runs: checks } }));
	const create = vi.fn(async () => ({ data: { id: 42 } }));
	const update = vi.fn(async () => ({ data: { id: 42 } }));
	return {
		client: {
			rest: { checks: { listForRef, create, update } },
		} as unknown as InstallationClient,
		create,
		update,
	};
}

describe('release security checks', () => {
	it('creates a delivery-correlated check', async () => {
		const { client, create } = createClient();
		await expect(startReleaseSecurityCheck(client, input)).resolves.toBe(42);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'Astro release security review',
				head_sha: input.headSha,
				external_id: input.deliveryId,
			}),
		);
	});

	it.each([
		['PASS', 'success'],
		['BLOCK', 'failure'],
		['INCOMPLETE', 'failure'],
	] as const)('completes %s fail-closed as %s', async (verdict, conclusion) => {
		const { client, update } = createClient();
		await completeReleaseSecurityChecks(
			client,
			input,
			{ verdict, reviewedSha: input.headSha },
			[42],
		);
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ conclusion, check_run_id: 42 }),
		);
	});
});
