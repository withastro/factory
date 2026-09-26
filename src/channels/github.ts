import { createGitHubChannel } from '@flue/github';
import * as v from 'valibot';
import {
	adversaryCoordinatorKey,
	adversaryWorkflowParamsSchema,
} from '../adversary/contracts.ts';
import { matchesAdversaryTrigger } from '../adversary/setup.ts';
import {
	type AuthorWorkflowParams,
	authorCoordinatorKey,
	authorWorkflowParamsSchema,
} from '../author/contracts.ts';
import { checkOwnership } from '../author/ownership.ts';
import { loadFactoryConfig } from '../config.ts';
import type { AppHonoEnv } from '../env.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
	requiredProcessEnv,
} from '../github/client.ts';
import { resolvePersona } from '../personas/personas.ts';
import {
	RELEASE_SECURITY_TARGET,
	type ReleaseSecurityWorkflowParams,
	releaseSecurityCoordinatorKey,
	releaseSecurityWorkflowParamsSchema,
} from '../release-security/contracts.ts';
import {
	loadLiveReleaseSecurityTarget,
	releaseSecurityMode,
} from '../release-security/github.ts';
import {
	reviewCoordinatorKey,
	reviewWorkflowParamsSchema,
} from '../review/contracts.ts';
import { matchesReviewTrigger } from '../review/setup.ts';
import {
	type AuthorActivityIntent,
	type Dispatch,
	type PersonaAssignmentIntent,
	type ReleaseSecurityRerequestIntent,
	type ReviewIntentParams,
	routeDelivery,
} from '../router.ts';
import {
	type TriageWorkflowParams,
	triageCoordinatorKey,
} from '../triage/contracts.ts';

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
			case 'persona-assignment':
				return dispatchPersonaAssignment(c.env, dispatch.params, delivery);
			case 'author-activity':
				return dispatchAuthorActivity(c.env, dispatch.params, delivery);
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
			case 'release-security':
				return dispatchReleaseSecurity(c.env, dispatch.params, delivery);
			case 'release-security-rerequest':
				return dispatchReleaseSecurityRerequest(
					c.env,
					dispatch.params,
					delivery,
				);
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
		const adversaryParams = v.parse(adversaryWorkflowParamsSchema, {
			...intent,
			configurationSha: baseBranch.data.commit.sha,
		});
		if (await matchesAdversaryTrigger(client, adversaryParams)) {
			const coordinator = env.ADVERSARY_COORDINATOR.getByName(
				adversaryCoordinatorKey(adversaryParams),
			);
			const admission = await coordinator.enqueue(adversaryParams);
			logAdmitted(delivery, 'adversary', admission.disposition);
			return Response.json({
				accepted: true,
				capability: 'adversary',
				...admission,
			});
		}
		const reason = `Label "${params.label}" is not a configured pull request trigger.`;
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

/**
 * Resolve an assignment or review request against the repository's personas
 * and start the capability behind the persona. Assignments to anyone who
 * isn't a persona are the overwhelming majority, and are simply declined.
 */
async function dispatchPersonaAssignment(
	env: AppHonoEnv['Bindings'],
	intent: PersonaAssignmentIntent,
	delivery: DeliveryContext,
): Promise<Response> {
	const client = await createInstallationClient(
		credentialsFromWorkerEnv(env),
		intent.installationId,
	);
	const subject = intent.subject;
	// Pull request configuration is pinned to the target branch tip, like a
	// label-triggered review; issue configuration comes from the default
	// branch, like triage. Both are maintainer-controlled.
	const configurationSha =
		subject.type === 'pull_request'
			? (
					await client.rest.repos.getBranch({
						owner: intent.owner,
						repo: intent.repo,
						branch: subject.baseRef,
					})
				).data.commit.sha
			: undefined;
	const { config } = await loadFactoryConfig(
		client,
		intent.owner,
		intent.repo,
		configurationSha ?? intent.defaultBranch,
	);
	const persona = resolvePersona(config.personas, intent.login);
	const decline = (reason: string) => {
		logAdmitted(delivery, 'persona', 'rejected', reason);
		return Response.json({ accepted: false, reason });
	};
	if (!persona) return decline(`${intent.login} is not a persona.`);

	if (subject.type === 'issue') {
		if (persona !== 'triage' || intent.signal !== 'assigned') {
			return decline(`The ${persona} persona does not act on issues.`);
		}
		const params: TriageWorkflowParams = {
			deliveryId: intent.deliveryId,
			installationId: intent.installationId,
			repositoryId: intent.repositoryId,
			owner: intent.owner,
			repo: intent.repo,
			issueNumber: subject.issueNumber,
			defaultBranch: intent.defaultBranch,
			issueAction: 'assigned',
			assignee: intent.login,
			repoIsPrivate: intent.repoIsPrivate,
		};
		const coordinator = env.TRIAGE_COORDINATOR.getByName(
			triageCoordinatorKey(params),
		);
		const admission = await coordinator.enqueue(params);
		logAdmitted(delivery, 'triage', admission.disposition);
		return Response.json({
			accepted: true,
			capability: 'triage',
			persona,
			...admission,
		});
	}

	if (persona === 'reviewer') {
		const params = v.parse(reviewWorkflowParamsSchema, {
			deliveryId: intent.deliveryId,
			installationId: intent.installationId,
			repositoryId: intent.repositoryId,
			owner: intent.owner,
			repo: intent.repo,
			pullNumber: subject.pullNumber,
			persona: { login: intent.login, signal: intent.signal },
			baseSha: subject.baseSha,
			configurationSha,
			headSha: subject.headSha,
		});
		const coordinator = env.REVIEW_COORDINATOR.getByName(
			reviewCoordinatorKey(params),
		);
		const admission = await coordinator.enqueue(params);
		logAdmitted(delivery, 'review', admission.disposition);
		return Response.json({
			accepted: true,
			capability: 'review',
			persona,
			...admission,
		});
	}

	if (persona === 'author') {
		if (intent.signal !== 'assigned') {
			return decline('The author persona is assigned, not asked to review.');
		}
		return enqueueAuthor(
			env,
			{
				deliveryId: intent.deliveryId,
				installationId: intent.installationId,
				repositoryId: intent.repositoryId,
				owner: intent.owner,
				repo: intent.repo,
				pullNumber: subject.pullNumber,
				defaultBranch: intent.defaultBranch,
				repoIsPrivate: intent.repoIsPrivate,
				trigger: 'adopted',
			},
			delivery,
		);
	}

	return decline(`The ${persona} persona does not act on pull requests.`);
}

/**
 * Activity on a pull request the author persona may own. Ownership is checked
 * here against live state so ordinary pull request traffic never starts a
 * workflow; the workflow checks it again when it runs.
 */
async function dispatchAuthorActivity(
	env: AppHonoEnv['Bindings'],
	intent: AuthorActivityIntent,
	delivery: DeliveryContext,
): Promise<Response> {
	const client = await createInstallationClient(
		credentialsFromWorkerEnv(env),
		intent.installationId,
	);
	const { config } = await loadFactoryConfig(
		client,
		intent.owner,
		intent.repo,
		intent.defaultBranch,
	);
	const author = config.personas?.author;
	const decline = (reason: string) => {
		logAdmitted(delivery, 'author', 'rejected', reason);
		return Response.json({ accepted: false, reason });
	};
	if (!author) return decline('No author persona is configured.');

	const pull = await client.rest.pulls.get({
		owner: intent.owner,
		repo: intent.repo,
		pull_number: intent.pullNumber,
	});
	const ownership = checkOwnership(
		{
			state: pull.data.state,
			isCrossRepository:
				pull.data.head.repo?.full_name !== pull.data.base.repo.full_name,
			headRef: pull.data.head.ref,
			assignees: (pull.data.assignees ?? []).map((user) => user.login),
		},
		author.login,
	);
	if (ownership) return decline(ownership);

	return enqueueAuthor(
		env,
		{
			deliveryId: intent.deliveryId,
			installationId: intent.installationId,
			repositoryId: intent.repositoryId,
			owner: intent.owner,
			repo: intent.repo,
			pullNumber: intent.pullNumber,
			defaultBranch: intent.defaultBranch,
			repoIsPrivate: intent.repoIsPrivate,
			trigger: intent.activity,
			...(intent.actor ? { actor: intent.actor } : {}),
		},
		delivery,
	);
}

async function enqueueAuthor(
	env: AppHonoEnv['Bindings'],
	input: AuthorWorkflowParams,
	delivery: DeliveryContext,
): Promise<Response> {
	const params = v.parse(authorWorkflowParamsSchema, input);
	const coordinator = env.AUTHOR_COORDINATOR.getByName(
		authorCoordinatorKey(params),
	);
	const admission = await coordinator.enqueue(params);
	logAdmitted(delivery, 'author', admission.disposition);
	return Response.json({
		accepted: true,
		capability: 'author',
		persona: 'author',
		...admission,
	});
}

async function dispatchReleaseSecurity(
	env: AppHonoEnv['Bindings'],
	params: ReleaseSecurityWorkflowParams,
	delivery: DeliveryContext,
): Promise<Response> {
	const parsed = v.parse(releaseSecurityWorkflowParamsSchema, params);
	const coordinator = env.RELEASE_SECURITY_COORDINATOR.getByName(
		releaseSecurityCoordinatorKey(parsed),
	);
	const admission = await coordinator.enqueue(parsed);
	if (admission.disposition === 'rejected') {
		logAdmitted(delivery, 'release-security', 'rejected', admission.reason);
		return Response.json({ accepted: false, ...admission });
	}
	logAdmitted(delivery, 'release-security', admission.disposition);
	return Response.json({
		accepted: true,
		capability: 'release-security',
		...admission,
	});
}

async function dispatchReleaseSecurityRerequest(
	env: AppHonoEnv['Bindings'],
	intent: ReleaseSecurityRerequestIntent,
	delivery: DeliveryContext,
): Promise<Response> {
	if (intent.appId !== Number(env.GITHUB_APP_ID)) {
		const reason = 'Check Run belongs to a different GitHub App.';
		logAdmitted(delivery, 'release-security', 'rejected', reason);
		return Response.json({ accepted: false, reason });
	}
	const client = await createInstallationClient(
		credentialsFromWorkerEnv(env),
		intent.installationId,
	);
	const live = await loadLiveReleaseSecurityTarget(
		client,
		intent.owner,
		intent.repo,
		intent.pullNumber,
	);
	if (
		live.state !== 'open' ||
		`${live.owner}/${live.repo}` !== RELEASE_SECURITY_TARGET ||
		live.headRepository !== RELEASE_SECURITY_TARGET ||
		live.baseRepository !== RELEASE_SECURITY_TARGET ||
		live.headSha !== intent.headSha ||
		releaseSecurityMode(live) !== intent.mode
	) {
		const reason = 'Pull request no longer matches the rerequested check.';
		logAdmitted(delivery, 'release-security', 'rejected', reason);
		return Response.json({ accepted: false, reason });
	}
	return dispatchReleaseSecurity(
		env,
		v.parse(releaseSecurityWorkflowParamsSchema, {
			deliveryId: intent.deliveryId,
			installationId: intent.installationId,
			repositoryId: intent.repositoryId,
			owner: live.owner,
			repo: live.repo,
			pullNumber: live.pullNumber,
			pullUrl: live.pullUrl,
			pullTitle: live.pullTitle,
			pullBody: live.pullBody,
			headRef: live.headRef,
			headSha: live.headSha,
			baseRef: live.baseRef,
			baseSha: live.baseSha,
			mode: intent.mode,
			trigger: 'rerequest',
		}),
		delivery,
	);
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
		case 'persona-assignment':
			return {
				repo: `${dispatch.params.owner}/${dispatch.params.repo}`,
				login: dispatch.params.login,
				signal: dispatch.params.signal,
				...(dispatch.params.subject.type === 'issue'
					? { issueNumber: dispatch.params.subject.issueNumber }
					: { pullNumber: dispatch.params.subject.pullNumber }),
			};
		case 'author-activity':
			return {
				repo: `${dispatch.params.owner}/${dispatch.params.repo}`,
				pullNumber: dispatch.params.pullNumber,
				activity: dispatch.params.activity,
			};
		case 'triage':
			return {
				repo: `${dispatch.params.owner}/${dispatch.params.repo}`,
				issueNumber: dispatch.params.issueNumber,
				issueAction: dispatch.params.issueAction,
			};
		case 'release-security':
			return {
				repo: `${dispatch.params.owner}/${dispatch.params.repo}`,
				pullNumber: dispatch.params.pullNumber,
				mode: dispatch.params.mode,
			};
		case 'release-security-rerequest':
			return {
				repo: `${dispatch.params.owner}/${dispatch.params.repo}`,
				pullNumber: dispatch.params.pullNumber,
				mode: dispatch.params.mode,
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
	capability:
		| 'review'
		| 'triage'
		| 'release-security'
		| 'adversary'
		| 'author'
		| 'persona',
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
