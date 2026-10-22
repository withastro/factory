/**
 * What the assistant posts in a thread: answers, proposals, and the status of
 * a proposal after a maintainer confirms it.
 *
 * There are no buttons. The bot's interactions endpoint belongs to another
 * application (Houston), so a maintainer confirms a proposal by mentioning
 * the bot ("@Houston file it"), and the proposal message says so.
 */

import {
	DISCORD_MESSAGE_LIMIT,
	type DiscordFile,
	splitMessage,
	truncate,
} from './client.ts';
import type { Proposal, ProposalStatus } from './contracts.ts';

/** Room left for the footer and status line under a proposal. */
const STATUS_RESERVE = 300;

export interface ProposalMessage {
	content: string;
	files: DiscordFile[];
}

/** Split an answer into Discord-sized messages. */
export function formatAnswer(text: string): string[] {
	return splitMessage(text.trim());
}

/**
 * The proposal itself. Long issue bodies are attached as a file and previewed
 * inline, so the message stays under Discord's limit with its footer.
 */
export function formatProposalContent(
	proposal: Proposal,
	owner: string,
	repo: string,
): { content: string; files: DiscordFile[] } {
	const limit = DISCORD_MESSAGE_LIMIT - STATUS_RESERVE;
	if (proposal.kind === 'issue') {
		const header = `**Issue draft for ${owner}/${repo}** (\`${proposal.id}\`): ${proposal.title}`;
		const full = `${header}\n\n${proposal.body}`;
		if (full.length <= limit) return { content: full, files: [] };
		const note = '\n\n_Full draft attached._';
		const preview = truncate(
			proposal.body,
			limit - header.length - note.length - 2,
		);
		return {
			content: `${header}\n\n${preview}${note}`,
			files: [
				{
					name: 'issue.md',
					content: `# ${proposal.title}\n\n${proposal.body}\n`,
				},
			],
		};
	}
	const fixes = proposal.issueNumber
		? `\nFixes ${owner}/${repo}#${proposal.issueNumber}`
		: '';
	const header = `**Pull request plan for ${owner}/${repo}** (\`${proposal.id}\`): ${proposal.title}${fixes}`;
	return {
		content: truncate(`${header}\n\n${proposal.plan}`, limit),
		files: [],
	};
}

/** How to confirm a proposal, shown under it while it's pending. */
export function formatConfirmHint(
	proposal: Proposal,
	botUserId: string,
): string {
	return proposal.kind === 'issue'
		? `_Mention <@${botUserId}> to file it (e.g. "file it"), or ask for changes._`
		: `_Mention <@${botUserId}> to open it (e.g. "open the PR"), or ask for changes._`;
}

export function formatProposalMessage(
	proposal: Proposal,
	owner: string,
	repo: string,
	botUserId: string,
): ProposalMessage {
	const { content, files } = formatProposalContent(proposal, owner, repo);
	return {
		content: `${content}\n\n${formatConfirmHint(proposal, botUserId)}`,
		files,
	};
}

/** The line shown under a proposal once a maintainer confirmed it. */
export function formatProposalStatus(
	proposal: Proposal,
	status: ProposalStatus,
): string {
	switch (status.state) {
		case 'proposed':
			return '';
		case 'claimed':
			return proposal.kind === 'issue'
				? `⏳ Filing the issue (${status.byName})…`
				: `⏳ Confirmed by ${status.byName}. Working on it…`;
		case 'done':
			return proposal.kind === 'issue'
				? `✅ Filed #${status.number} (${status.byName}): ${status.url}`
				: `✅ Opened #${status.number} (confirmed by ${status.byName}): ${status.url}`;
		case 'dismissed':
			return `Dismissed by ${status.byName}.`;
	}
}

/**
 * The proposal message's content for its current status: the confirm hint
 * while pending, the status line afterwards.
 */
export function formatSettledProposal(
	proposal: Proposal,
	status: ProposalStatus,
	owner: string,
	repo: string,
	botUserId: string,
): string {
	const { content } = formatProposalContent(proposal, owner, repo);
	const line =
		status.state === 'proposed'
			? formatConfirmHint(proposal, botUserId)
			: formatProposalStatus(proposal, status);
	return `${content}\n\n${line}`;
}

/** A failure the thread should hear about, kept short. */
export function formatFailure(what: string, reason: string): string {
	const detail = truncate(reason.replace(/```/g, "'''"), 1_200);
	return `Sorry, I ran into a problem ${what}.\n\`\`\`\n${detail}\n\`\`\``;
}
