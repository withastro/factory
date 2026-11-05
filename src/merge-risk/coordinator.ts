import * as v from 'valibot';
import { QueueCoordinator } from '../coordination/queue-coordinator.ts';
import {
	type MergeRiskWorkflowParams,
	mergeRiskWorkflowParamsSchema,
} from './contracts.ts';

interface MergeRiskCoordinatorEnv {
	MERGE_RISK_WORKFLOW: Workflow<MergeRiskWorkflowParams>;
}

/** Serializes assessments per pull request; keyed `repositoryId:pullNumber`. */
export class MergeRiskCoordinator extends QueueCoordinator<
	MergeRiskWorkflowParams,
	MergeRiskCoordinatorEnv
> {
	protected parseParams(input: unknown): MergeRiskWorkflowParams {
		return v.parse(mergeRiskWorkflowParamsSchema, input);
	}

	protected workflowBinding(): Workflow<MergeRiskWorkflowParams> {
		return this.env.MERGE_RISK_WORKFLOW;
	}
}
