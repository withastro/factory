import type { Sandbox } from '@cloudflare/sandbox';
import type { AdversaryWorkflowParams } from './adversary/contracts.ts';
import type { AdversaryCoordinator } from './adversary/coordinator.ts';
import type { AdvisoryWorkflowParams } from './advisory/contracts.ts';
import type { AdvisoryCoordinator } from './advisory/coordinator.ts';
import type { AuthorWorkflowParams } from './author/contracts.ts';
import type { AuthorCoordinator } from './author/coordinator.ts';
import type { DiscordThreadWorkflowParams } from './discord/contracts.ts';
import type { DiscordGateway } from './discord/gateway.ts';
import type { DiscordThreadCoordinator } from './discord/thread-coordinator.ts';
import type { ReleaseSecurityWorkflowParams } from './release-security/contracts.ts';
import type { ReleaseSecurityCoordinator } from './release-security/coordinator.ts';
import type { ReviewWorkflowParams } from './review/contracts.ts';
import type { ReviewCoordinator } from './review/coordinator.ts';
import type { TriageWorkflowParams } from './triage/contracts.ts';
import type { TriageCoordinator } from './triage/coordinator.ts';

export interface WorkerEnv
	extends Omit<
		Env,
		| 'TRIAGE_SANDBOX'
		| 'ADVERSARY_SANDBOX'
		| 'DISCORD_GUILD_ID'
		| 'DISCORD_ALLOWED_ROLE_IDS'
		| 'DISCORD_ASSISTANT_CHANNEL_IDS'
		| 'DISCORD_REPOSITORY'
	> {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	/** Bot token for Factory's Discord application. */
	DISCORD_BOT_TOKEN?: string;
	/** The Discord server the assistant answers in. */
	DISCORD_GUILD_ID?: string;
	/** Comma-separated role ids allowed to use the assistant. */
	DISCORD_ALLOWED_ROLE_IDS?: string;
	/** Optional comma-separated channel ids the assistant answers in. */
	DISCORD_ASSISTANT_CHANNEL_IDS?: string;
	/** `owner/repo` the assistant works on. */
	DISCORD_REPOSITORY?: string;
	DISCORD_GATEWAY: DurableObjectNamespace<DiscordGateway>;
	DISCORD_THREAD_COORDINATOR: DurableObjectNamespace<DiscordThreadCoordinator>;
	DISCORD_THREAD_WORKFLOW: Workflow<DiscordThreadWorkflowParams>;
	ADVISORY_COORDINATOR: DurableObjectNamespace<AdvisoryCoordinator>;
	ADVISORY_WORKFLOW: Workflow<AdvisoryWorkflowParams>;
	ADVERSARY_COORDINATOR: DurableObjectNamespace<AdversaryCoordinator>;
	ADVERSARY_SANDBOX: DurableObjectNamespace<Sandbox>;
	ADVERSARY_WORKFLOW: Workflow<AdversaryWorkflowParams>;
	ADVERSARY_ARTIFACTS: R2Bucket;
	AUTHOR_COORDINATOR: DurableObjectNamespace<AuthorCoordinator>;
	AUTHOR_WORKFLOW: Workflow<AuthorWorkflowParams>;
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
