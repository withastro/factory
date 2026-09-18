import type { Provider } from '@earendil-works/pi-ai';
import { cloudflareAIGatewayProvider } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway';
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai';
import { CODE_MODEL_ID, WORKERS_AI_CODE_MODEL_ID } from './models.ts';

export const AI_GATEWAY_SECRETS = {
	token: 'FACTORY_AI_GATEWAY_TOKEN',
	accountId: 'FACTORY_AI_GATEWAY_ACCOUNT_ID',
	gatewayId: 'FACTORY_AI_GATEWAY_ID',
} as const;

/**
 * Factory has access to a gateway in a different Cloudflare account. Keep its
 * connection details in Factory-scoped Worker secrets: the generic
 * CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY names also control Wrangler and
 * could accidentally redirect or authenticate a deployment.
 */
export function createFactoryAIGatewayProvider(): Provider {
	const gateway = cloudflareAIGatewayProvider();
	const gatewayModels = gateway.getModels();

	// Pi's gateway catalog currently trails Workers AI by one model. Reuse the
	// Workers AI metadata and the gateway's /compat base URL until it catches up.
	const models = gatewayModels.some((model) => model.id === CODE_MODEL_ID)
		? gatewayModels
		: [
				...gatewayModels,
				createGatewayCodeModel(
					gateway.id,
					gatewayModels.find(
						(model) => model.id === 'workers-ai/@cf/moonshotai/kimi-k2.6',
					)?.baseUrl,
				),
			];

	return {
		...gateway,
		headers: {
			...gateway.headers,
			// Factory handles private repositories and security reports. Preserve
			// gateway usage analytics without retaining request or response bodies.
			'cf-aig-collect-log-payload': 'false',
		},
		auth: {
			apiKey: {
				name: 'Factory AI Gateway token',
				resolve: async ({ ctx }) => {
					const [token, accountId, gatewayId] = await Promise.all([
						ctx.env(AI_GATEWAY_SECRETS.token),
						ctx.env(AI_GATEWAY_SECRETS.accountId),
						ctx.env(AI_GATEWAY_SECRETS.gatewayId),
					]);
					if (!token || !accountId || !gatewayId) return undefined;

					return {
						auth: {
							headers: {
								'cf-aig-authorization': `Bearer ${token}`,
								Authorization: null,
								'x-api-key': null,
							},
						},
						env: {
							CLOUDFLARE_ACCOUNT_ID: accountId,
							CLOUDFLARE_GATEWAY_ID: gatewayId,
						},
						source: 'Factory AI Gateway Worker secrets',
					};
				},
			},
		},
		getModels: () => models,
	};
}

function createGatewayCodeModel(provider: string, baseUrl: string | undefined) {
	if (!baseUrl) {
		throw new Error(
			'Cloudflare AI Gateway Workers AI base URL is unavailable.',
		);
	}

	const source = cloudflareWorkersAIProvider()
		.getModels()
		.find((model) => model.id === WORKERS_AI_CODE_MODEL_ID);
	if (!source) {
		throw new Error('Workers AI Kimi K2.7 Code metadata is unavailable.');
	}

	return {
		...source,
		id: CODE_MODEL_ID,
		provider,
		baseUrl,
		compat: {
			...source.compat,
			// The gateway's OpenAI-compatible endpoint forwards this Workers AI
			// option even though Pi conservatively disables it for unknown models.
			supportsReasoningEffort: true,
		},
	};
}
