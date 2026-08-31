import { describe, expect, it, vi } from 'vitest';
import type { ReleaseSecurityWorkflowParams } from '../src/release-security/contracts.ts';
import { prepareReleaseBaselines } from '../src/release-security/release-baselines.ts';
import type { ReleaseSandbox } from '../src/release-security/sandbox.ts';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

const input: ReleaseSecurityWorkflowParams = {
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
	mode: 'release',
	trigger: 'pull-request',
};

describe('release package baselines', () => {
	it('rejects a release head that does not contain the reviewed base SHA', async () => {
		const sandbox = {
			exec: vi.fn(async () => ({
				exitCode: 0,
				stdout: `${'c'.repeat(40)}\n`,
				stderr: '',
				success: true,
			})),
		} as unknown as ReleaseSandbox;

		await expect(prepareReleaseBaselines(sandbox, input)).rejects.toThrow(
			'Release head does not contain the reviewed base commit.',
		);
	});
});
