import * as v from 'valibot';
import { QueueCoordinator } from '../coordination/queue-coordinator.ts';
import {
	type AuthorWorkflowParams,
	authorWorkflowParamsSchema,
} from './contracts.ts';

interface AuthorCoordinatorEnv {
	AUTHOR_WORKFLOW: Workflow<AuthorWorkflowParams>;
}

/**
 * Serializes code author rounds per pull request; keyed
 * `repositoryId:pullNumber`. Feedback that arrives while a round runs
 * collapses into the single pending slot, and because the workflow re-reads
 * all feedback when it starts, the next round sees every comment that queued
 * up rather than only the newest delivery.
 */
export class AuthorCoordinator extends QueueCoordinator<
	AuthorWorkflowParams,
	AuthorCoordinatorEnv
> {
	protected parseParams(input: unknown): AuthorWorkflowParams {
		return v.parse(authorWorkflowParamsSchema, input);
	}

	protected workflowBinding(): Workflow<AuthorWorkflowParams> {
		return this.env.AUTHOR_WORKFLOW;
	}
}
