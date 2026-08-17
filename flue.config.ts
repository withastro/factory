import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
	target: 'cloudflare',
	// Only the listed providers are bundled, so this is the set a repository's
	// `model` configuration can name. `cloudflare` runs on Workers AI through
	// the `AI` binding with no credentials; `anthropic` calls the Anthropic API
	// directly and needs the `ANTHROPIC_API_KEY` secret. Keep in sync with
	// MODEL_PROVIDERS in src/models.ts.
	providers: ['cloudflare', 'anthropic'],
});
