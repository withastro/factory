import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationClient } from '../src/github/client.ts';
import {
	type FixVerifierInput,
	fixVerdictSchema,
	validateFixVerdict,
} from '../src/triage/contracts.ts';
import {
	acknowledgeRejectedFix,
	fixFollowUpMarker,
	fixRejectionAction,
	fixVerifierPrompt,
	MAX_FIX_RETRIES,
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
			if (method !== listComments)
				throw new Error('Unexpected pagination method.');
			return existingBodies.map((body) => ({ body }));
		}),
	} as unknown as InstallationClient;
	return { client, createComment };
}

function reject(
	client: InstallationClient,
	feedback: 'specific' | 'vague',
	deliveryId = 'delivery-139',
) {
	return acknowledgeRejectedFix(client, {
		owner: 'withastro',
		repo: 'compiler-rs',
		issueNumber: 139,
		deliveryId,
		feedback,
	});
}

describe('fix verification', () => {
	const parse = (input: unknown) =>
		validateFixVerdict(v.parse(fixVerdictSchema, input));

	it('requires PR content only for confirmed verdicts', () => {
		expect(fixVerdictSchema.type).toBe('object');
		expect(() =>
			parse({
				status: 'confirmed',
				reasoning: 'Everything is fixed.',
				feedback: null,
				pr: { title: 'Fix nested selectors', body: 'Closes #139' },
			}),
		).not.toThrow();
		expect(() =>
			parse({
				status: 'confirmed',
				reasoning: 'Everything is fixed.',
				feedback: null,
				pr: null,
			}),
		).toThrow('must include PR content');
		expect(() =>
			parse({
				status: 'rejected',
				reasoning: 'One case remains broken.',
				feedback: 'specific',
				pr: null,
			}),
		).not.toThrow();
		expect(() =>
			parse({
				status: 'rejected',
				reasoning: 'One case remains broken.',
				feedback: 'specific',
				pr: { title: 'Incomplete fix', body: 'Do not open this.' },
			}),
		).toThrow('Only a confirmed verdict');
		expect(() =>
			parse({
				status: 'inconclusive',
				reasoning: 'The reporter has not tested it yet.',
				feedback: null,
				pr: null,
			}),
		).not.toThrow();
	});

	it('requires a feedback classification only for rejected verdicts', () => {
		expect(() =>
			parse({
				status: 'rejected',
				reasoning: 'Still broken, no detail given.',
				feedback: null,
				pr: null,
			}),
		).toThrow('must classify the feedback');
		expect(() =>
			parse({
				status: 'inconclusive',
				reasoning: 'Just a question.',
				feedback: 'vague',
				pr: null,
			}),
		).toThrow('Only a rejected verdict');
	});

	it('instructs the verifier to reject partial success and rate the feedback', () => {
		const prompt = fixVerifierPrompt(verifierInput);
		expect(prompt).toContain('Partial or mixed success is rejected');
		expect(prompt).toContain('**specific**');
		expect(prompt).toContain('**vague**');
		expect(prompt).toContain(verifierInput.latestComment.body);
	});

	it('retries specific feedback until the retry budget is spent', () => {
		expect(fixRejectionAction('specific', 0)).toBe('retry');
		expect(fixRejectionAction('specific', MAX_FIX_RETRIES - 1)).toBe('retry');
		expect(fixRejectionAction('specific', MAX_FIX_RETRIES)).toBe('retry-limit');
		expect(fixRejectionAction('vague', 0)).toBe('needs-details');
		expect(fixRejectionAction('vague', MAX_FIX_RETRIES)).toBe('needs-details');
	});

	it('announces a retry for specific feedback', async () => {
		const { client, createComment } = createClient();
		await expect(reject(client, 'specific')).resolves.toBe('retry');
		expect(createComment.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				body: expect.stringContaining(
					fixFollowUpMarker('delivery-139', 'retry'),
				),
			}),
		);
		expect(createComment.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				body: expect.stringContaining('did not fully resolve'),
			}),
		);
	});

	it('asks what is still broken instead of retrying on vague feedback', async () => {
		const { client, createComment } = createClient();
		await expect(reject(client, 'vague')).resolves.toBe('needs-details');
		expect(createComment.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				body: expect.stringContaining(
					'Which part of the original problem still happens?',
				),
			}),
		);
		expect(createComment.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				body: expect.stringContaining(
					fixFollowUpMarker('delivery-139', 'needs-details'),
				),
			}),
		);
	});

	it('hands off to a maintainer once the retries are spent', async () => {
		const spent = Array.from(
			{ length: MAX_FIX_RETRIES },
			(_, index) =>
				`Retrying.\n\n${fixFollowUpMarker(`delivery-${index}`, 'retry')}`,
		);
		const { client, createComment } = createClient([
			...spent,
			`Tell me more.\n\n${fixFollowUpMarker('delivery-vague', 'needs-details')}`,
		]);
		await expect(reject(client, 'specific')).resolves.toBe('retry-limit');
		expect(createComment.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				body: expect.stringContaining(
					`retried this fix ${MAX_FIX_RETRIES} times`,
				),
			}),
		);
	});

	it('counts only retries against the budget', async () => {
		const { client } = createClient([
			`Tell me more.\n\n${fixFollowUpMarker('delivery-a', 'needs-details')}`,
			`Tell me more.\n\n${fixFollowUpMarker('delivery-b', 'needs-details')}`,
			`Retrying.\n\n${fixFollowUpMarker('delivery-c', 'retry')}`,
		]);
		await expect(reject(client, 'specific')).resolves.toBe('retry');
	});

	it('repeats the action it already announced for a delivery', async () => {
		const { client, createComment } = createClient([
			`Tell me more.\n\n${fixFollowUpMarker('delivery-139', 'needs-details')}`,
		]);
		// Same delivery, and the verdict is irrelevant: the issue already has
		// the answer this run posted.
		await expect(reject(client, 'specific')).resolves.toBe('needs-details');
		expect(createComment).not.toHaveBeenCalled();
	});
});
