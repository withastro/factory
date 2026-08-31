import type {
	ReleaseSecurityMode,
	ReleaseSecurityResult,
} from './contracts.ts';

export function releaseSecurityCommentMarker(): string {
	return '<!-- astro-release-security -->';
}

export function hasReleaseSecurityCommentMarker(body: string): boolean {
	return /^<!-- astro-release-security(?::[^\r\n>]+)? -->/.test(body);
}

export function sanitizedReleaseSecurityComment(
	result: Pick<ReleaseSecurityResult, 'verdict' | 'reviewedSha'>,
	repository: string,
	mode: ReleaseSecurityMode,
): string {
	const detail =
		mode === 'smoke'
			? result.verdict === 'PASS'
				? 'The isolated model health check passed. No release security analysis was performed.'
				: 'The isolated model health check did not pass. No release security analysis was performed.'
			: result.verdict === 'PASS'
				? 'No release-blocking vulnerabilities were found.'
				: result.verdict === 'BLOCK'
					? 'A potential release-blocking vulnerability was found. Details are withheld and require maintainer review.'
					: 'The review could not be completed. Details are withheld.';
	const heading =
		mode === 'smoke'
			? 'Release security smoke test'
			: 'Release security review';
	const label =
		result.verdict === 'PASS'
			? 'Passed'
			: result.verdict === 'BLOCK'
				? 'Blocked'
				: 'Incomplete';
	const commitUrl = `https://github.com/${repository}/commit/${result.reviewedSha}`;
	return `${releaseSecurityCommentMarker()}\n## ${heading}\n\n**${label}**\n\n${detail}\n\nReviewed commit: [\`${result.reviewedSha.slice(0, 7)}\`](${commitUrl})`;
}
