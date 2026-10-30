import type { Sandbox } from '@cloudflare/sandbox';
import type { AdversaryWorkflowParams } from './adversary/contracts.ts';
import type { AdversaryCoordinator } from './adversary/coordinator.ts';
import type { AdvisoryWorkflowParams } from './advisory/contracts.ts';
import type { AdvisoryCoordinator } from './advisory/coordinator.ts';
import type { AuthorWorkflowParams } from './author/contracts.ts';
import type { AuthorCoordinator } from './author/coordinator.ts';
import type { PrSafetyWorkflowParams } from './pr-safety/contracts.ts';
import type { PrSafetyCoordinator } from './pr-safety/coordinator.ts';
import type { ReleaseSecurityWorkflowParams } from './release-security/contracts.ts';
import type { ReleaseSecurityCoordinator } from './release-security/coordinator.ts';
import type { ReviewWorkflowParams } from './review/contracts.ts';
import type { ReviewCoordinator } from './review/coordinator.ts';
import type { TriageWorkflowParams } from './triage/contracts.ts';
import type { TriageCoordinator } from './triage/coordinator.ts';

export interface WorkerEnv
	extends Omit<
		Env,
		'TRIAGE_SANDBOX' | 'ADVERSARY_SANDBOX' | 'PR_SAFETY_SANDBOX'
	> {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	/** Bot token for Factory's Discord application. */
	DISCORD_BOT_TOKEN?: string;
	ADVISORY_COORDINATOR: DurableObjectNamespace<AdvisoryCoordinator>;
	ADVISORY_WORKFLOW: Workflow<AdvisoryWorkflowParams>;
	ADVERSARY_COORDINATOR: DurableObjectNamespace<AdversaryCoordinator>;
	ADVERSARY_SANDBOX: DurableObjectNamespace<Sandbox>;
	ADVERSARY_WORKFLOW: Workflow<AdversaryWorkflowParams>;
	ADVERSARY_ARTIFACTS: R2Bucket;
	AUTHOR_COORDINATOR: DurableObjectNamespace<AuthorCoordinator>;
	AUTHOR_WORKFLOW: Workflow<AuthorWorkflowParams>;
	PR_SAFETY_COORDINATOR: DurableObjectNamespace<PrSafetyCoordinator>;
	PR_SAFETY_SANDBOX: DurableObjectNamespace<Sandbox>;
	PR_SAFETY_WORKFLOW: Workflow<PrSafetyWorkflowParams>;
	REVIEW_COORDINATOR: DurableObjectNamespace<ReviewCoordinator>;
	TRIAGE_COORDINATOR: DurableObjectNamespace<TriageCoordinator>;
	TRIAGE_SANDBOX: DurableObjectNamespace<Sandbox>;
	RELEASE_SECURITY_COORDINATOR: DurableObjectNamespace<ReleaseSecurityCoordinator>;
	RELEASE_SECURITY_SANDBOX: DurableObjectNamespace<Sandbox>;
	RELEASE_SECURITY_WORKFLOW: Workflow<ReleaseSecurityWorkflowParams>;
	PRIVATE_REPORTS: R2Bucket;
	LOADER: WorkerLoader;
	REVIEW_WORKFLOW: Workflow<ReviewWorkflowParams>;
	TRIAGE_WORKFLOW: Workflow<TriageWorkflowParams>;
}

export interface AppHonoEnv {
	Bindings: WorkerEnv;
}
