import { createGitHubChannel } from '@flue/github';
import * as v from 'valibot';
import { reviewWorkflowParamsSchema } from '../contracts/review.ts';
import type { AppHonoEnv } from '../env.ts';
import { requiredProcessEnv } from '../github/client.ts';

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

		const params = v.parse(reviewWorkflowParamsSchema, {
			deliveryId: delivery.deliveryId,
			installationId: installation.id,
			repositoryId: repository.id,
			owner: repository.owner.login,
			repo: repository.name,
			pullNumber: pull.number,
			label: label.name,
			baseSha: pull.base.sha,
			headSha: pull.head.sha,
		});

		const deduplicated = await startReviewWorkflow(
			c.env.REVIEW_WORKFLOW,
			delivery.deliveryId,
			params,
		);
		return Response.json({ accepted: true, deduplicated, workflowId: delivery.deliveryId });
	},
});

async function startReviewWorkflow(
	workflow: Workflow,
	id: string,
	params: v.InferOutput<typeof reviewWorkflowParamsSchema>,
): Promise<boolean> {
	try {
		await workflow.create({ id, params });
		return false;
	} catch (error) {
		const existing = await workflow.get(id);
		const status = await existing.status();
		if (status.status !== 'unknown') return true;
		throw error;
	}
}
