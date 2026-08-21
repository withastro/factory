'use agent';

import { env } from 'cloudflare:workers';
import {
	useAgentFinish,
	useDataWriter,
	useInitialData,
	useModel,
	useSandbox,
	useTool,
} from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import type { WorkerEnv } from '../../env.ts';
import {
	commentResultSchema,
	diagnoseResultSchema,
	fixResultSchema,
	labelSelectionSchema,
	prContentSchema,
	reproduceResultSchema,
	triagePipelineInputSchema,
	verifyResultSchema,
	type TriagePipelineInput,
} from '../pipeline-contracts.ts';
import { pipelineSystemPrompt } from '../prompts.ts';
import { getTriageSandbox, REPO_DIR } from '../sandbox.ts';

/**
 * The triage pipeline agent: one conversation per triage run, working in a
 * Cloudflare Sandbox that holds a real checkout of the target repository.
 * The workflow drives it one step at a time (reproduce → diagnose → verify →
 * fix → comment → labels), each step ending in a structured submit tool.
 *
 * The agent never holds GitHub credentials: the clone is anonymous, and all
 * commits, pushes, comments, and label changes are performed by trusted
 * workflow code outside the sandbox.
 */
export function TriagePipeline() {
	const input = useInitialData<TriagePipelineInput>();
	useModel(input.model, { thinkingLevel: 'high' });

	useSandbox(
		cloudflareSandbox(getTriageSandbox(env as unknown as WorkerEnv, input.sandboxId)),
		{ cwd: REPO_DIR },
	);

	const writeReproduce = useDataWriter('reproduce', { schema: reproduceResultSchema });
	useTool({
		name: 'submit_reproduce_result',
		description: submitDescription('reproduce'),
		input: reproduceResultSchema,
		run({ data }) {
			writeReproduce(data);
			return { output: { accepted: true }, terminate: true };
		},
	});

	const writeDiagnose = useDataWriter('diagnose', { schema: diagnoseResultSchema });
	useTool({
		name: 'submit_diagnose_result',
		description: submitDescription('diagnose'),
		input: diagnoseResultSchema,
		run({ data }) {
			writeDiagnose(data);
			return { output: { accepted: true }, terminate: true };
		},
	});

	const writeVerify = useDataWriter('verify', { schema: verifyResultSchema });
	useTool({
		name: 'submit_verify_result',
		description: submitDescription('verify'),
		input: verifyResultSchema,
		run({ data }) {
			writeVerify(data);
			return { output: { accepted: true }, terminate: true };
		},
	});

	const writeFix = useDataWriter('fix', { schema: fixResultSchema });
	useTool({
		name: 'submit_fix_result',
		description: submitDescription('fix'),
		input: fixResultSchema,
		run({ data }) {
			writeFix(data);
			return { output: { accepted: true }, terminate: true };
		},
	});

	const writeComment = useDataWriter('comment', { schema: commentResultSchema });
	useTool({
		name: 'submit_comment',
		description: submitDescription('comment'),
		input: commentResultSchema,
		run({ data }) {
			writeComment(data);
			return { output: { accepted: true }, terminate: true };
		},
	});

	const writeLabels = useDataWriter('labels', { schema: labelSelectionSchema });
	useTool({
		name: 'submit_label_selection',
		description: submitDescription('labels'),
		input: labelSelectionSchema,
		run({ data }) {
			writeLabels(data);
			return { output: { accepted: true }, terminate: true };
		},
	});

	const writePr = useDataWriter('pr', { schema: prContentSchema });
	useTool({
		name: 'submit_pr_content',
		description: submitDescription('pr'),
		input: prContentSchema,
		run({ data }) {
			writePr(data);
			return { output: { accepted: true }, terminate: true };
		},
	});

	useAgentFinish(({ response, append }) => {
		const submitted = response.toolCalls.some(
			(call) => call.tool.startsWith('submit_') && !call.isError,
		);
		if (!submitted) {
			append({
				kind: 'signal',
				type: 'triage.submission-required',
				body: 'The step is incomplete. Call the submit tool named in the step instructions with the final structured result.',
			});
		}
	});

	return pipelineSystemPrompt(input);
}

TriagePipeline.initialData = triagePipelineInputSchema;
TriagePipeline.durability = { maxAttempts: 10, timeoutMs: 45 * 60 * 1_000 };

function submitDescription(stepName: string): string {
	return `Submit the structured result for the "${stepName}" step. Call exactly once when the step instructions ask for it.`;
}
