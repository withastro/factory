/**
 * Model selection for every factory agent.
 *
 * A model specifier is `<provider>/<model>`, resolved against the providers
 * bundled by `flue.config.ts`. Factory exposes only `cloudflare-ai-gateway/…`:
 * Workers AI, Anthropic, and other upstream models all run through the shared
 * gateway, whose credentials remain in Factory-scoped Worker secrets. Legacy
 * direct-provider names are normalized to gateway model ids during parsing.
 *
 * The constants below are the defaults. A repository can override any of them
 * in `.github/factory.yml` (`adversary.blueTeam.model`,
 * `adversary.purpleTeam.model`, `review.model`, `triage.model`, and
 * `triage.verificationModel`).
 */

/**
 * Providers available at runtime. This must stay in sync with the `providers`
 * array in `flue.config.ts`; legacy config aliases are listed separately and
 * normalized before a model call.
 */
export const AI_GATEWAY_PROVIDER = 'cloudflare-ai-gateway';
export const MODEL_PROVIDERS = [AI_GATEWAY_PROVIDER] as const;

/** Existing repository configs accepted as syntax aliases during migration. */
export const LEGACY_MODEL_PROVIDERS = ['anthropic', 'cloudflare'] as const;
export const MODEL_SPECIFIER_PROVIDERS = [
	...MODEL_PROVIDERS,
	...LEGACY_MODEL_PROVIDERS,
] as const;

export const WORKERS_AI_CODE_MODEL_ID = '@cf/moonshotai/kimi-k2.7-code';
export const CODE_MODEL_ID = `workers-ai/${WORKERS_AI_CODE_MODEL_ID}`;
export const VERIFICATION_MODEL_ID = 'workers-ai/@cf/moonshotai/kimi-k2.6';

/** Reviews and the triage pipeline: the strongest coding model. */
export const CODE_MODEL = `${AI_GATEWAY_PROVIDER}/${CODE_MODEL_ID}`;

/** Lightweight classification calls (fix verification, retriage decisions). */
export const VERIFICATION_MODEL = `${AI_GATEWAY_PROVIDER}/${VERIFICATION_MODEL_ID}`;

/**
 * The provider segment of a specifier, or `undefined` when it is malformed.
 *
 * Only the first segment is the provider: gateway model ids can carry their
 * own routing and vendor segments (`workers-ai/@cf/…`), so the remainder is
 * passed through untouched.
 */
export function modelProvider(specifier: string): string | undefined {
	const separator = specifier.indexOf('/');
	if (separator <= 0 || separator === specifier.length - 1) return undefined;
	return specifier.slice(0, separator);
}

/** Whether a specifier names the gateway or a supported legacy alias. */
export function isSupportedModel(specifier: string): boolean {
	const provider = modelProvider(specifier);
	return (
		provider !== undefined &&
		(MODEL_SPECIFIER_PROVIDERS as readonly string[]).includes(provider)
	);
}

/**
 * Convert direct-provider syntax from existing repository configs into the
 * equivalent gateway model id. The direct providers are never registered.
 */
export function normalizeModelSpecifier(specifier: string): string {
	const separator = specifier.indexOf('/');
	const provider = specifier.slice(0, separator);
	const model = specifier.slice(separator + 1);

	if (provider === 'anthropic') {
		return `${AI_GATEWAY_PROVIDER}/${model}`;
	}
	if (provider === 'cloudflare') {
		return `${AI_GATEWAY_PROVIDER}/workers-ai/${model}`;
	}
	return specifier;
}
