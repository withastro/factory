/**
 * Model selection for every factory agent.
 *
 * A model specifier is `<provider>/<model>`, resolved against the providers
 * bundled by `flue.config.ts`:
 *
 * - `cloudflare/…` runs on Workers AI through the Worker's `AI` binding and
 *   needs no credentials.
 * - `anthropic/…` calls the Anthropic API directly and needs the
 *   `ANTHROPIC_API_KEY` secret. Agents never see the key; the Flue runtime
 *   resolves it from the environment.
 *
 * The constants below are the defaults. A repository can override any of them
 * in `.github/factory.yml` (`review.model`, `triage.model`,
 * `triage.verificationModel`).
 */

/**
 * Providers a repository is allowed to name. This must stay in sync with the
 * `providers` array in `flue.config.ts` — naming a provider that was not
 * bundled fails at the first model call, deep inside an agent, so
 * configuration is validated against this list up front instead.
 */
export const MODEL_PROVIDERS = ['anthropic', 'cloudflare'] as const;

/** Reviews and the triage pipeline: the strongest coding model. */
export const CODE_MODEL = 'cloudflare/@cf/moonshotai/kimi-k2.7-code';

/** Lightweight classification calls (fix verification, retriage decisions). */
export const VERIFICATION_MODEL = 'cloudflare/@cf/moonshotai/kimi-k2.6';

/**
 * The provider segment of a specifier, or `undefined` when it is malformed.
 *
 * Only the first segment is the provider: Workers AI model ids carry their own
 * slashes (`@cf/moonshotai/kimi-k2.6`), so the remainder is passed through
 * untouched.
 */
export function modelProvider(specifier: string): string | undefined {
	const separator = specifier.indexOf('/');
	if (separator <= 0 || separator === specifier.length - 1) return undefined;
	return specifier.slice(0, separator);
}

/** Whether a specifier names a bundled provider and a non-empty model. */
export function isSupportedModel(specifier: string): boolean {
	const provider = modelProvider(specifier);
	return provider !== undefined && (MODEL_PROVIDERS as readonly string[]).includes(provider);
}
