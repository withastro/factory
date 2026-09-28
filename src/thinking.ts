import * as v from 'valibot';

/** Thinking levels supported by pi-ai across its bundled model providers. */
export const THINKING_LEVELS = [
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
] as const;

export const thinkingLevelSchema = v.picklist(THINKING_LEVELS);

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Preserve the existing setting for Factory's substantive agents. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'high';
