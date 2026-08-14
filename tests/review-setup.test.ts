import { describe, expect, it, vi } from 'vitest';
import { REPOSITORY_CONFIG_PATHS } from '../src/config.ts';
import type { InstallationClient } from '../src/github/client.ts';
import type { ReviewWorkflowParams } from '../src/review/contracts.ts';
import { loadReviewSetup, matchesReviewTrigger } from '../src/review/setup.ts';

const BASE_SHA = 'a'.repeat(40);
const CONFIGURATION_SHA = 'c'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const SKILL_DIRECTORY = '.agents/skills/astro-review';
const CONFIG = `version: 1
review:
  trigger:
    label: astro-review
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
		configurationSha: CONFIGURATION_SHA,
		headSha: HEAD_SHA,
	};
}

function createClient(
	labels: Array<{ name: string }> = [{ name: 'astro-review' }],
	configPaths: readonly string[] = [REPOSITORY_CONFIG_PATHS[0]],
	config: string = CONFIG,
) {
	const getContent = vi.fn(async ({ path }: { path: string }) => {
		if (configPaths.includes(path)) {
			return { data: { type: 'file', content: encode(config), encoding: 'base64' } };
		}
		if ((REPOSITORY_CONFIG_PATHS as readonly string[]).includes(path)) {
			throw Object.assign(new Error(`Not found: ${path}`), { status: 404 });
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
	it('matches the configured trigger without loading the review skill', async () => {
		const { client, getContent } = createClient();

		await expect(matchesReviewTrigger(client, trigger())).resolves.toBe(true);
		await expect(
			matchesReviewTrigger(client, { ...trigger(), label: 'documentation' }),
		).resolves.toBe(false);
		expect(getContent).toHaveBeenCalledTimes(2);
		for (const [request] of getContent.mock.calls) {
			expect(request).toMatchObject({ ref: CONFIGURATION_SHA });
		}
		expect(getContent).not.toHaveBeenCalledWith(
			expect.objectContaining({ path: SKILL_DIRECTORY }),
		);
	});

	it('loads configuration and skill from the target branch snapshot', async () => {
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
			expect(request).toMatchObject({ ref: CONFIGURATION_SHA });
		}
	});

	it('falls back to the .yaml configuration extension', async () => {
		const { client, getContent } = createClient(
			[{ name: 'astro-review' }],
			[REPOSITORY_CONFIG_PATHS[1]],
		);

		await expect(loadReviewSetup(client, trigger())).resolves.toMatchObject({ outcome: 'ready' });
		expect(getContent.mock.calls.map(([request]) => request.path)).toEqual([
			REPOSITORY_CONFIG_PATHS[0],
			REPOSITORY_CONFIG_PATHS[1],
			SKILL_DIRECTORY,
		]);
	});

	it('ignores repositories without any configuration file', async () => {
		const { client } = createClient([{ name: 'astro-review' }], []);

		await expect(loadReviewSetup(client, trigger())).resolves.toMatchObject({
			outcome: 'ignored',
			reason: expect.stringContaining('No review capability is configured'),
		});
	});

	it('ignores repositories whose configuration has no review section', async () => {
		const { client } = createClient(
			[{ name: 'astro-review' }],
			[REPOSITORY_CONFIG_PATHS[0]],
			'version: 1\ntriage:\n  enabled: true\n',
		);

		await expect(loadReviewSetup(client, trigger())).resolves.toMatchObject({
			outcome: 'ignored',
			reason: expect.stringContaining('No review capability is configured'),
		});
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
