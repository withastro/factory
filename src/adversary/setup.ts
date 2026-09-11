import { type AdversaryConfig, loadFactoryConfig } from '../config.ts';
import type { InstallationClient } from '../github/client.ts';
import { ensureLabelExists } from '../github/issues.ts';
import { readSkillSnapshot } from '../github/skill.ts';
import type { LabelAppearance } from '../triage/labels.ts';
import type {
	AdversaryWorkflowParams,
	BlueTeamInput,
	PurpleTeamInput,
} from './contracts.ts';
import {
	defaultBlueTeamSkill,
	defaultPurpleTeamSkill,
} from './default-skill.ts';

const ADVERSARY_LABEL_APPEARANCE: LabelAppearance = {
	color: '8250df',
	description:
		'Ask Factory to propose and judge an alternative implementation.',
};

export type AdversarySetup =
	| { outcome: 'ignored' | 'stale'; reason: string }
	| {
			outcome: 'ready';
			triggerLabel: string;
			blueInput: Omit<BlueTeamInput, 'sandboxId'>;
			purpleInput: Omit<
				PurpleTeamInput,
				'sandboxId' | 'blueSummary' | 'blueApproach'
			>;
	  };

export async function matchesAdversaryTrigger(
	client: InstallationClient,
	params: AdversaryWorkflowParams,
): Promise<boolean> {
	const config = await loadAdversaryConfig(client, params);
	return config?.trigger.label === params.label;
}

export async function loadAdversarySetup(
	client: InstallationClient,
	params: AdversaryWorkflowParams,
): Promise<AdversarySetup> {
	const pull = await client.rest.pulls.get({
		owner: params.owner,
		repo: params.repo,
		pull_number: params.pullNumber,
	});
	if (pull.data.base.repo.private) {
		return {
			outcome: 'ignored',
			reason: 'Factory Adversary currently supports public repositories only.',
		};
	}
	if (pull.data.state !== 'open') {
		return { outcome: 'stale', reason: 'The pull request is no longer open.' };
	}
	if (pull.data.head.sha.toLowerCase() !== params.headSha.toLowerCase()) {
		return {
			outcome: 'stale',
			reason:
				'The pull request head changed before adversary analysis started.',
		};
	}
	if (
		pull.data.base.ref !== params.baseRef ||
		pull.data.base.sha.toLowerCase() !== params.baseSha.toLowerCase()
	) {
		return {
			outcome: 'stale',
			reason:
				'The pull request base changed before adversary analysis started.',
		};
	}

	const config = await loadAdversaryConfig(client, params);
	if (!config || config.trigger.label !== params.label) {
		return {
			outcome: 'ignored',
			reason: `Label "${params.label}" is not the configured adversary trigger.`,
		};
	}
	const labels = pull.data.labels.map((label) =>
		typeof label === 'string' ? label : label.name,
	);
	if (!labels.includes(config.trigger.label)) {
		return {
			outcome: 'stale',
			reason:
				'The adversary trigger label was removed before analysis started.',
		};
	}

	await ensureLabelExists(
		client,
		params.owner,
		params.repo,
		config.trigger.label,
		ADVERSARY_LABEL_APPEARANCE,
	);
	const blueSkill = config.blueTeam.skill
		? await readSkillSnapshot(
				client,
				params.owner,
				params.repo,
				config.blueTeam.skill,
				params.configurationSha,
			)
		: defaultBlueTeamSkill;
	const purpleSkill = config.purpleTeam.skill
		? await readSkillSnapshot(
				client,
				params.owner,
				params.repo,
				config.purpleTeam.skill,
				params.configurationSha,
			)
		: defaultPurpleTeamSkill;
	const shared = {
		owner: params.owner,
		repo: params.repo,
		pullNumber: params.pullNumber,
		baseSha: params.baseSha,
		headSha: params.headSha,
		title: pull.data.title,
		body: pull.data.body ?? '',
	};
	return {
		outcome: 'ready',
		triggerLabel: config.trigger.label,
		blueInput: {
			...shared,
			baseRef: params.baseRef,
			model: config.blueTeam.model,
			skill: blueSkill,
		},
		purpleInput: {
			...shared,
			model: config.purpleTeam.model,
			skill: purpleSkill,
		},
	};
}

async function loadAdversaryConfig(
	client: InstallationClient,
	params: AdversaryWorkflowParams,
): Promise<AdversaryConfig | undefined> {
	const { config } = await loadFactoryConfig(
		client,
		params.owner,
		params.repo,
		params.configurationSha,
	);
	return config.adversary;
}
