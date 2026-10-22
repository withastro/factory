/**
 * Worker-level exports. Named exports here become Worker exports, which is
 * how wrangler binds the Durable Object and Workflow classes.
 */

export { Sandbox } from '@cloudflare/sandbox';
export { AdversaryCoordinator } from './adversary/coordinator.ts';
export { AdversaryWorkflow } from './adversary/workflow.ts';
export { AdvisoryCoordinator } from './advisory/coordinator.ts';
export { AdvisoryWorkflow } from './advisory/workflow.ts';
export { AuthorCoordinator } from './author/coordinator.ts';
export { AuthorWorkflow } from './author/workflow.ts';
export { DiscordGateway } from './discord/gateway.ts';
export { DiscordThreadCoordinator } from './discord/thread-coordinator.ts';
export { DiscordThreadWorkflow } from './discord/workflow.ts';
export { ReleaseSecurityCoordinator } from './release-security/coordinator.ts';
export { ReleaseSecurityWorkflow } from './release-security/workflow.ts';
export { ReviewCoordinator } from './review/coordinator.ts';
export { ReviewWorkflow } from './review/workflow.ts';
export { TriageCoordinator } from './triage/coordinator.ts';
export { TriageWorkflow } from './triage/workflow.ts';

/**
 * Worker-level handlers. The cron trigger keeps the Discord Gateway
 * connection up: it wakes the gateway Durable Object every minute, which
 * reconnects if a deploy or an eviction dropped the socket.
 */
export default {
	async scheduled(
		_controller: ScheduledController,
		env: import('./env.ts').WorkerEnv,
	): Promise<void> {
		await env.DISCORD_GATEWAY.getByName('default').ensureConnected();
	},
};
