import * as v from 'valibot';
import { QueueCoordinator } from '../coordination/queue-coordinator.ts';
import {
	triageWorkflowParamsSchema,
	type TriageWorkflowParams,
} from './contracts.ts';

interface TriageCoordinatorEnv {
	TRIAGE_WORKFLOW: Workflow<TriageWorkflowParams>;
}

/**
 * Serializes triage runs per issue; keyed `repositoryId:issueNumber`.
 * Replaces the GitHub Actions `concurrency: group: triage-<issue>` behavior
 * (queue, don't cancel) and deduplicates webhook redeliveries.
 */
export class TriageCoordinator extends QueueCoordinator<
	TriageWorkflowParams,
	TriageCoordinatorEnv
> {
	protected parseParams(input: unknown): TriageWorkflowParams {
		return v.parse(triageWorkflowParamsSchema, input);
	}

	protected workflowBinding(): Workflow<TriageWorkflowParams> {
		return this.env.TRIAGE_WORKFLOW;
	}
}
