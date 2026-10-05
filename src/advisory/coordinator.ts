import * as v from 'valibot';
import { QueueCoordinator } from '../coordination/queue-coordinator.ts';
import {
	type AdvisoryWorkflowParams,
	advisoryWorkflowParamsSchema,
} from './contracts.ts';

interface AdvisoryCoordinatorEnv {
	ADVISORY_WORKFLOW: Workflow<AdvisoryWorkflowParams>;
}

/**
 * Serializes triage runs per advisory; keyed `repositoryId:ghsaId`.
 * `repository_advisory.reported` fires once per report, so in practice this
 * deduplicates webhook redeliveries.
 */
export class AdvisoryCoordinator extends QueueCoordinator<
	AdvisoryWorkflowParams,
	AdvisoryCoordinatorEnv
> {
	protected parseParams(input: unknown): AdvisoryWorkflowParams {
		return v.parse(advisoryWorkflowParamsSchema, input);
	}

	protected workflowBinding(): Workflow<AdvisoryWorkflowParams> {
		return this.env.ADVISORY_WORKFLOW;
	}
}
