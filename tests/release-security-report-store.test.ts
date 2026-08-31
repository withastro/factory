import { describe, expect, it, vi } from 'vitest';
import { storePrivateReleaseSecurityReport } from '../src/release-security/report-store.ts';

describe('private release security reports', () => {
	it('stores a content-addressed private report', async () => {
		const put = vi.fn(async () => null);
		const input = {
			deliveryId: 'delivery-1',
			installationId: 1,
			repositoryId: 2,
			owner: 'withastro',
			repo: 'astro',
			pullNumber: 3,
			pullUrl: 'https://github.com/withastro/astro/pull/3',
			pullTitle: 'Release',
			pullBody: '',
			headRef: 'changeset-release/main',
			headSha: 'b'.repeat(40),
			baseRef: 'main',
			baseSha: 'a'.repeat(40),
			mode: 'release' as const,
			trigger: 'pull-request' as const,
		};
		const result = {
			verdict: 'PASS' as const,
			reviewedSha: input.headSha,
			report: 'PASS - complete',
		};
		const key = await storePrivateReleaseSecurityReport(
			{ put } as unknown as R2Bucket,
			input,
			result,
		);
		expect(key).toMatch(
			/^withastro\/astro\/3\/[a-f0-9]{40}\/delivery-1-pass-[a-f0-9]{64}\.md$/,
		);
		expect(put).toHaveBeenCalledWith(
			key,
			result.report,
			expect.objectContaining({
				customMetadata: expect.objectContaining({ verdict: 'PASS' }),
			}),
		);
	});
});
