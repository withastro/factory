import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
	extractReleaseSecurityResult,
	incompleteResult,
	releaseSecurityAgentId,
	releaseSecuritySandboxId,
	releaseSecurityWorkflowParamsSchema,
} from '../src/release-security/contracts.ts';

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

describe('release security contracts', () => {
	it('validates immutable workflow input', () => {
		expect(v.parse(releaseSecurityWorkflowParamsSchema, input)).toEqual(input);
	});

	it('creates deterministic bounded identities', () => {
		expect(releaseSecurityAgentId(input)).toContain(input.headSha);
		expect(
			releaseSecuritySandboxId({
				...input,
				deliveryId: 'UPPER/value with spaces',
			}),
		).toMatch(/^rs-[a-z0-9-]{1,60}$/);
		expect(releaseSecuritySandboxId(input).length).toBeLessThanOrEqual(63);
	});

	it('downgrades a stale model result to incomplete', () => {
		const result = extractReleaseSecurityResult(
			{
				review: [
					{
						verdict: 'PASS',
						reviewedSha: 'c'.repeat(40),
						report: 'PASS - complete',
					},
				],
			},
			input.headSha,
		);
		expect(result.verdict).toBe('INCOMPLETE');
		expect(result.reviewedSha).toBe(input.headSha);
	});

	it('creates sanitized orchestration failures', () => {
		expect(incompleteResult(input.headSha, 'checkout timed out')).toEqual({
			verdict: 'INCOMPLETE',
			reviewedSha: input.headSha,
			report:
				'INCOMPLETE - Could not complete the release security review: checkout timed out.',
		});
	});
});
