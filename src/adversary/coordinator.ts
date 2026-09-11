import * as v from 'valibot';
import { QueueCoordinator } from '../coordination/queue-coordinator.ts';
import {
	type AdversaryWorkflowParams,
	adversaryWorkflowParamsSchema,
} from './contracts.ts';

interface AdversaryCoordinatorEnv {
	ADVERSARY_WORKFLOW: Workflow<AdversaryWorkflowParams>;
}

export class AdversaryCoordinator extends QueueCoordinator<
	AdversaryWorkflowParams,
	AdversaryCoordinatorEnv
> {
	protected parseParams(input: unknown): AdversaryWorkflowParams {
		return v.parse(adversaryWorkflowParamsSchema, input);
	}

	protected workflowBinding(): Workflow<AdversaryWorkflowParams> {
		return this.env.ADVERSARY_WORKFLOW;
	}
}
