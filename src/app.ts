import { instrument, observe } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';
import { Hono } from 'hono';
import { githubChannel } from './channels/github.ts';
import type { AppHonoEnv } from './env.ts';
import { createFlueEventLogger, type FlueEventLogger } from './flue-logging.ts';

instrument(createCloudflareTracing());

const flueEventLoggers = new Map<string, FlueEventLogger>();
observe((event, context) => {
	const logger = flueEventLoggers.get(context.id) ?? createFlueEventLogger();
	flueEventLoggers.set(context.id, logger);
	logger.present(event);
	if (event.type === 'submission_settled') flueEventLoggers.delete(context.id);
});

const app = new Hono<AppHonoEnv>();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/channels/github', githubChannel.route());

export default app;
