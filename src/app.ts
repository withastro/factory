import { createCloudflareTracing } from '@flue/runtime/cloudflare';
import { instrument } from '@flue/runtime';
import { Hono } from 'hono';
import { githubChannel } from './channels/github.ts';
import type { AppHonoEnv } from './env.ts';

instrument(createCloudflareTracing({ content: false }));

const app = new Hono<AppHonoEnv>();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/channels/github', githubChannel.route());

export default app;
