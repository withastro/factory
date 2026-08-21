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
	type Dispatch,
	type ReviewIntentParams,
	routeDelivery,
} from '../router.ts';
import { triageCoordinatorKey } from '../triage/contracts.ts';

export const githubChannel = createGitHubChannel<AppHonoEnv>({
	webhookSecret: requiredProcessEnv('GITHUB_WEBHOOK_SECRET'),
	async webhook({ c, delivery }) {
		const dispatch = routeDelivery(
			delivery.name,
			delivery.payload as Parameters<typeof routeDelivery>[1],
			delivery.deliveryId,
		);
		logRouted(delivery, dispatch);

		switch (dispatch.kind) {
			case 'none':
				return Response.json({ accepted: false, reason: dispatch.reason });
			case 'review':
				return dispatchReview(c.env, dispatch.params, delivery);
			case 'triage': {
				const coordinator = c.env.TRIAGE_COORDINATOR.getByName(
					triageCoordinatorKey(dispatch.params),
				);
				const admission = await coordinator.enqueue(dispatch.params);
				logAdmitted(delivery, 'triage', admission.disposition);
				return Response.json({
					accepted: true,
					capability: 'triage',
					...admission,
				});
			}
		}
	},
});

async function dispatchReview(
	env: AppHonoEnv['Bindings'],
	intent: ReviewIntentParams,
	delivery: DeliveryContext,
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
		const reason = `Label "${params.label}" is not the configured review trigger.`;
		logAdmitted(delivery, 'review', 'rejected', reason);
		return Response.json({ accepted: false, reason });
	}

	const coordinator = env.REVIEW_COORDINATOR.getByName(
		reviewCoordinatorKey(params),
	);
	const admission = await coordinator.enqueue(params);
	logAdmitted(delivery, 'review', admission.disposition);
	return Response.json({ accepted: true, capability: 'review', ...admission });
}

/** The fields of a delivery that identify it in a log line. */
interface DeliveryContext {
	name: string;
	deliveryId: string;
	payload: unknown;
}

/**
 * Record the router's verdict for every delivery.
 *
 * A webhook that arrives and produces no work is, in the Workers logs,
 * indistinguishable from one GitHub never sent: request metadata is captured
 * but response bodies are not, and `reason` lived only in the response. That
 * turns "why didn't this trigger?" into an exercise in inferring dispatch from
 * wall-clock time. One line at the door makes the decision self-evident.
 */
function logRouted(delivery: DeliveryContext, dispatch: Dispatch): void {
	console.log(
		JSON.stringify({
			event: 'webhook_routed',
			deliveryId: delivery.deliveryId,
			webhookEvent: delivery.name,
			action: (delivery.payload as { action?: string } | null)?.action ?? null,
			kind: dispatch.kind,
			...routedTarget(dispatch),
		}),
	);
}

function routedTarget(dispatch: Dispatch): Record<string, unknown> {
	switch (dispatch.kind) {
		case 'none':
			return { reason: dispatch.reason };
		case 'review':
			return {
				repo: `${dispatch.params.owner}/${dispatch.params.repo}`,
				pullNumber: dispatch.params.pullNumber,
				label: dispatch.params.label,
			};
		case 'triage':
			return {
				repo: `${dispatch.params.owner}/${dispatch.params.repo}`,
				issueNumber: dispatch.params.issueNumber,
				issueAction: dispatch.params.issueAction,
			};
	}
}

/**
 * Record what the capability did with a delivery the router accepted. The
 * coordinator can still deduplicate it, queue it behind a running workflow, or
 * — for a review — reject it as the wrong label, none of which are visible
 * from the routing decision alone.
 */
function logAdmitted(
	delivery: DeliveryContext,
	capability: 'review' | 'triage',
	disposition: string,
	reason?: string,
): void {
	console.log(
		JSON.stringify({
			event: 'webhook_admitted',
			deliveryId: delivery.deliveryId,
			webhookEvent: delivery.name,
			capability,
			disposition,
			...(reason ? { reason } : {}),
		}),
	);
}
