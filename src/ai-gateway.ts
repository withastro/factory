import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
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

	// Pi's gateway catalog now ships the Kimi code model, but conservatively
	// marks supportsReasoningEffort: false even though the gateway's
	// OpenAI-compatible endpoint forwards the reasoning-effort option. Patch the
	// shipped entry; fall back to Workers AI metadata if the catalog ever trails
	// again.
	const withCodeModel = gatewayModels.some(
		(model) => model.id === CODE_MODEL_ID,
	)
		? gatewayModels.map((model) =>
				model.id === CODE_MODEL_ID
					? {
							...model,
							compat: {
								...model.compat,
								supportsReasoningEffort: true,
							},
						}
					: model,
			)
		: [
				...gatewayModels,
				createGatewayCodeModel(
					gateway.id,
					gatewayModels.find(
						(model) => model.id === 'workers-ai/@cf/moonshotai/kimi-k2.6',
					)?.baseUrl,
				),
			];

	// Pi's gateway catalog does not list Claude Opus 5.5 yet (models.dev lacks
	// it, and pi only backfills it for the direct Anthropic provider). Derive
	// it from pi's Anthropic entry until the gateway catalog catches up.
	const models = withCodeModel.some(
		(model) => model.id === GATEWAY_OPUS_5_5_MODEL_ID,
	)
		? withCodeModel
		: [...withCodeModel, createGatewayOpus55Model(withCodeModel)];

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

/** Gateway catalog ids for Claude use dotted versions. */
export const GATEWAY_OPUS_5_5_MODEL_ID = 'claude-opus-5.5';
const ANTHROPIC_OPUS_5_5_MODEL_ID = 'claude-opus-5-5';

function createGatewayOpus55Model(gatewayModels: Model<Api>[]): Model<Api> {
	// Reuse the gateway's native Anthropic endpoint and gateway-specific compat
	// flags from its newest listed Opus model.
	const gatewayClaude = gatewayModels.find(
		(model) => model.id === 'claude-opus-5',
	);
	if (!gatewayClaude) {
		throw new Error(
			'Cloudflare AI Gateway Claude Opus 5 metadata is unavailable.',
		);
	}

	const source = anthropicProvider()
		.getModels()
		.find((model) => model.id === ANTHROPIC_OPUS_5_5_MODEL_ID);
	if (!source) {
		throw new Error('Anthropic Claude Opus 5.5 metadata is unavailable.');
	}

	return {
		...source,
		id: GATEWAY_OPUS_5_5_MODEL_ID,
		provider: gatewayClaude.provider,
		baseUrl: gatewayClaude.baseUrl,
		compat: {
			...source.compat,
			...gatewayClaude.compat,
		},
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
