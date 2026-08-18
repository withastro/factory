'use agent';

import {
	bash,
	useAgentFinish,
	useDataWriter,
	useInitialData,
	useModel,
	useSandbox,
	useTool,
} from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';
import {
	fixVerdictSchema,
	fixVerifierInputSchema,
	validateFixVerdict,
	type FixVerifierInput,
} from '../contracts.ts';
import { fixVerifierPrompt } from '../fix-verification.ts';

/**
 * Classifies whether the latest comment on a fix-pending issue confirms that
 * the candidate fix works, and drafts the pull request content when it does.
 * This agent only reads the conversation it is given; it has no GitHub access.
 */
export function FixVerifier() {
	const input = useInitialData<FixVerifierInput>();
	useModel(input.model);

	useSandbox(bash(() => new Bash({ fs: new InMemoryFs() })));

	const writeVerdict = useDataWriter('verdict', { schema: fixVerdictSchema });
	useTool({
		name: 'submit_fix_verification',
		description:
			'Submit the final classification. Call exactly once. When status is "confirmed", pr must contain the pull request title and body; otherwise pr must be null.',
		input: fixVerdictSchema,
		run({ data }) {
			writeVerdict(validateFixVerdict(data));
			return { output: { accepted: true }, terminate: true };
		},
	});
	useAgentFinish(({ response, append }) => {
		const submitted = response.toolCalls.some(
			(call) => call.tool === 'submit_fix_verification' && !call.isError,
		);
		if (!submitted) {
			append({
				kind: 'signal',
				type: 'triage.verdict-required',
				body: 'The classification is incomplete. Call submit_fix_verification with the final verdict.',
			});
		}
	});

	return fixVerifierPrompt(input);
}

FixVerifier.initialData = fixVerifierInputSchema;
FixVerifier.durability = { maxAttempts: 5, timeoutMs: 10 * 60 * 1_000 };
