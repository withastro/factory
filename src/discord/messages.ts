/**
 * What the assistant posts in a thread: answers, proposals with buttons, and
 * the status of a proposal after a maintainer acts on it.
 */

import {
	DISCORD_MESSAGE_LIMIT,
	type DiscordActionRow,
	type DiscordFile,
	splitMessage,
	truncate,
} from './client.ts';
import {
	type Proposal,
	type ProposalStatus,
	proposalCustomId,
} from './contracts.ts';

/** Room left for the status line appended under a proposal. */
const STATUS_RESERVE = 200;

export interface ProposalMessage {
	content: string;
	files: DiscordFile[];
	components: DiscordActionRow[];
}

/** Split an answer into Discord-sized messages. */
export function formatAnswer(text: string): string[] {
	return splitMessage(text.trim());
}

/**
 * The proposal's text, without buttons. Long issue bodies are attached as a
 * file and previewed inline, so the message stays under Discord's limit even
 * after a status line is appended.
 */
export function formatProposalContent(
	proposal: Proposal,
	owner: string,
	repo: string,
): { content: string; files: DiscordFile[] } {
	const limit = DISCORD_MESSAGE_LIMIT - STATUS_RESERVE;
	if (proposal.kind === 'issue') {
		const header = `**Issue draft for ${owner}/${repo}:** ${proposal.title}`;
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
	const header = `**Pull request plan for ${owner}/${repo}:** ${proposal.title}${fixes}`;
	return {
		content: truncate(`${header}\n\n${proposal.plan}`, limit),
		files: [],
	};
}

export function proposalButtons(
	proposal: Proposal,
	threadId: string,
	options: { disabled?: boolean } = {},
): DiscordActionRow[] {
	const confirm =
		proposal.kind === 'issue'
			? {
					label: 'Create issue',
					custom_id: proposalCustomId('create-issue', threadId, proposal.id),
				}
			: {
					label: 'Open PR',
					custom_id: proposalCustomId('open-pr', threadId, proposal.id),
				};
	return [
		{
			type: 1,
			components: [
				{ type: 2, style: 3, ...confirm, disabled: options.disabled },
				{
					type: 2,
					style: 2,
					label: 'Dismiss',
					custom_id: proposalCustomId('dismiss', threadId, proposal.id),
					disabled: options.disabled,
				},
			],
		},
	];
}

export function formatProposalMessage(
	proposal: Proposal,
	threadId: string,
	owner: string,
	repo: string,
): ProposalMessage {
	return {
		...formatProposalContent(proposal, owner, repo),
		components: proposalButtons(proposal, threadId),
	};
}

/** The line appended under a proposal once a maintainer acted on it. */
export function formatProposalStatus(
	proposal: Proposal,
	status: ProposalStatus,
): string {
	switch (status.state) {
		case 'proposed':
			return '';
		case 'claimed':
			return proposal.kind === 'issue'
				? `⏳ Creating the issue (${status.byName})…`
				: `⏳ Approved by ${status.byName}. Working on it…`;
		case 'done':
			return proposal.kind === 'issue'
				? `✅ Created #${status.number} (${status.byName}): ${status.url}`
				: `✅ Opened #${status.number} (approved by ${status.byName}): ${status.url}`;
		case 'dismissed':
			return `Dismissed by ${status.byName}.`;
	}
}

/** The proposal message's content with its status line. */
export function formatSettledProposal(
	proposal: Proposal,
	status: ProposalStatus,
	owner: string,
	repo: string,
): string {
	const { content } = formatProposalContent(proposal, owner, repo);
	const line = formatProposalStatus(proposal, status);
	return line ? `${content}\n\n${line}` : content;
}

/** A failure the thread should hear about, kept short. */
export function formatFailure(what: string, reason: string): string {
	const detail = truncate(reason.replace(/```/g, "'''"), 1_200);
	return `Sorry, I ran into a problem ${what}.\n\`\`\`\n${detail}\n\`\`\``;
}
