import { describe, expect, it, vi } from 'vitest';
import type { InstallationClient } from '../src/github/client.ts';
import {
	replaceIssueLabels,
	saveIssueComment,
	upsertIssueComment,
} from '../src/github/issues.ts';

function mockClient(comments: Array<{ id: number; body: string; user: { type: string } }>) {
	const createComment = vi.fn().mockResolvedValue({ data: { id: 42 } });
	const updateComment = vi.fn().mockResolvedValue({ data: {} });
	const addLabels = vi.fn().mockResolvedValue({ data: {} });
	const removeLabel = vi.fn().mockResolvedValue({ data: {} });
	const listComments = vi.fn();
	const paginate = vi.fn().mockResolvedValue(comments);
	const client = {
		paginate,
		rest: { issues: { addLabels, createComment, listComments, removeLabel, updateComment } },
	} as unknown as InstallationClient;
	return { addLabels, client, createComment, listComments, paginate, removeLabel, updateComment };
}

describe('issue comment upserts', () => {
	it('updates the existing bot comment carrying the marker', async () => {
		const marker = '<!-- factory:triage-progress:delivery -->';
		const { client, createComment, updateComment } = mockClient([
			{ id: 7, body: `Working\n${marker}`, user: { type: 'Bot' } },
		]);

		await expect(upsertIssueComment(client, 'withastro', 'astro', 1, marker, 'Updated')).resolves.toBe(
			7,
		);
		expect(updateComment).toHaveBeenCalledWith({
			owner: 'withastro',
			repo: 'astro',
			comment_id: 7,
			body: `Updated\n\n${marker}`,
		});
		expect(createComment).not.toHaveBeenCalled();
	});

	it('creates a comment when no bot comment carries the marker', async () => {
		const marker = '<!-- factory:triage-progress:delivery -->';
		const { client, createComment, updateComment } = mockClient([
			{ id: 7, body: marker, user: { type: 'User' } },
		]);

		await expect(upsertIssueComment(client, 'withastro', 'astro', 1, marker, 'Started')).resolves.toBe(
			42,
		);
		expect(createComment).toHaveBeenCalledWith({
			owner: 'withastro',
			repo: 'astro',
			issue_number: 1,
			body: `Started\n\n${marker}`,
			request: { retries: 0 },
		});
		expect(updateComment).not.toHaveBeenCalled();
	});

	it('confirms an ambiguous create before allowing a workflow retry', async () => {
		const marker = '<!-- factory:triage-progress:delivery -->';
		const { client, createComment, paginate } = mockClient([]);
		createComment.mockRejectedValueOnce(new Error('response lost'));
		paginate
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ id: 9, body: `Started\n\n${marker}`, user: { type: 'Bot' } },
			]);

		await expect(upsertIssueComment(client, 'withastro', 'astro', 1, marker, 'Started')).resolves.toBe(
			9,
		);
		expect(createComment).toHaveBeenCalledOnce();
		expect(paginate).toHaveBeenCalledTimes(2);
	});

	it('updates a known comment without scanning the issue history', async () => {
		const marker = '<!-- factory:triage-progress:delivery -->';
		const { client, paginate, updateComment } = mockClient([]);

		await expect(
			saveIssueComment(client, 'withastro', 'astro', 1, 12, marker, 'Still working'),
		).resolves.toBe(12);
		expect(updateComment).toHaveBeenCalledWith({
			owner: 'withastro',
			repo: 'astro',
			comment_id: 12,
			body: `Still working\n\n${marker}`,
		});
		expect(paginate).not.toHaveBeenCalled();
	});

	it('removes each previous state before applying the new one', async () => {
		const { addLabels, client, removeLabel } = mockClient([]);

		await replaceIssueLabels(
			client,
			'withastro',
			'astro',
			1,
			['triage: needs triage', 'triage: in progress', 'triage: in progress'],
			'triage: failed',
		);

		expect(removeLabel).toHaveBeenCalledTimes(2);
		expect(addLabels).toHaveBeenCalledWith({
			owner: 'withastro',
			repo: 'astro',
			issue_number: 1,
			labels: ['triage: failed'],
		});
	});
});
