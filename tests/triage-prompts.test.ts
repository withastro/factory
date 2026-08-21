import { describe, expect, it } from 'vitest';
import type { TriagePipelineInput } from '../src/triage/pipeline-contracts.ts';
import { pipelineSystemPrompt } from '../src/triage/prompts.ts';

const input: TriagePipelineInput = {
	sandboxId: 'triage:1:139:delivery-139',
	owner: 'withastro',
	repo: 'compiler-rs',
	issueNumber: 139,
	issueTitle: 'Nested global selectors are not stripped',
	issueBody: 'Both :has() and :is() cases should work.',
	issueAuthor: 'reporter',
	issueAuthorAssociation: 'MEMBER',
	conversation: [
		{
			author: 'reporter',
			association: 'MEMBER',
			isBot: false,
			body: 'The :has() case works now, but :is() is still broken.',
		},
	],
	defaultBranch: 'main',
	fixBranch: 'factory/fix-139',
	continuingFix: false,
	skillName: 'triage',
	skillDirectory: '.agents/skills/triage',
	model: 'anthropic/claude-sonnet-4-6',
};

describe('pipeline system prompt', () => {
	it('starts a fresh run from the default branch', () => {
		const prompt = pipelineSystemPrompt(input);
		expect(prompt).toContain('on branch `factory/fix-139` (created from `main`)');
		expect(prompt).not.toContain('existing candidate branch');
	});

	it('tells a continuing run to build on the candidate already on the branch', () => {
		const prompt = pipelineSystemPrompt({ ...input, continuingFix: true });
		expect(prompt).toContain('existing candidate branch `factory/fix-139`');
		expect(prompt).toContain('preserve the parts of the fix that already work');
		// Whether vague feedback is worth a run at all is decided by the
		// verifier before this agent starts, so the prompt must not promise
		// comment-step behavior that does not exist.
		expect(prompt).not.toContain('fixed=false');
		expect(prompt).not.toContain('ask the reporter');
	});

	it('carries the reporter feedback into the run', () => {
		const prompt = pipelineSystemPrompt({ ...input, continuingFix: true });
		expect(prompt).toContain('but :is() is still broken');
	});
});
