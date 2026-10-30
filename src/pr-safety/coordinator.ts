import * as v from 'valibot';
import { QueueCoordinator } from '../coordination/queue-coordinator.ts';
import {
	type PrSafetyWorkflowParams,
	prSafetyWorkflowParamsSchema,
} from './contracts.ts';

interface PrSafetyCoordinatorEnv {
	PR_SAFETY_WORKFLOW: Workflow<PrSafetyWorkflowParams>;
}

/**
 * Serializes PR safety reviews per pull request; keyed
 * `repositoryId:pullNumber`. Pushes that arrive during a review collapse
 * into one pending review of the newest head.
 */
export class PrSafetyCoordinator extends QueueCoordinator<
	PrSafetyWorkflowParams,
	PrSafetyCoordinatorEnv
> {
	protected parseParams(input: unknown): PrSafetyWorkflowParams {
		return v.parse(prSafetyWorkflowParamsSchema, input);
	}

	protected workflowBinding(): Workflow<PrSafetyWorkflowParams> {
		return this.env.PR_SAFETY_WORKFLOW;
	}
}
