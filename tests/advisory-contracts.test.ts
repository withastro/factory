import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
	advisoryAgentId,
	advisoryCoordinatorKey,
	advisorySandboxId,
	advisoryTriageResultSchema,
	advisoryWorkBranch,
	advisoryWorkflowParamsSchema,
} from '../src/advisory/contracts.ts';

const params = v.parse(advisoryWorkflowParamsSchema, {
	deliveryId: '1a2b3c4d-0000-1111-2222-333344445555',
	installationId: 1,
	repositoryId: 44914786,
	owner: 'withastro',
	repo: 'astro',
	defaultBranch: 'main',
	ghsaId: 'GHSA-ff38-p3qj-4pmf',
});

const validResult = {
	verdict: 'not-vulnerability',
	confidence: 'high',
	isBug: true,
	title: 'Custom transition direction is not escaped in a selector',
	summary: 'Not a vulnerability: the value comes from the site author.',
	reproduction: { attempted: true, reproduced: false, details: 'Ran it.' },
	duplicateOf: null,
	severity: null,
	affectedPackages: [],
	assessment: '## Claim\n\nText.',
	reporterReply: 'Thanks for the report.',
	fixBrief: '## Problem\n\nThe selector is unquoted.',
};

describe('advisory contracts', () => {
	it('defaults repoIsPrivate and validates the GHSA id', () => {
		expect(params.repoIsPrivate).toBe(false);
		expect(() =>
			v.parse(advisoryWorkflowParamsSchema, { ...params, ghsaId: 'ghsa-1' }),
		).toThrow();
	});

	it('derives stable keys and ids', () => {
		expect(advisoryCoordinatorKey(params)).toBe('44914786:GHSA-ff38-p3qj-4pmf');
		expect(advisoryAgentId(params)).toBe(
			'advisory:44914786:GHSA-ff38-p3qj-4pmf:1a2b3c4d-0000-1111-2222-333344445555',
		);
		expect(advisoryWorkBranch(params.ghsaId)).toBe(
			'factory/advisory-ghsa-ff38-p3qj-4pmf',
		);
	});

	it('produces sandbox ids that are valid DNS labels', () => {
		const id = advisorySandboxId(params);
		expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		expect(id.length).toBeLessThanOrEqual(63);
		expect(id.startsWith('a-44914786-ff38-p3qj-4pmf-')).toBe(true);
	});

	it('accepts a complete triage result', () => {
		expect(v.parse(advisoryTriageResultSchema, validResult)).toEqual(
			validResult,
		);
	});

	it('rejects malformed severity and duplicate references', () => {
		expect(() =>
			v.parse(advisoryTriageResultSchema, {
				...validResult,
				verdict: 'vulnerability',
				severity: { level: 'medium', cvssVector: 'AV:N', cwe: 'CWE-79' },
			}),
		).toThrow();
		expect(() =>
			v.parse(advisoryTriageResultSchema, {
				...validResult,
				verdict: 'duplicate',
				duplicateOf: ['not-a-ghsa'],
			}),
		).toThrow();
		expect(
			v.parse(advisoryTriageResultSchema, {
				...validResult,
				verdict: 'vulnerability',
				severity: {
					level: 'medium',
					cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N',
					cwe: 'CWE-79',
				},
			}).severity?.level,
		).toBe('medium');
	});
});
