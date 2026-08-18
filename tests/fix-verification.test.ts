import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import type { InstallationClient } from '../src/github/client.ts';
import {
	fixVerdictSchema,
	validateFixVerdict,
	type FixVerifierInput,
} from '../src/triage/contracts.ts';
import {
	fixRetryMarker,
	fixVerifierPrompt,
	postFixRetryComment,
} from '../src/triage/fix-verification.ts';

const verifierInput: FixVerifierInput = {
	owner: 'withastro',
	repo: 'compiler-rs',
	issueNumber: 139,
	issueTitle: 'Nested global selectors are not stripped',
	issueBody: 'Both :has() and :is() cases should work.',
	branch: 'factory/fix-139',
	defaultBranch: 'main',
	conversation: [],
	latestComment: {
		author: 'reporter',
		association: 'MEMBER',
		isBot: false,
		body: 'The :has() case works now, but :is() is still broken.',
	},
	model: 'anthropic/claude-sonnet-4-6',
};

function createClient(existingBodies: string[] = []) {
	const listComments = vi.fn();
	const createComment = vi.fn(async (_input: unknown) => ({ data: { id: 1 } }));
	const client = {
		rest: {
			issues: { listComments, createComment },
		},
		paginate: vi.fn(async (method: unknown) => {
			if (method !== listComments) throw new Error('Unexpected pagination method.');
			return existingBodies.map((body) => ({ body }));
		}),
	} as unknown as InstallationClient;
	return { client, createComment };
}

describe('fix verification', () => {
	it('requires PR content only for confirmed verdicts', () => {
		const parse = (input: unknown) => validateFixVerdict(v.parse(fixVerdictSchema, input));
		expect(fixVerdictSchema.type).toBe('object');
		expect(() =>
			parse({
				status: 'confirmed',
				reasoning: 'Everything is fixed.',
				pr: { title: 'Fix nested selectors', body: 'Closes #139' },
			}),
		).not.toThrow();
		expect(() =>
			parse({
				status: 'confirmed',
				reasoning: 'Everything is fixed.',
				pr: null,
			}),
		).toThrow('must include PR content');
		expect(() =>
			parse({
				status: 'rejected',
				reasoning: 'One case remains broken.',
				pr: null,
			}),
		).not.toThrow();
		expect(() =>
			parse({
				status: 'rejected',
				reasoning: 'One case remains broken.',
				pr: { title: 'Incomplete fix', body: 'Do not open this.' },
			}),
		).toThrow('Only a confirmed verdict');
		expect(() =>
			parse({
				status: 'inconclusive',
				reasoning: 'The reporter has not tested it yet.',
				pr: null,
			}),
		).not.toThrow();
	});

	it('instructs the verifier to reject partial success', () => {
		const prompt = fixVerifierPrompt(verifierInput);
		expect(prompt).toContain('Partial or mixed success is rejected');
		expect(prompt).toContain('The :has() case works now, but :is() is still broken');
		expect(prompt).toContain(verifierInput.latestComment.body);
	});

	it('posts one marked retry acknowledgment per delivery', async () => {
		const { client, createComment } = createClient();
		await expect(
			postFixRetryComment(client, {
				owner: 'withastro',
				repo: 'compiler-rs',
				issueNumber: 139,
				deliveryId: 'delivery/139',
			}),
		).resolves.toBe('posted');
		expect(createComment).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.stringContaining('did not fully resolve'),
			}),
		);
		expect(createComment.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ body: expect.stringContaining(fixRetryMarker('delivery/139')) }),
		);
	});

	it('does not duplicate an existing retry acknowledgment', async () => {
		const marker = fixRetryMarker('delivery-139');
		const { client, createComment } = createClient([`Already retrying.\n\n${marker}`]);
		await expect(
			postFixRetryComment(client, {
				owner: 'withastro',
				repo: 'compiler-rs',
				issueNumber: 139,
				deliveryId: 'delivery-139',
			}),
		).resolves.toBe('already-posted');
		expect(createComment).not.toHaveBeenCalled();
	});
});
