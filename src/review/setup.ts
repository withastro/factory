/**
 * Loads everything a review run needs: repository configuration plus either
 * the bundled review skill or a repository override. Repository content is
 * read at the immutable target-branch SHA captured during webhook processing
 * (never from the PR head).
 */

import {
	type FactoryConfig,
	loadFactoryConfig,
	REPOSITORY_CONFIG_PATHS,
} from '../config.ts';
import type { InstallationClient } from '../github/client.ts';
import { ensureLabelExists } from '../github/issues.ts';
import { readSkillSnapshot } from '../github/skill.ts';
import { includesPersona, isPersona } from '../personas/personas.ts';
import type { LabelAppearance } from '../triage/labels.ts';
import type { ReviewAgentInput, ReviewWorkflowParams } from './contracts.ts';
import { defaultReviewSkill } from './default-skill.ts';

const REVIEW_TRIGGER_LABEL_APPEARANCE: LabelAppearance = {
	color: '5319e7',
	description: 'Trigger an automated code review when added to a pull request.',
};

export type ReviewSetup =
	| { outcome: 'ignored'; reason: string }
	| { outcome: 'stale'; reason: string }
	| {
			outcome: 'ready';
			agentInput: ReviewAgentInput;
			/** The author persona's login, unassigned on a stand-still. */
			authorLogin?: string;
	  };

export async function matchesReviewTrigger(
	client: InstallationClient,
	trigger: ReviewWorkflowParams,
): Promise<boolean> {
	const { config } = await loadFactoryConfig(
		client,
		trigger.owner,
		trigger.repo,
		trigger.configurationSha,
	);
	return triggerMismatch(config, trigger) === undefined;
}

/**
 * Why `trigger` doesn't match the configuration, or undefined when it does.
 * A label must equal the configured review label; a persona trigger must name
 * the configured reviewer persona, which itself requires a review section.
 */
function triggerMismatch(
	config: FactoryConfig,
	trigger: ReviewWorkflowParams,
): string | undefined {
	const review = config.review;
	if (review === undefined) {
		return `No review capability is configured in ${REPOSITORY_CONFIG_PATHS[0]} at the target branch snapshot.`;
	}
	if (trigger.persona) {
		return isPersona(config.personas, 'reviewer', trigger.persona.login)
			? undefined
			: `${trigger.persona.login} is not the configured reviewer persona.`;
	}
	return review.trigger.label === trigger.label
		? undefined
		: `Label "${trigger.label}" does not match configured label "${review.trigger.label}".`;
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
		return {
			outcome: 'stale',
			reason: 'The pull request head changed before review started.',
		};
	}

	const { config: factoryConfig } = await loadFactoryConfig(
		client,
		trigger.owner,
		trigger.repo,
		trigger.configurationSha,
	);
	const mismatch = triggerMismatch(factoryConfig, trigger);
	const config = factoryConfig.review;
	if (mismatch !== undefined || config === undefined) {
		return { outcome: 'ignored', reason: mismatch ?? 'No review configured.' };
	}

	if (trigger.persona) {
		// The request is the trigger: withdrawing it before the queued review
		// starts cancels the review, just as removing the label does.
		const persona = trigger.persona;
		const current =
			persona.signal === 'review-requested'
				? (pull.data.requested_reviewers ?? []).map((user) => user.login)
				: (pull.data.assignees ?? []).map((user) => user.login);
		if (!includesPersona(factoryConfig.personas, 'reviewer', current)) {
			return {
				outcome: 'stale',
				reason:
					persona.signal === 'review-requested'
						? 'The review request was withdrawn before review started.'
						: 'The reviewer persona was unassigned before review started.',
			};
		}
	} else {
		const labels = pull.data.labels.map((label) =>
			typeof label === 'string' ? label : label.name,
		);
		if (!labels.includes(config.trigger.label)) {
			return {
				outcome: 'stale',
				reason: 'The trigger label was removed before review started.',
			};
		}

		await ensureLabelExists(
			client,
			trigger.owner,
			trigger.repo,
			config.trigger.label,
			REVIEW_TRIGGER_LABEL_APPEARANCE,
		);
	}

	const skill = config.skill
		? await readSkillSnapshot(
				client,
				trigger.owner,
				trigger.repo,
				config.skill,
				trigger.configurationSha,
			)
		: defaultReviewSkill();

	return {
		outcome: 'ready',
		...(factoryConfig.personas.author
			? { authorLogin: factoryConfig.personas.author.login }
			: {}),
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
			...(trigger.persona ? {} : { triggerLabel: config.trigger.label }),
			model: config.model,
			severities: config.severity,
			areas: config.areas,
			skill,
			unresolvedReviewThreads: [],
		},
	};
}
