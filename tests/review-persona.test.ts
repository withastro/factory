import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationClient } from '../src/github/client.ts';
import {
	type ReviewWorkflowParams,
	reviewWorkflowParamsSchema,
} from '../src/review/contracts.ts';
import { loadReviewSetup, matchesReviewTrigger } from '../src/review/setup.ts';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const CONFIG = `version: 1
review:
  trigger:
    label: astro-review
personas:
  reviewer:
    login: astro-reviewer
`;

function trigger(
	signal: 'review-requested' | 'assigned' = 'review-requested',
	login = 'astro-reviewer',
): ReviewWorkflowParams {
	return v.parse(reviewWorkflowParamsSchema, {
		deliveryId: 'delivery-id',
		installationId: 123,
		repositoryId: 456,
		owner: 'withastro',
		repo: 'astro',
		pullNumber: 789,
		persona: { login, signal },
		baseSha: BASE_SHA,
		headSha: HEAD_SHA,
	});
}

function createClient(pull: {
	requested_reviewers?: Array<{ login: string }>;
	assignees?: Array<{ login: string }>;
}) {
	const getLabel = vi.fn();
	const client = {
		rest: {
			pulls: {
				get: vi.fn(async () => ({
					data: {
						state: 'open',
						head: { sha: HEAD_SHA },
						title: 'Review this change',
						body: null,
						labels: [],
						requested_reviewers: [],
						assignees: [],
						...pull,
					},
				})),
			},
			repos: {
				getContent: vi.fn(async ({ path }: { path: string }) => {
					if (path === '.github/factory.yml') {
						return {
							data: {
								type: 'file',
								content: Buffer.from(CONFIG).toString('base64'),
								encoding: 'base64',
							},
						};
					}
					throw Object.assign(new Error('Not found'), { status: 404 });
				}),
			},
			issues: { getLabel },
		},
	} as unknown as InstallationClient;
	return { client, getLabel };
}

describe('reviewer persona trigger', () => {
	it('requires exactly one of a label or a persona', () => {
		const base = {
			deliveryId: 'd',
			installationId: 1,
			repositoryId: 1,
			owner: 'o',
			repo: 'r',
			pullNumber: 1,
			baseSha: BASE_SHA,
			headSha: HEAD_SHA,
		};
		expect(v.safeParse(reviewWorkflowParamsSchema, base).success).toBe(false);
		expect(
			v.safeParse(reviewWorkflowParamsSchema, {
				...base,
				label: 'astro-review',
				persona: { login: 'astro-reviewer', signal: 'assigned' },
			}).success,
		).toBe(false);
	});

	it('matches only the configured reviewer persona', async () => {
		const { client } = createClient({});
		await expect(matchesReviewTrigger(client, trigger())).resolves.toBe(true);
		await expect(
			matchesReviewTrigger(client, trigger('review-requested', 'someone')),
		).resolves.toBe(false);
	});

	it('runs while the persona is still requested, without a label', async () => {
		const { client, getLabel } = createClient({
			requested_reviewers: [{ login: 'Astro-Reviewer' }],
		});
		const setup = await loadReviewSetup(client, trigger());
		expect(setup.outcome).toBe('ready');
		if (setup.outcome === 'ready') {
			expect(setup.agentInput.triggerLabel).toBeUndefined();
		}
		expect(getLabel).not.toHaveBeenCalled();
	});

	it('is stale once the review request is withdrawn', async () => {
		const { client } = createClient({ requested_reviewers: [] });
		await expect(loadReviewSetup(client, trigger())).resolves.toEqual({
			outcome: 'stale',
			reason: 'The review request was withdrawn before review started.',
		});
	});

	it('accepts assignment as the trigger too', async () => {
		const { client } = createClient({
			assignees: [{ login: 'astro-reviewer' }],
		});
		await expect(
			loadReviewSetup(client, trigger('assigned')),
		).resolves.toMatchObject({ outcome: 'ready' });
	});
});
