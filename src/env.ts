import type { ReviewWorkflowParams } from './contracts/review.ts';
import type { ReviewCoordinator } from './review-coordinator.ts';

export interface WorkerEnv extends Env {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	REVIEW_COORDINATOR: DurableObjectNamespace<ReviewCoordinator>;
	REVIEW_WORKFLOW: Workflow<ReviewWorkflowParams>;
}

export interface AppHonoEnv {
	Bindings: WorkerEnv;
}
