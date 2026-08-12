import { describe, expect, it, vi } from 'vitest';
import type { InstallationClient } from '../src/github/client.ts';
import { removeTriggerLabel } from '../src/github/labels.ts';

const input = {
	owner: 'withastro',
	repo: 'astro',
	pullNumber: 123,
	label: 'astro-review',
};

function createClient(error?: unknown) {
	const removeLabel = vi.fn(async () => {
		if (error) throw error;
		return { data: [] };
	});
	const client = {
		rest: { issues: { removeLabel } },
	} as unknown as InstallationClient;
	return { client, removeLabel };
}

describe('trigger label removal', () => {
	it('removes the pull request label', async () => {
		const { client, removeLabel } = createClient();

		await removeTriggerLabel(client, input);
		expect(removeLabel).toHaveBeenCalledWith({
			owner: input.owner,
			repo: input.repo,
			issue_number: input.pullNumber,
			name: input.label,
		});
	});

	it('treats an already-removed label as success', async () => {
		const { client } = createClient(Object.assign(new Error('Not found'), { status: 404 }));

		await expect(removeTriggerLabel(client, input)).resolves.toBeUndefined();
	});

	it('propagates other GitHub errors', async () => {
		const error = Object.assign(new Error('Forbidden'), { status: 403 });
		const { client } = createClient(error);

		await expect(removeTriggerLabel(client, input)).rejects.toBe(error);
	});
});
