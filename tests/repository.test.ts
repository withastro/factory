import { describe, expect, it, vi } from 'vitest';
import type { ReviewWorkflowParams } from '../src/contracts/review.ts';
import type { InstallationClient } from '../src/github/client.ts';
import { loadReviewSetup } from '../src/github/repository.ts';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const SKILL_DIRECTORY = '.agents/skills/astro-review';
const CONFIG = `version: 1
trigger:
  label: astro-review
review:
  skill: ${SKILL_DIRECTORY}
  severity: [blocker, advisory]
  areas: [correctness, tests]
`;
const SKILL = `---
name: astro-review
description: Reviews an Astro pull request.
---

# Review
`;

function encode(value: string): string {
	return Buffer.from(value).toString('base64');
}

function trigger(): ReviewWorkflowParams {
	return {
		deliveryId: 'delivery-id',
		installationId: 123,
		repositoryId: 456,
		owner: 'withastro',
		repo: 'astro',
		pullNumber: 789,
		label: 'astro-review',
		baseSha: BASE_SHA,
		headSha: HEAD_SHA,
	};
}

function createClient(labels: Array<{ name: string }> = [{ name: 'astro-review' }]) {
	const getContent = vi.fn(async ({ path }: { path: string }) => {
		if (path === '.github/astro-review.yml') {
			return { data: { type: 'file', content: encode(CONFIG), encoding: 'base64' } };
		}
		if (path === SKILL_DIRECTORY) {
			return {
				data: [
					{
						type: 'file',
						path: `${SKILL_DIRECTORY}/SKILL.md`,
						size: Buffer.byteLength(SKILL),
						sha: 'skill-blob',
					},
				],
			};
		}
		throw new Error(`Unexpected path: ${path}`);
	});
	const client = {
		rest: {
			pulls: {
				get: vi.fn(async () => ({
					data: {
						state: 'open',
						head: { sha: HEAD_SHA },
						title: 'Review this change',
						body: null,
						labels,
					},
				})),
			},
			repos: { getContent },
			git: {
				getBlob: vi.fn(async () => ({
					data: { content: encode(SKILL), encoding: 'base64' },
				})),
			},
		},
	} as unknown as InstallationClient;
	return { client, getContent };
}

describe('review setup', () => {
	it('loads configuration and skill only from the event base SHA', async () => {
		const { client, getContent } = createClient();
		const result = await loadReviewSetup(client, trigger());

		expect(result).toMatchObject({
			outcome: 'ready',
			agentInput: {
				baseSha: BASE_SHA,
				headSha: HEAD_SHA,
				body: '',
				severities: ['blocker', 'advisory'],
				areas: ['correctness', 'tests'],
				skill: { name: 'astro-review' },
			},
		});
		expect(getContent).toHaveBeenCalledTimes(2);
		for (const [request] of getContent.mock.calls) {
			expect(request).toMatchObject({ ref: BASE_SHA });
		}
	});

	it('stops before loading the skill when the trigger label was removed', async () => {
		const { client, getContent } = createClient([]);
		await expect(loadReviewSetup(client, trigger())).resolves.toEqual({
			outcome: 'stale',
			reason: 'The trigger label was removed before review started.',
		});
		expect(getContent).toHaveBeenCalledTimes(1);
	});

	it('rejects a changed pull request head before reading repository configuration', async () => {
		const { client, getContent } = createClient();
		vi.mocked(client.rest.pulls.get).mockResolvedValueOnce({
			data: { state: 'open', head: { sha: 'c'.repeat(40) } },
		} as never);

		await expect(loadReviewSetup(client, trigger())).resolves.toEqual({
			outcome: 'stale',
			reason: 'The pull request head changed before review started.',
		});
		expect(getContent).not.toHaveBeenCalled();
	});
});
