import { FACTORY_BRANCH_PREFIX } from './contracts.ts';

/**
 * Why the author persona can't own this pull request, or undefined when it
 * can: it must be open, come from a same-repository Factory branch, and be
 * assigned to the persona. Checked at the door and again when a round starts,
 * so unassigning the persona cancels queued rounds.
 */
export function checkOwnership(
	snapshot: {
		state: string;
		isCrossRepository: boolean;
		headRef: string;
		assignees: string[];
	},
	login: string,
): string | undefined {
	if (snapshot.state !== 'open') return 'The pull request is not open.';
	if (snapshot.isCrossRepository) {
		return 'The pull request comes from a fork; the author persona only owns same-repository branches.';
	}
	if (!snapshot.headRef.startsWith(FACTORY_BRANCH_PREFIX)) {
		return `The pull request branch is not a Factory branch (${FACTORY_BRANCH_PREFIX}*).`;
	}
	const normalized = login.toLowerCase();
	if (
		!snapshot.assignees.some(
			(assignee) => assignee.toLowerCase() === normalized,
		)
	) {
		return `The pull request is not assigned to ${login}.`;
	}
}
