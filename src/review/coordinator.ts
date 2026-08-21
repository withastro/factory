import * as v from 'valibot';
import { QueueCoordinator } from '../coordination/queue-coordinator.ts';
import {
	type ReviewWorkflowParams,
	reviewWorkflowParamsSchema,
} from './contracts.ts';

interface ReviewCoordinatorEnv {
	REVIEW_WORKFLOW: Workflow<ReviewWorkflowParams>;
}

/** Serializes reviews per pull request; keyed `repositoryId:pullNumber`. */
export class ReviewCoordinator extends QueueCoordinator<
	ReviewWorkflowParams,
	ReviewCoordinatorEnv
> {
	protected parseParams(input: unknown): ReviewWorkflowParams {
		return v.parse(reviewWorkflowParamsSchema, input);
	}

	protected workflowBinding(): Workflow<ReviewWorkflowParams> {
		return this.env.REVIEW_WORKFLOW;
	}
}
