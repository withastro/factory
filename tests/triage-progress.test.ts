import { describe, expect, it } from 'vitest';
import {
	formatTriageProgress,
	triageProgressMarker,
	type TriageProgressState,
} from '../src/triage/progress.ts';

function progress(overrides: Partial<TriageProgressState> = {}): TriageProgressState {
	return {
		current: 'workspace',
		includeInstall: true,
		includeBuild: false,
		details: {},
		skipped: {},
		...overrides,
	};
}

describe('triage progress comments', () => {
	it('renders configured stages and highlights the current one', () => {
		const comment = formatTriageProgress(
			'delivery/1',
			progress({
				current: 'reproduce',
				details: { workspace: 'ready', install: 'complete' },
			}),
		);

		expect(comment).toContain('- [x] Prepare the workspace: ready');
		expect(comment).toContain('- [x] Install dependencies: complete');
		expect(comment).not.toContain('Build the project');
		expect(comment).toContain('- [ ] **Reproduce the issue** (in progress)');
		expect(comment).toContain(triageProgressMarker('delivery/1'));
	});

	it('accounts for conditional stages in a completed report', () => {
		const comment = formatTriageProgress(
			'delivery-2',
			progress({
				current: 'complete',
				skipped: {
					diagnose: 'the issue was not reproduced',
					verify: 'the issue was not reproduced',
					fix: 'the issue was not reproduced',
				},
			}),
			'The final report.',
		);

		expect(comment).toContain('## Triage complete');
		expect(comment).toContain(
			'- [x] Diagnose the cause: not needed (the issue was not reproduced)',
		);
		expect(comment).toContain('---\n\nThe final report.');
	});

	it('marks the active stage when triage fails', () => {
		const comment = formatTriageProgress(
			'delivery-3',
			progress({ current: 'verify', failed: true }),
			'Triage failed unexpectedly.',
		);

		expect(comment).toContain('## Triage stopped');
		expect(comment).toContain('- [ ] **Verify the diagnosis failed**');
		expect(comment).toContain('Triage failed unexpectedly.');
	});
});
