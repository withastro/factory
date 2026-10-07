/**
 * Contracts for the Discord assistant: the jobs a thread queues, the
 * workflow's parameters, the proposals the agent makes, and the ids derived
 * from a thread.
 *
 * One Discord thread is one conversation. It has one agent instance (so the
 * assistant remembers the discussion), one sandbox (a checkout of the
 * repository that sleeps after an hour idle and is rebuilt on demand), and one
 * coordinator that runs the thread's jobs in order.
 */

import * as v from 'valibot';
import { thinkingLevelSchema } from '../thinking.ts';

const snowflake = v.pipe(v.string(), v.regex(/^\d{1,25}$/));
const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const proposalIdSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{8,16}$/));

/** A maintainer mentioned the bot; answer everything new in the thread. */
const mentionJobSchema = v.object({
	kind: v.literal('mention'),
	messageId: snowflake,
	authorId: snowflake,
	authorName: nonEmptyString,
});

/** A maintainer approved a pull request proposal; implement and open it. */
const pullRequestJobSchema = v.object({
	kind: v.literal('pull-request'),
	proposalId: proposalIdSchema,
	requestedById: snowflake,
	requestedByName: nonEmptyString,
});

export const discordJobSchema = v.variant('kind', [
	mentionJobSchema,
	pullRequestJobSchema,
]);

export type DiscordJob = v.InferOutput<typeof discordJobSchema>;

export const discordThreadWorkflowParamsSchema = v.object({
	/** Unique per job; doubles as the Workflow instance id. */
	deliveryId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/)),
	guildId: snowflake,
	threadId: snowflake,
	/** The bot's own user id, so its messages can be told apart. */
	botUserId: snowflake,
	job: discordJobSchema,
});

export type DiscordThreadWorkflowParams = v.InferOutput<
	typeof discordThreadWorkflowParamsSchema
>;

/** A stable id per job, used to deduplicate it and as its Workflow id. */
export function discordJobId(threadId: string, job: DiscordJob): string {
	return job.kind === 'mention'
		? `discord-${threadId}-m-${job.messageId}`
		: `discord-${threadId}-pr-${job.proposalId}`;
}

export function discordAgentId(threadId: string): string {
	return `discord-thread-${threadId}`;
}

export function discordSandboxId(threadId: string): string {
	return `discord-${threadId}`;
}

/** The branch the thread's checkout works on, and pull requests are pushed from. */
export function discordWorkBranch(threadId: string): string {
	return `factory/discord-${threadId}`;
}

/** A link to a Discord thread. */
export function discordThreadUrl(guildId: string, threadId: string): string {
	return `https://discord.com/channels/${guildId}/${threadId}`;
}

// ---------- Agent contracts ----------

export const discordAgentInputSchema = v.object({
	sandboxId: nonEmptyString,
	guildId: snowflake,
	threadId: snowflake,
	owner: nonEmptyString,
	repo: nonEmptyString,
	defaultBranch: nonEmptyString,
	/** Directory holding files staged for the agent (linked issues). */
	contextDirectory: nonEmptyString,
	skillName: nonEmptyString,
	skillDirectory: nonEmptyString,
	model: nonEmptyString,
	thinkingLevel: v.optional(thinkingLevelSchema),
});

export type DiscordAgentInput = v.InferOutput<typeof discordAgentInputSchema>;

const markdown = (max: number) =>
	v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));

const issueNumberSchema = v.nullable(
	v.pipe(v.number(), v.integer(), v.minValue(1)),
);

/** The agent proposes filing an issue; a maintainer confirms with a button. */
export const issueProposalInputSchema = v.object({
	title: markdown(256),
	body: markdown(20_000),
});

/** The agent proposes a pull request; a maintainer confirms with a button. */
export const pullRequestProposalInputSchema = v.object({
	title: markdown(256),
	/** What the change will do, for the maintainer deciding whether to approve it. */
	plan: markdown(4_000),
	/** The issue the pull request fixes, when there is one. */
	issueNumber: issueNumberSchema,
});

/** After implementing an approved pull request, the agent submits its content. */
export const pullRequestSubmissionSchema = v.object({
	title: markdown(256),
	body: markdown(20_000),
	commitMessage: markdown(2_000),
});

export type IssueProposalInput = v.InferOutput<typeof issueProposalInputSchema>;
export type PullRequestProposalInput = v.InferOutput<
	typeof pullRequestProposalInputSchema
>;
export type PullRequestSubmission = v.InferOutput<
	typeof pullRequestSubmissionSchema
>;

// ---------- Proposals ----------

export const proposalSchema = v.variant('kind', [
	v.object({
		kind: v.literal('issue'),
		id: proposalIdSchema,
		title: markdown(256),
		body: markdown(20_000),
	}),
	v.object({
		kind: v.literal('pull-request'),
		id: proposalIdSchema,
		title: markdown(256),
		plan: markdown(4_000),
		issueNumber: issueNumberSchema,
	}),
]);

export type Proposal = v.InferOutput<typeof proposalSchema>;

export type ProposalStatus =
	| { state: 'proposed' }
	| { state: 'claimed'; byId: string; byName: string }
	| { state: 'done'; byName: string; url: string; number: number }
	| { state: 'dismissed'; byName: string };

export interface StoredProposal {
	proposal: Proposal;
	/** The Discord message holding the proposal's buttons. */
	messageId: string | undefined;
	status: ProposalStatus;
}

// ---------- Button custom ids ----------

export type ProposalAction = 'create-issue' | 'open-pr' | 'dismiss';

const ACTIONS: readonly ProposalAction[] = [
	'create-issue',
	'open-pr',
	'dismiss',
];

export function proposalCustomId(
	action: ProposalAction,
	threadId: string,
	proposalId: string,
): string {
	return `factory:${action}:${threadId}:${proposalId}`;
}

export function parseProposalCustomId(
	customId: string,
):
	| { action: ProposalAction; threadId: string; proposalId: string }
	| undefined {
	const match = /^factory:([a-z-]+):(\d{1,25}):([a-f0-9]{8,16})$/.exec(
		customId,
	);
	if (!match) return undefined;
	const action = match[1] as ProposalAction;
	if (!ACTIONS.includes(action)) return undefined;
	return {
		action,
		threadId: match[2] as string,
		proposalId: match[3] as string,
	};
}

export function newProposalId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
