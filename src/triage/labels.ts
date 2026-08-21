/**
 * Triage label state machine vocabulary.
 *
 * Every triage state maps to exactly one label. The bot swaps labels by
 * removing the old one and adding the new one; at any point in time an issue
 * should carry at most one label from this set. Labels are created on demand
 * in repositories that don't have them yet.
 */

export interface TriageLabelConfig {
	needsTriage: string;
	inProgress: string;
	notActionable: string;
	needsReproduction: string;
	skipped: string;
	unableToReproduce: string;
	unableToFix: string;
	failed: string;
	fixPending: string;
	fixRejected: string;
	fixVerified: string;
	/** Applied to the pull request opened for a verified fix, not the issue. */
	prFixVerified: string;
}

export const DEFAULT_TRIAGE_LABELS: TriageLabelConfig = {
	needsTriage: 'triage: needs triage',
	inProgress: 'triage: in progress',
	notActionable: 'triage: not actionable',
	needsReproduction: 'triage: needs reproduction',
	skipped: 'triage: skipped',
	unableToReproduce: 'triage: unable to reproduce',
	unableToFix: 'triage: unable to fix',
	failed: 'triage: failed',
	fixPending: 'triage: fix pending',
	fixRejected: 'triage: fix rejected',
	fixVerified: 'triage: fix verified',
	prFixVerified: 'fix verified',
};

export interface LabelAppearance {
	color: string;
	description: string;
}

/** Colors and descriptions used when the bot creates a missing label. */
export const TRIAGE_LABEL_APPEARANCE: Record<
	keyof TriageLabelConfig,
	LabelAppearance
> = {
	needsTriage: {
		color: 'bfd4f2',
		description: 'Awaiting automated or manual triage',
	},
	inProgress: {
		color: '1d76db',
		description: 'Automated triage is currently running',
	},
	notActionable: {
		color: 'c2c2c2',
		description: 'Automated triage found nothing actionable',
	},
	needsReproduction: {
		color: 'fbca04',
		description: 'More details are needed to reproduce',
	},
	skipped: {
		color: 'c2c2c2',
		description: 'Automated triage was intentionally skipped',
	},
	unableToReproduce: {
		color: 'e99695',
		description: 'Automated triage could not reproduce the bug',
	},
	unableToFix: {
		color: 'e99695',
		description: 'Reproduced, but automated triage could not fix it',
	},
	failed: {
		color: 'd93f0b',
		description: 'Automated triage failed unexpectedly',
	},
	fixPending: {
		color: '0e8a16',
		description: 'A candidate fix is waiting for reporter confirmation',
	},
	fixRejected: {
		color: 'd93f0b',
		description: 'The reporter said the candidate fix does not work',
	},
	fixVerified: { color: '0e8a16', description: 'The fix was verified' },
	prFixVerified: {
		color: '0e8a16',
		description: 'This pull request contains a verified fix',
	},
};

/** All triage state labels (excludes the PR label). */
export function allTriageLabels(config: TriageLabelConfig): string[] {
	return [
		config.needsTriage,
		config.inProgress,
		config.notActionable,
		config.needsReproduction,
		config.skipped,
		config.unableToReproduce,
		config.unableToFix,
		config.failed,
		config.fixPending,
		config.fixRejected,
		config.fixVerified,
	];
}

/** Labels that allow re-triage when a new comment arrives. */
export function retriageableLabels(config: TriageLabelConfig): string[] {
	return [
		config.needsTriage,
		config.needsReproduction,
		config.unableToReproduce,
		config.unableToFix,
		config.failed,
		config.fixRejected,
	];
}

/** Terminal labels — no further bot action on new comments. */
export function terminalLabels(config: TriageLabelConfig): string[] {
	return [config.fixVerified, config.notActionable, config.skipped];
}

/**
 * Find the current triage label on an issue, if any.
 * Returns the first matching triage label, or null.
 */
export function currentTriageLabel(
	issueLabels: string[],
	config: TriageLabelConfig,
): string | null {
	const all = allTriageLabels(config);
	return issueLabels.find((label) => all.includes(label)) ?? null;
}

/** Look up the appearance for a configured label name, if it is one of ours. */
export function labelAppearance(
	name: string,
	config: TriageLabelConfig,
): LabelAppearance | undefined {
	for (const [key, configured] of Object.entries(config)) {
		if (configured === name) {
			return TRIAGE_LABEL_APPEARANCE[key as keyof TriageLabelConfig];
		}
	}
	return undefined;
}
