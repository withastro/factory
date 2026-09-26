import { describe, expect, it, vi } from 'vitest';
import type { InstallationClient } from '../src/github/client.ts';
import {
	handOffNewPullRequest,
	handOffToHuman,
	NEEDS_HUMAN_LABEL,
	requestReviews,
} from '../src/personas/handoff.ts';

const pull = { owner: 'withastro', repo: 'astro', pullNumber: 7 };

function refusal() {
	return Object.assign(new Error('Unprocessable Entity'), { status: 422 });
}

function createClient(options: { refuse?: string[] } = {}) {
	const refuse = new Set(options.refuse ?? []);
	const requestReviewers = vi.fn(async (input: { reviewers: string[] }) => {
		if (input.reviewers.some((login) => refuse.has(login))) throw refusal();
		return { data: {} };
	});
	const addAssignees = vi.fn(async (input: { assignees: string[] }) => ({
		data: {
			assignees: input.assignees
				.filter((login) => !refuse.has(login))
				.map((login) => ({ login })),
		},
	}));
	const removeAssignees = vi.fn(async () => ({ data: {} }));
	const addLabels = vi.fn(async () => ({ data: [] }));
	const getLabel = vi.fn(async () => ({ data: {} }));
	const client = {
		rest: {
			pulls: { requestReviewers },
			issues: { addAssignees, removeAssignees, addLabels, getLabel },
		},
	} as unknown as InstallationClient;
	return { client, requestReviewers, addAssignees, removeAssignees, addLabels };
}

describe('persona handoffs', () => {
	it('assigns the author before requesting the reviewer on a new pull request', async () => {
		const { client, requestReviewers, addAssignees } = createClient();
		await expect(
			handOffNewPullRequest(client, pull, {
				authorLogin: 'astro-author',
				reviewerLogin: 'astro-reviewer',
			}),
		).resolves.toEqual({ authorAssigned: true, reviewerRequested: true });
		expect(addAssignees.mock.invocationCallOrder[0]).toBeLessThan(
			requestReviewers.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it('tolerates GitHub refusing an account without access', async () => {
		const { client } = createClient({
			refuse: ['astro-author', 'astro-reviewer'],
		});
		await expect(
			handOffNewPullRequest(client, pull, {
				authorLogin: 'astro-author',
				reviewerLogin: 'astro-reviewer',
			}),
		).resolves.toEqual({ authorAssigned: false, reviewerRequested: false });
		await expect(
			requestReviews(client, pull, ['astro-reviewer', 'maintainer']),
		).resolves.toEqual(['maintainer']);
	});

	it('labels the pull request and unassigns the author when handing to a human', async () => {
		const { client, addLabels, removeAssignees } = createClient();
		await handOffToHuman(client, pull, 'astro-author');
		expect(addLabels).toHaveBeenCalledWith(
			expect.objectContaining({ labels: [NEEDS_HUMAN_LABEL] }),
		);
		expect(removeAssignees).toHaveBeenCalledWith(
			expect.objectContaining({ assignees: ['astro-author'] }),
		);
	});
});
