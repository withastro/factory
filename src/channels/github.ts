import { createGitHubChannel } from '@flue/github';
import * as v from 'valibot';
import {
	reviewCoordinatorKey,
	reviewWorkflowParamsSchema,
} from '../contracts/review.ts';
import type { AppHonoEnv } from '../env.ts';
import {
	createInstallationClient,
	credentialsFromWorkerEnv,
	requiredProcessEnv,
} from '../github/client.ts';
import { matchesReviewTrigger } from '../github/repository.ts';

export const githubChannel = createGitHubChannel<AppHonoEnv>({
	webhookSecret: requiredProcessEnv('GITHUB_WEBHOOK_SECRET'),
	async webhook({ c, delivery }) {
		if (delivery.name !== 'pull_request' || delivery.payload.action !== 'labeled') return;

		const { installation, label, pull_request: pull, repository } = delivery.payload;
		if (repository.private) {
			return Response.json({ accepted: false, reason: 'Private repositories are not supported.' });
		}
		if (!installation) {
			throw new Error('A pull request delivery from a GitHub App must include an installation.');
		}
		const client = await createInstallationClient(
			credentialsFromWorkerEnv(c.env),
			installation.id,
		);
		const baseBranch = await client.rest.repos.getBranch({
			owner: repository.owner.login,
			repo: repository.name,
			branch: pull.base.ref,
		});

		const params = v.parse(reviewWorkflowParamsSchema, {
			deliveryId: delivery.deliveryId,
			installationId: installation.id,
			repositoryId: repository.id,
			owner: repository.owner.login,
			repo: repository.name,
			pullNumber: pull.number,
			label: label.name,
			baseSha: pull.base.sha,
			configurationSha: baseBranch.data.commit.sha,
			headSha: pull.head.sha,
		});
		if (!(await matchesReviewTrigger(client, params))) {
			return Response.json({
				accepted: false,
				reason: `Label "${params.label}" is not the configured Astro Review trigger.`,
			});
		}

		const coordinator = c.env.REVIEW_COORDINATOR.getByName(reviewCoordinatorKey(params));
		const admission = await coordinator.enqueue(params);
		return Response.json({ accepted: true, ...admission });
	},
});
