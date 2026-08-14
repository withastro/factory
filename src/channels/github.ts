import { createGitHubChannel } from '@flue/github';
import * as v from 'valibot';
import type { AppHonoEnv } from '../env.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
	requiredProcessEnv,
} from '../github/client.ts';
import {
	reviewCoordinatorKey,
	reviewWorkflowParamsSchema,
} from '../review/contracts.ts';
import { matchesReviewTrigger } from '../review/setup.ts';
import {
	routeDelivery,
	type ReviewIntentParams,
	type SetupIntentParams,
} from '../router.ts';
import { triageCoordinatorKey } from '../triage/contracts.ts';
import { ensureRepositoryLabels } from '../triage/install.ts';

export const githubChannel = createGitHubChannel<AppHonoEnv>({
	webhookSecret: requiredProcessEnv('GITHUB_WEBHOOK_SECRET'),
	async webhook({ c, delivery }) {
		const dispatch = routeDelivery(
			delivery.name,
			delivery.payload as Parameters<typeof routeDelivery>[1],
			delivery.deliveryId,
		);

		switch (dispatch.kind) {
			case 'none':
				return Response.json({ accepted: false, reason: dispatch.reason });
			case 'review':
				return dispatchReview(c.env, dispatch.params);
			case 'triage': {
				const coordinator = c.env.TRIAGE_COORDINATOR.getByName(
					triageCoordinatorKey(dispatch.params),
				);
				const admission = await coordinator.enqueue(dispatch.params);
				return Response.json({ accepted: true, capability: 'triage', ...admission });
			}
			case 'setup': {
				// Label creation is best-effort and can outlive the webhook
				// response; a failed repo just gets its labels lazily later.
				c.executionCtx.waitUntil(setupRepositories(c.env, dispatch.params));
				return Response.json({
					accepted: true,
					capability: 'setup',
					repositories: dispatch.params.repositories.length,
				});
			}
		}
	},
});

async function setupRepositories(
	env: AppHonoEnv['Bindings'],
	params: SetupIntentParams,
): Promise<void> {
	const client = await createInstallationClient(
		credentialsFromWorkerEnv(env),
		params.installationId,
	);
	for (const target of params.repositories) {
		try {
			await ensureRepositoryLabels(client, target.owner, target.repo);
		} catch (error) {
			console.error(`Label setup failed for ${target.owner}/${target.repo}:`, error);
		}
	}
}

async function dispatchReview(
	env: AppHonoEnv['Bindings'],
	intent: ReviewIntentParams,
): Promise<Response> {
	const client = await createInstallationClient(
		credentialsFromWorkerEnv(env),
		intent.installationId,
	);

	// Pin configuration reads to the target branch's tip at webhook time so
	// the whole review uses one immutable, maintainer-controlled snapshot.
	const baseBranch = await client.rest.repos.getBranch({
		owner: intent.owner,
		repo: intent.repo,
		branch: intent.baseRef,
	});

	const params = v.parse(reviewWorkflowParamsSchema, {
		deliveryId: intent.deliveryId,
		installationId: intent.installationId,
		repositoryId: intent.repositoryId,
		owner: intent.owner,
		repo: intent.repo,
		pullNumber: intent.pullNumber,
		label: intent.label,
		baseSha: intent.baseSha,
		configurationSha: baseBranch.data.commit.sha,
		headSha: intent.headSha,
	});
	if (!(await matchesReviewTrigger(client, params))) {
		return Response.json({
			accepted: false,
			reason: `Label "${params.label}" is not the configured review trigger.`,
		});
	}

	const coordinator = env.REVIEW_COORDINATOR.getByName(reviewCoordinatorKey(params));
	const admission = await coordinator.enqueue(params);
	return Response.json({ accepted: true, capability: 'review', ...admission });
}
