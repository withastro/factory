/**
 * Loads everything a review run needs from the target repository: the factory
 * configuration and the repository-owned review skill, both read at the
 * immutable target-branch SHA captured during webhook processing (never from
 * the PR head).
 */

import { loadFactoryConfig, REPOSITORY_CONFIG_PATHS, type ReviewConfig } from '../config.ts';
import type { InstallationClient } from '../github/client.ts';
import { readSkillSnapshot } from '../github/skill.ts';
import type { ReviewAgentInput, ReviewWorkflowParams } from './contracts.ts';

export type ReviewSetup =
	| { outcome: 'ignored'; reason: string }
	| { outcome: 'stale'; reason: string }
	| { outcome: 'ready'; agentInput: ReviewAgentInput };

export async function matchesReviewTrigger(
	client: InstallationClient,
	trigger: ReviewWorkflowParams,
): Promise<boolean> {
	const config = await loadReviewConfig(client, trigger);
	return config?.trigger.label === trigger.label;
}

export async function loadReviewSetup(
	client: InstallationClient,
	trigger: ReviewWorkflowParams,
): Promise<ReviewSetup> {
	const pull = await client.rest.pulls.get({
		owner: trigger.owner,
		repo: trigger.repo,
		pull_number: trigger.pullNumber,
	});

	if (pull.data.state !== 'open') {
		return { outcome: 'stale', reason: 'The pull request is no longer open.' };
	}
	if (pull.data.head.sha !== trigger.headSha) {
		return { outcome: 'stale', reason: 'The pull request head changed before review started.' };
	}

	const config = await loadReviewConfig(client, trigger);
	if (config === undefined) {
		return {
			outcome: 'ignored',
			reason: `No review capability is configured in ${REPOSITORY_CONFIG_PATHS[0]} at the target branch snapshot.`,
		};
	}

	if (config.trigger.label !== trigger.label) {
		return {
			outcome: 'ignored',
			reason: `Label "${trigger.label}" does not match configured label "${config.trigger.label}".`,
		};
	}
	const labels = pull.data.labels.map((label) => (typeof label === 'string' ? label : label.name));
	if (!labels.includes(config.trigger.label)) {
		return { outcome: 'stale', reason: 'The trigger label was removed before review started.' };
	}

	const skill = await readSkillSnapshot(
		client,
		trigger.owner,
		trigger.repo,
		config.skill,
		trigger.configurationSha,
	);

	return {
		outcome: 'ready',
		agentInput: {
			deliveryId: trigger.deliveryId,
			installationId: trigger.installationId,
			repositoryId: trigger.repositoryId,
			owner: trigger.owner,
			repo: trigger.repo,
			pullNumber: trigger.pullNumber,
			baseSha: trigger.baseSha,
			headSha: trigger.headSha,
			title: pull.data.title,
			body: pull.data.body ?? '',
			triggerLabel: config.trigger.label,
			severities: config.severity,
			areas: config.areas,
			skill,
		},
	};
}

async function loadReviewConfig(
	client: InstallationClient,
	trigger: ReviewWorkflowParams,
): Promise<ReviewConfig | undefined> {
	const { config } = await loadFactoryConfig(
		client,
		trigger.owner,
		trigger.repo,
		trigger.configurationSha,
	);
	return config.review;
}
