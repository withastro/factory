import { instrument, observe, setProvider } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';
import { Hono } from 'hono';
import { createFactoryAIGatewayProvider } from './ai-gateway.ts';
import { githubChannel } from './channels/github.ts';
import { discordInteractionsChannel } from './discord/interactions.ts';
import type { AppHonoEnv } from './env.ts';
import { createFlueEventLogger, type FlueEventLogger } from './flue-logging.ts';

setProvider(createFactoryAIGatewayProvider());
instrument(createCloudflareTracing({ content: false }));

const flueEventLoggers = new Map<string, FlueEventLogger>();
observe((event, context) => {
	if (context.id.startsWith('release-security:')) return;
	const logger =
		flueEventLoggers.get(context.id) ??
		createFlueEventLogger((message) =>
			console.info(message, {
				agentName: context.agentName,
				contextId: context.id,
			}),
		);
	flueEventLoggers.set(context.id, logger);
	logger.present(event);
	if (event.type === 'submission_settled') flueEventLoggers.delete(context.id);
});

const app = new Hono<AppHonoEnv>();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/channels/github', githubChannel.route());

// Discord button clicks. The public key comes from `env`, so the channel is
// built on first use; without it the endpoint doesn't exist.
app.all('/channels/discord/*', async (c) => {
	const channel = discordInteractionsChannel(c.env.DISCORD_PUBLIC_KEY);
	if (!channel) return c.notFound();
	const discord = new Hono<AppHonoEnv>().route(
		'/channels/discord',
		channel.route(),
	);
	return discord.fetch(c.req.raw, c.env, c.executionCtx);
});

export default app;
