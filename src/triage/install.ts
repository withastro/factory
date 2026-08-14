/**
 * Install-time repository setup: create the full triage label vocabulary as
 * soon as the App is installed, so maintainers immediately see the labels in
 * the picker and can drive the state machine by hand. Runs again harmlessly
 * on repeat installs (label creation is idempotent).
 */

import { loadFactoryConfig } from '../config.ts';
import type { InstallationClient } from '../github/client.ts';
import { ensureLabelExists } from '../github/issues.ts';
import { TRIAGE_LABEL_APPEARANCE, type TriageLabelConfig } from './labels.ts';

export async function ensureRepositoryLabels(
	client: InstallationClient,
	owner: string,
	repo: string,
): Promise<void> {
	// Read the repository's own configuration from its default branch so
	// renamed labels are created under their configured names.
	const { config } = await loadFactoryConfig(client, owner, repo);
	if (!config.triage.enabled) return;

	const labels = config.triage.labels;
	for (const key of Object.keys(labels) as Array<keyof TriageLabelConfig>) {
		await ensureLabelExists(client, owner, repo, labels[key], TRIAGE_LABEL_APPEARANCE[key]);
	}
}
