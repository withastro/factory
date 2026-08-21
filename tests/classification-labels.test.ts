import { describe, expect, it } from 'vitest';
import {
	computePriorityLabelsToRemove,
	partitionClassificationLabels,
} from '../src/github/issues.ts';

describe('classification labels', () => {
	describe('partitionClassificationLabels', () => {
		it('separates Astro-style priority labels from package labels', () => {
			const labels = [
				{ name: '- P2-to-be-discussed', description: 'Priority 2' },
				{ name: '- P4: important', description: 'Priority 4' },
				{ name: 'pkg: core', description: 'Core package' },
				{ name: 'pkg: compiler', description: 'Compiler package' },
				{ name: 'bug', description: 'Bug report' },
			];
			const { priorityLabels, packageLabels } =
				partitionClassificationLabels(labels);
			expect(priorityLabels.map((l) => l.name)).toEqual([
				'- P2-to-be-discussed',
				'- P4: important',
			]);
			expect(packageLabels.map((l) => l.name)).toEqual([
				'pkg: core',
				'pkg: compiler',
			]);
		});
	});

	describe('computePriorityLabelsToRemove', () => {
		const priorityLabels = [
			{ name: '- P4: important', description: 'Priority 4' },
			{ name: '- P2-to-be-discussed', description: 'Priority 2' },
			{ name: '- P3: unimportant', description: 'Priority 3' },
		];

		it('removes the old priority label when a different one is selected', () => {
			const issueLabels = [
				'triage: fix verified',
				'- P4: important',
				'pkg: core',
			];
			expect(
				computePriorityLabelsToRemove(
					issueLabels,
					'- P2-to-be-discussed',
					priorityLabels,
				),
			).toEqual(['- P4: important']);
		});

		it('returns an empty list when the same priority label is re-selected', () => {
			const issueLabels = [
				'triage: fix verified',
				'- P4: important',
				'pkg: core',
			];
			expect(
				computePriorityLabelsToRemove(
					issueLabels,
					'- P4: important',
					priorityLabels,
				),
			).toEqual([]);
		});

		it('removes all priority labels when none is selected', () => {
			const issueLabels = [
				'triage: fix verified',
				'- P4: important',
				'- P2-to-be-discussed',
			];
			expect(
				computePriorityLabelsToRemove(issueLabels, null, priorityLabels),
			).toEqual(['- P4: important', '- P2-to-be-discussed']);
		});

		it('leaves package and triage state labels alone', () => {
			const issueLabels = ['triage: needs triage', 'pkg: core', 'bug'];
			expect(
				computePriorityLabelsToRemove(
					issueLabels,
					'- P4: important',
					priorityLabels,
				),
			).toEqual([]);
		});

		it('returns each stale priority label only once even if duplicated on the issue', () => {
			const issueLabels = [
				'- P4: important',
				'- P4: important',
				'- P2-to-be-discussed',
			];
			expect(
				computePriorityLabelsToRemove(
					issueLabels,
					'- P3: unimportant',
					priorityLabels,
				),
			).toEqual(['- P4: important', '- P4: important', '- P2-to-be-discussed']);
		});
	});
});
