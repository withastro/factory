import { describe, expect, it, vi } from 'vitest';
import {
	AI_GATEWAY_SECRETS,
	createFactoryAIGatewayProvider,
	GATEWAY_OPUS_5_5_MODEL_ID,
} from '../src/ai-gateway.ts';
import {
	AI_GATEWAY_PROVIDER,
	CODE_MODEL_ID,
	normalizeModelSpecifier,
	VERIFICATION_MODEL_ID,
} from '../src/models.ts';

const secretValues: Record<string, string> = {
	[AI_GATEWAY_SECRETS.token]: 'gateway-token',
	[AI_GATEWAY_SECRETS.accountId]: 'gateway-account',
	[AI_GATEWAY_SECRETS.gatewayId]: 'gateway-id',
};

describe('Factory AI Gateway provider', () => {
	it('exposes Workers AI and Anthropic only through the gateway provider', () => {
		const provider = createFactoryAIGatewayProvider();
		const models = provider.getModels();

		expect(provider.id).toBe(AI_GATEWAY_PROVIDER);
		expect(
			models.every((model) => model.provider === AI_GATEWAY_PROVIDER),
		).toBe(true);
		expect(models.some((model) => model.id === CODE_MODEL_ID)).toBe(true);
		expect(models.some((model) => model.id === VERIFICATION_MODEL_ID)).toBe(
			true,
		);
		expect(models.some((model) => model.id === 'claude-opus-4.6')).toBe(true);
		expect(models.some((model) => model.id === 'claude-haiku-4.5')).toBe(true);
	});

	it('adds current Kimi metadata to the gateway compatibility endpoint', () => {
		const model = createFactoryAIGatewayProvider()
			.getModels()
			.find((candidate) => candidate.id === CODE_MODEL_ID);

		expect(model).toMatchObject({
			provider: AI_GATEWAY_PROVIDER,
			api: 'openai-completions',
			baseUrl:
				'https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat',
			compat: {
				supportsReasoningEffort: true,
				sendSessionAffinityHeaders: true,
			},
		});
	});

	it('uses the native Anthropic gateway endpoint for Claude', () => {
		const model = createFactoryAIGatewayProvider()
			.getModels()
			.find((candidate) => candidate.id === 'claude-opus-4.6');

		expect(model).toMatchObject({
			provider: AI_GATEWAY_PROVIDER,
			api: 'anthropic-messages',
			baseUrl:
				'https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic',
		});
	});

	it('adds Claude Opus 5.5 on the native Anthropic gateway endpoint', () => {
		const models = createFactoryAIGatewayProvider().getModels();
		const model = models.find(
			(candidate) => candidate.id === GATEWAY_OPUS_5_5_MODEL_ID,
		);

		expect(
			models.filter((candidate) => candidate.id === GATEWAY_OPUS_5_5_MODEL_ID),
		).toHaveLength(1);
		expect(model).toMatchObject({
			name: 'Claude Opus 5.5',
			provider: AI_GATEWAY_PROVIDER,
			api: 'anthropic-messages',
			baseUrl:
				'https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic',
			reasoning: true,
			compat: { sendSessionAffinityHeaders: true },
		});
	});

	it('maps Factory-scoped secrets into gateway auth without exposing them', async () => {
		const provider = createFactoryAIGatewayProvider();
		const resolve = provider.auth.apiKey?.resolve;
		expect(resolve).toBeDefined();
		if (!resolve) return;

		const env = vi.fn(async (name: string) => secretValues[name]);
		const result = await resolve({
			ctx: { env, fileExists: async () => false },
			signal: new AbortController().signal,
		});

		expect(env.mock.calls.map(([name]) => name)).toEqual([
			AI_GATEWAY_SECRETS.token,
			AI_GATEWAY_SECRETS.accountId,
			AI_GATEWAY_SECRETS.gatewayId,
		]);
		expect(result).toEqual({
			auth: {
				headers: {
					'cf-aig-authorization': 'Bearer gateway-token',
					Authorization: null,
					'x-api-key': null,
				},
			},
			env: {
				CLOUDFLARE_ACCOUNT_ID: 'gateway-account',
				CLOUDFLARE_GATEWAY_ID: 'gateway-id',
			},
			source: 'Factory AI Gateway Worker secrets',
		});
	});

	it('is unavailable unless all three secrets are present', async () => {
		const resolve = createFactoryAIGatewayProvider().auth.apiKey?.resolve;
		expect(resolve).toBeDefined();
		if (!resolve) return;

		const result = await resolve({
			ctx: {
				env: async (name) =>
					name === AI_GATEWAY_SECRETS.gatewayId
						? undefined
						: secretValues[name],
				fileExists: async () => false,
			},
			signal: new AbortController().signal,
		});

		expect(result).toBeUndefined();
	});

	it('disables gateway payload retention', () => {
		expect(createFactoryAIGatewayProvider().headers).toMatchObject({
			'cf-aig-collect-log-payload': 'false',
		});
	});
});

describe('Factory AI Gateway model resolution', () => {
	it.each([
		['anthropic/claude-opus-5-5', GATEWAY_OPUS_5_5_MODEL_ID],
		['anthropic/claude-sonnet-4-6', 'claude-sonnet-4-6'],
		['cloudflare-ai-gateway/claude-opus-4-6', 'claude-opus-4-6'],
		['cloudflare-ai-gateway/claude-opus-4.6', 'claude-opus-4-6'],
	])('resolves legacy config value %s', async (specifier, expectedId) => {
		const { resetModelsForTests, resolveModel, setProvider } = await import(
			'@flue/runtime/internal'
		);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		resetModelsForTests();
		setProvider(createFactoryAIGatewayProvider());
		try {
			const model = resolveModel(normalizeModelSpecifier(specifier));
			expect(model.provider).toBe(AI_GATEWAY_PROVIDER);
			expect(model.id).toBe(expectedId);
		} finally {
			resetModelsForTests();
			vi.restoreAllMocks();
		}
	});

	it('resolves every native Anthropic endpoint model to a dashed id', async () => {
		const { resetModelsForTests, resolveModel, setProvider } = await import(
			'@flue/runtime/internal'
		);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const provider = createFactoryAIGatewayProvider();
		const anthropic = provider
			.getModels()
			.filter((model) => model.baseUrl.endsWith('/anthropic'));
		resetModelsForTests();
		setProvider(provider);
		try {
			expect(anthropic.length).toBeGreaterThan(0);
			const dotted = anthropic
				.map((model) => resolveModel(`${AI_GATEWAY_PROVIDER}/${model.id}`).id)
				.filter((id) => /\d\.\d/.test(id));
			expect(dotted).toEqual([]);
		} finally {
			resetModelsForTests();
			vi.restoreAllMocks();
		}
	});
});
