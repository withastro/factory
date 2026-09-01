import { describe, expect, it, vi } from 'vitest';
import type { ReleaseSecurityWorkflowParams } from '../src/release-security/contracts.ts';
import type { ReleaseBaselines } from '../src/release-security/release-baselines.ts';
import {
	RELEASE_READY_PATH,
	type ReleaseSandbox,
	stageReleaseSecurityContext,
} from '../src/release-security/sandbox.ts';

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

const baselines: ReleaseBaselines = {
	mergeBaseSha: input.baseSha,
	packages: [],
};

describe('release security sandbox', () => {
	it('does not mark oversized staged context as ready', async () => {
		const writeFile = vi.fn(async () => undefined);
		const sandbox = {
			writeFile,
			exec: vi.fn(async (command: string) => ({
				exitCode: 0,
				stdout: command.includes('stat --format=%s')
					? String(21 * 1_024 * 1_024)
					: '',
				stderr: '',
				success: true,
			})),
		} as unknown as ReleaseSandbox;

		await expect(
			stageReleaseSecurityContext(sandbox, input, baselines, []),
		).rejects.toThrow('Release diff exceeds the 20 MiB trusted input limit.');
		expect(writeFile).not.toHaveBeenCalledWith(
			RELEASE_READY_PATH,
			expect.anything(),
		);
	});

	it('writes the readiness marker only after successful staging', async () => {
		const writeFile = vi.fn(async () => undefined);
		const sandbox = {
			writeFile,
			exec: vi.fn(async (command: string) => ({
				exitCode: 0,
				stdout: command.includes('stat --format=%s') ? '1024' : '',
				stderr: '',
				success: true,
			})),
		} as unknown as ReleaseSandbox;

		await stageReleaseSecurityContext(sandbox, input, baselines, []);
		expect(writeFile).toHaveBeenLastCalledWith(
			RELEASE_READY_PATH,
			`${input.deliveryId}:${input.baseSha}:${input.headSha}`,
		);
	});
});
