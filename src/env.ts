import type { ReviewWorkflowParams } from './review/contracts.ts';
import type { ReviewCoordinator } from './review/coordinator.ts';
import type { TriageWorkflowParams } from './triage/contracts.ts';
import type { TriageCoordinator } from './triage/coordinator.ts';

export interface WorkerEnv extends Env {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	REVIEW_COORDINATOR: DurableObjectNamespace<ReviewCoordinator>;
	TRIAGE_COORDINATOR: DurableObjectNamespace<TriageCoordinator>;
	REVIEW_WORKFLOW: Workflow<ReviewWorkflowParams>;
	TRIAGE_WORKFLOW: Workflow<TriageWorkflowParams>;
}

export interface AppHonoEnv {
	Bindings: WorkerEnv;
}
