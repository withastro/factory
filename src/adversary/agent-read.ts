import type { AgentReply } from '@flue/runtime';
import * as v from 'valibot';

// Keep each long-poll well below Workflows' recommended 30-minute step limit.
const OBSERVATION_WINDOW_MS = 5 * 60 * 1_000;
// Ten windows cover the agent's 45-minute durability timeout with one final check.
const OBSERVATION_WINDOWS = 10;
// Leave one minute for cancellation and result persistence before the step expires.
const OBSERVATION_STEP = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '6 minutes',
} as const;

interface AgentReadWorkflowStep {
	do(
		name: string,
		config: typeof OBSERVATION_STEP,
		callback: (context: { attempt: number }) => Promise<string | null>,
	): Promise<string | null>;
}

export async function readAdversaryAgentResult<S extends v.GenericSchema>(
	step: AgentReadWorkflowStep,
	team: 'blue' | 'purple',
	submissionId: string,
	read: (signal: AbortSignal) => Promise<AgentReply>,
	schema: S,
): Promise<v.InferOutput<S>> {
	for (let index = 0; index < OBSERVATION_WINDOWS; index++) {
		const result = await step.do(
			`read ${team} result`,
			OBSERVATION_STEP,
			async (context) => {
				const controller = new AbortController();
				const timeout = setTimeout(
					() =>
						controller.abort(new Error('Agent observation window elapsed.')),
					OBSERVATION_WINDOW_MS,
				);
				console.info(
					`[adversary] team=${team} submission=${submissionId} observation=${index + 1}/${OBSERVATION_WINDOWS} attempt=${context.attempt} state=started`,
				);

				try {
					const reply = await read(controller.signal);
					const writes = reply.data.result;
					if (!writes?.length)
						throw new Error('The adversary agent produced no result.');
					const serialized = JSON.stringify(writes.at(-1));
					if (serialized === undefined)
						throw new Error('The adversary agent produced no result.');
					console.info(
						`[adversary] team=${team} submission=${submissionId} observation=${index + 1}/${OBSERVATION_WINDOWS} state=settled`,
					);
					return serialized;
				} catch (error) {
					if (controller.signal.aborted && error === controller.signal.reason) {
						console.info(
							`[adversary] team=${team} submission=${submissionId} observation=${index + 1}/${OBSERVATION_WINDOWS} state=pending`,
						);
						return null;
					}
					throw error;
				} finally {
					clearTimeout(timeout);
				}
			},
		);
		if (result !== null) return v.parse(schema, JSON.parse(result));
	}

	throw new Error(
		`The ${team} agent did not settle after ${OBSERVATION_WINDOWS} observation windows.`,
	);
}
