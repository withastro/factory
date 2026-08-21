import { describe, expect, it, vi } from 'vitest';
import type { InstallationClient } from '../src/github/client.ts';
import {
	dispatchPreviewRelease,
	findPreviewReleaseCheck,
	formatPreviewReleaseSection,
	parsePreviewReleasePayload,
} from '../src/triage/preview-release.ts';

function summary(payload: unknown): string {
	return `Preview release\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;
}

describe('parsePreviewReleasePayload', () => {
	it('reads packages from a fenced JSON block', () => {
		expect(
			parsePreviewReleasePayload(
				summary({
					packages: [
						{
							name: 'astro',
							url: 'https://pkg.pr.new/withastro/astro/astro@abc1234',
						},
						{
							name: '@astrojs/rss',
							url: 'https://pkg.pr.new/withastro/astro/rss@abc1234',
						},
					],
				}),
			),
		).toEqual([
			{
				name: 'astro',
				url: 'https://pkg.pr.new/withastro/astro/astro@abc1234',
			},
			{
				name: '@astrojs/rss',
				url: 'https://pkg.pr.new/withastro/astro/rss@abc1234',
			},
		]);
	});

	it('accepts a bare JSON summary', () => {
		expect(
			parsePreviewReleasePayload(
				'{"packages":[{"name":"astro","url":"https://pkg.pr.new/a/b@c"}]}',
			),
		).toEqual([{ name: 'astro', url: 'https://pkg.pr.new/a/b@c' }]);
	});

	it.each([
		['prose only', 'The preview release failed.'],
		['malformed JSON', '```json\n{"packages":[\n```'],
		['an empty package list', summary({ packages: [] })],
		['a missing url', summary({ packages: [{ name: 'astro' }] })],
		[
			'a non-https url',
			summary({ packages: [{ name: 'astro', url: 'http://pkg.pr.new/a' }] }),
		],
		[
			'a javascript: url',
			summary({ packages: [{ name: 'astro', url: 'javascript:alert(1)' }] }),
		],
		[
			'a url containing markdown injection',
			summary({
				packages: [
					{
						name: 'astro',
						url: 'https://pkg.pr.new/a)[click](https://evil.test',
					},
				],
			}),
		],
		[
			'a url on an untrusted host',
			summary({
				packages: [
					{ name: 'astro', url: 'https://evil.test/withastro/astro@sha' },
				],
			}),
		],
		[
			'a host that merely contains the allowed host',
			summary({
				packages: [
					{ name: 'astro', url: 'https://pkg.pr.new.evil.test/a@sha' },
				],
			}),
		],
		[
			'a url embedding the allowed host as credentials',
			summary({
				packages: [
					{ name: 'astro', url: 'https://pkg.pr.new@evil.test/a@sha' },
				],
			}),
		],
		[
			'a package name that could break out of the shell block',
			summary({
				packages: [
					{
						name: 'astro\n```\n[click](https://evil.test)',
						url: 'https://pkg.pr.new/a@sha',
					},
				],
			}),
		],
	])('reports no packages for %s', (_case, value) => {
		expect(parsePreviewReleasePayload(value)).toEqual([]);
	});

	it('rejects the whole payload when any single url is untrusted', () => {
		expect(
			parsePreviewReleasePayload(
				summary({
					packages: [
						{
							name: 'astro',
							url: 'https://pkg.pr.new/withastro/astro/astro@abc1234',
						},
						{ name: 'evil', url: 'https://evil.test/payload' },
					],
				}),
			),
		).toEqual([]);
	});

	it('accepts a subdomain of an allowed host and a repository-widened host', () => {
		expect(
			parsePreviewReleasePayload(
				summary({ packages: [{ name: 'a', url: 'https://cdn.pkg.pr.new/a' }] }),
			),
		).toEqual([{ name: 'a', url: 'https://cdn.pkg.pr.new/a' }]);
		expect(
			parsePreviewReleasePayload(
				summary({
					packages: [{ name: 'a', url: 'https://previews.corp.test/a' }],
				}),
				['previews.corp.test'],
			),
		).toEqual([{ name: 'a', url: 'https://previews.corp.test/a' }]);
	});

	it('rejects an implausibly long package list rather than truncating it', () => {
		const packages = Array.from({ length: 21 }, (_, index) => ({
			name: `pkg-${index}`,
			url: `https://pkg.pr.new/a/pkg-${index}@sha`,
		}));
		expect(parsePreviewReleasePayload(summary({ packages }))).toEqual([]);
	});
});

describe('dispatchPreviewRelease', () => {
	function createClient(dispatch: () => Promise<unknown>) {
		const createWorkflowDispatch = vi.fn(dispatch);
		return {
			client: {
				rest: { actions: { createWorkflowDispatch } },
			} as unknown as InstallationClient,
			createWorkflowDispatch,
		};
	}

	const options = {
		owner: 'withastro',
		repo: 'astro',
		workflow: 'factory-preview.yml',
		ref: 'main',
		branch: 'factory/fix-42',
		issueNumber: 42,
	};

	it('dispatches the maintainer-controlled ref with the fix branch as an input', async () => {
		const { client, createWorkflowDispatch } = createClient(async () => ({}));

		await expect(
			dispatchPreviewRelease(client, options),
		).resolves.toMatchObject({
			dispatched: true,
		});
		expect(createWorkflowDispatch).toHaveBeenCalledWith({
			owner: 'withastro',
			repo: 'astro',
			workflow_id: 'factory-preview.yml',
			ref: 'main',
			inputs: { branch: 'factory/fix-42', issue: '42' },
		});
	});

	it.each([403, 404, 422])(
		'reports an undispatchable workflow (HTTP %i)',
		async (status) => {
			const { client } = createClient(async () => {
				throw Object.assign(new Error(`HTTP ${status}`), { status });
			});

			await expect(dispatchPreviewRelease(client, options)).resolves.toEqual({
				dispatched: false,
				detail: `factory-preview.yml could not be dispatched (HTTP ${status}).`,
			});
		},
	);

	it('propagates unexpected failures so the step can retry', async () => {
		const { client } = createClient(async () => {
			throw Object.assign(new Error('server error'), { status: 500 });
		});

		await expect(dispatchPreviewRelease(client, options)).rejects.toThrow(
			'server error',
		);
	});
});

describe('findPreviewReleaseCheck', () => {
	const lookup = {
		checkName: 'factory/preview-release',
		appSlug: 'github-actions',
	};

	function createClient(runs: unknown[]) {
		const listForRef = vi.fn(async () => ({ data: { check_runs: runs } }));
		return {
			client: {
				rest: { checks: { listForRef } },
			} as unknown as InstallationClient,
			listForRef,
		};
	}

	it('queries the exact commit and check name', async () => {
		const { client, listForRef } = createClient([]);

		await expect(
			findPreviewReleaseCheck(
				client,
				'withastro',
				'astro',
				'a'.repeat(40),
				lookup,
			),
		).resolves.toBeNull();
		expect(listForRef).toHaveBeenCalledWith(
			expect.objectContaining({
				ref: 'a'.repeat(40),
				check_name: 'factory/preview-release',
			}),
		);
	});

	it('returns the newest run so a re-run supersedes an earlier failure', async () => {
		const { client } = createClient([
			{
				status: 'completed',
				conclusion: 'failure',
				started_at: '2026-08-14T10:00:00Z',
				app: { slug: 'github-actions' },
				output: { summary: 'old' },
			},
			{
				status: 'completed',
				conclusion: 'success',
				started_at: '2026-08-14T12:00:00Z',
				app: { slug: 'github-actions' },
				output: { summary: 'new' },
			},
		]);

		await expect(
			findPreviewReleaseCheck(client, 'withastro', 'astro', 'sha', lookup),
		).resolves.toEqual({
			status: 'completed',
			conclusion: 'success',
			summary: 'new',
		});
	});

	it('normalizes an in-progress run with no output', async () => {
		const { client } = createClient([
			{
				status: 'in_progress',
				conclusion: null,
				started_at: '2026-08-14T10:00:00Z',
				app: { slug: 'github-actions' },
			},
		]);

		await expect(
			findPreviewReleaseCheck(client, 'withastro', 'astro', 'sha', lookup),
		).resolves.toEqual({
			status: 'in_progress',
			conclusion: null,
			summary: '',
		});
	});

	it('ignores a same-named check run published by another app', async () => {
		// `checks.listForRef` returns the latest run per app, so any app installed
		// on the repository could otherwise win on recency.
		const { client } = createClient([
			{
				status: 'completed',
				conclusion: 'success',
				started_at: '2026-08-14T13:00:00Z',
				app: { slug: 'impostor-app' },
				output: { summary: 'forged' },
			},
			{
				status: 'completed',
				conclusion: 'failure',
				started_at: '2026-08-14T12:00:00Z',
				app: { slug: 'github-actions' },
				output: { summary: 'real' },
			},
		]);

		await expect(
			findPreviewReleaseCheck(client, 'withastro', 'astro', 'sha', lookup),
		).resolves.toEqual({
			status: 'completed',
			conclusion: 'failure',
			summary: 'real',
		});
	});
});

describe('formatPreviewReleaseSection', () => {
	it('renders copy-pasteable install commands', () => {
		expect(
			formatPreviewReleaseSection([
				{
					name: 'astro',
					url: 'https://pkg.pr.new/withastro/astro/astro@abc1234',
				},
			]),
		).toContain('npm i https://pkg.pr.new/withastro/astro/astro@abc1234');
	});
});
