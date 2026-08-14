/**
 * Model selection for every factory agent, in one place.
 *
 * The `cloudflare/` prefix resolves through the Worker's `AI` binding, so no
 * API key or account id is required.
 */

/** Reviews and (future) triage pipeline work: the strongest coding model. */
export const CODE_MODEL = 'cloudflare/@cf/moonshotai/kimi-k2.7-code';

/** Lightweight classification calls (fix verification, retriage decisions). */
export const VERIFICATION_MODEL = 'cloudflare/@cf/moonshotai/kimi-k2.6';
