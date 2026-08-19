export type TriageProgressStage =
	| 'workspace'
	| 'install'
	| 'build'
	| 'reproduce'
	| 'diagnose'
	| 'verify'
	| 'fix'
	| 'publish';

export interface TriageProgressState {
	current: TriageProgressStage | 'complete';
	failed?: boolean;
	includeInstall: boolean;
	includeBuild: boolean;
	details: Partial<Record<TriageProgressStage, string>>;
	skipped: Partial<Record<TriageProgressStage, string>>;
}

const STAGES: ReadonlyArray<{ id: TriageProgressStage; label: string }> = [
	{ id: 'workspace', label: 'Prepare the workspace' },
	{ id: 'install', label: 'Install dependencies' },
	{ id: 'build', label: 'Build the project' },
	{ id: 'reproduce', label: 'Reproduce the issue' },
	{ id: 'diagnose', label: 'Diagnose the cause' },
	{ id: 'verify', label: 'Verify the diagnosis' },
	{ id: 'fix', label: 'Attempt a fix' },
	{ id: 'publish', label: 'Publish the result' },
];

export function triageProgressMarker(deliveryId: string): string {
	return `<!-- factory:triage-progress:${encodeURIComponent(deliveryId)} -->`;
}

export function formatTriageProgress(
	deliveryId: string,
	state: TriageProgressState,
	result?: string,
): string {
	const stages = STAGES.filter(
		(stage) =>
			(stage.id !== 'install' || state.includeInstall) &&
			(stage.id !== 'build' || state.includeBuild),
	);
	const currentIndex =
		state.current === 'complete' ? stages.length : stages.findIndex((stage) => stage.id === state.current);
	const heading = state.failed
		? 'Triage stopped'
		: state.current === 'complete'
			? 'Triage complete'
			: 'Working on it';
	const introduction =
		state.failed || state.current === 'complete'
			? ''
			: '\n\nI am triaging this issue now. This comment will update as the investigation progresses.';
	const checklist = stages
		.map((stage, index) => {
			const skipped = state.skipped[stage.id];
			if (skipped) return `- [x] ${stage.label}: not needed (${skipped})`;

			const detail = state.details[stage.id];
			if (index < currentIndex || state.current === 'complete') {
				return `- [x] ${stage.label}${detail ? `: ${detail}` : ''}`;
			}
			if (index === currentIndex) {
				return state.failed
					? `- [ ] **${stage.label} failed**`
					: `- [ ] **${stage.label}** (in progress)`;
			}
			return `- [ ] ${stage.label}`;
		})
		.join('\n');
	const report = result ? `\n\n---\n\n${result}` : '';

	return `## ${heading}${introduction}\n\n${checklist}${report}\n\n${triageProgressMarker(deliveryId)}`;
}
