import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { credentialsFromWorkerEnv } from '../src/github/client.ts';

describe('credentialsFromWorkerEnv', () => {
	it('normalizes escaped private-key line breaks', () => {
		const credentials = credentialsFromWorkerEnv({
			GITHUB_APP_ID: '123456',
			GITHUB_APP_PRIVATE_KEY: 'first\\nsecond',
		} as WorkerEnv);

		expect(credentials).toEqual({
			appId: '123456',
			privateKey: 'first\nsecond',
		});
	});

	it('reports a missing private-key binding', () => {
		expect(() =>
			credentialsFromWorkerEnv({ GITHUB_APP_ID: '123456' } as WorkerEnv),
		).toThrow('GITHUB_APP_PRIVATE_KEY is required.');
	});
});
