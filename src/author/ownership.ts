/**
 * Why the author persona can't own this pull request, or undefined when it
 * can: it must be open, come from a same-repository branch (Factory can't
 * push to forks), and be assigned to the persona. Checked at the door and
 * again when a round starts, so unassigning the persona cancels queued rounds.
 */
export function checkOwnership(
	snapshot: {
		state: string;
		isCrossRepository: boolean;
		assignees: string[];
	},
	login: string,
): string | undefined {
	if (snapshot.state !== 'open') return 'The pull request is not open.';
	if (snapshot.isCrossRepository) {
		return 'The pull request comes from a fork; the author persona only owns same-repository branches.';
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
