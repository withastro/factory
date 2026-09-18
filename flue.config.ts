import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
	target: 'cloudflare',
	// Factory deliberately exposes one provider. It can reach Workers AI,
	// Anthropic, and other upstreams, but every request must pass through the
	// shared AI Gateway. Keep in sync with MODEL_PROVIDERS in src/models.ts.
	providers: ['cloudflare-ai-gateway'],
});
