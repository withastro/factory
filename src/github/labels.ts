import type { InstallationClient } from './client.ts';

export interface TriggerLabelInput {
	owner: string;
	repo: string;
	pullNumber: number;
	label: string;
}

export async function removeTriggerLabel(
	client: InstallationClient,
	input: TriggerLabelInput,
): Promise<void> {
	try {
		await client.rest.issues.removeLabel({
			owner: input.owner,
			repo: input.repo,
			issue_number: input.pullNumber,
			name: input.label,
		});
	} catch (error) {
		if (!isGitHubStatus(error, 404)) throw error;
	}
}

function isGitHubStatus(error: unknown, status: number): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		(error as { status?: unknown }).status === status
	);
}
