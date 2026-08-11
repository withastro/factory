import type { Finding, ReviewResult } from '../contracts/review.ts';

export interface ChangedFile {
	filename: string;
	patch?: string;
}

export interface PreparedReview {
	inline: Finding[];
	unanchored: Finding[];
}

export const REVIEW_DISCLOSURE =
	'This review was made by an LLM. The analysis may be wrong, and reports might be incorrect.';

export function prepareReview(
	result: ReviewResult,
	files: ChangedFile[],
	maxInlineComments = 20,
): PreparedReview {
	const linesByPath = new Map(
		files.map((file) => [file.filename, commentableLines(file.patch)] as const),
	);
	const inline: Finding[] = [];
	const unanchored: Finding[] = [];
	const locations = new Set<string>();

	for (const finding of result.findings) {
		const location = `${finding.path}:${finding.side}:${finding.line}`;
		const lines = linesByPath.get(finding.path);
		if (
			inline.length >= maxInlineComments ||
			locations.has(location) ||
			!lines?.has(`${finding.side}:${finding.line}`)
		) {
			unanchored.push(finding);
			continue;
		}

		locations.add(location);
		inline.push(finding);
	}

	return { inline, unanchored };
}

export function commentableLines(patch: string | undefined): Set<string> {
	const result = new Set<string>();
	if (!patch) return result;

	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	for (const line of patch.split('\n')) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			continue;
		}
		if (!inHunk || line.startsWith('\\')) continue;

		if (line.startsWith('+')) {
			result.add(`RIGHT:${newLine}`);
			newLine += 1;
		} else if (line.startsWith('-')) {
			result.add(`LEFT:${oldLine}`);
			oldLine += 1;
		} else if (line.startsWith(' ')) {
			result.add(`LEFT:${oldLine}`);
			result.add(`RIGHT:${newLine}`);
			oldLine += 1;
			newLine += 1;
		}
	}

	return result;
}

export function reviewMarker(deliveryId: string, headSha: string): string {
	return `<!-- astro-review:delivery=${deliveryId}:head=${headSha} -->`;
}

export function formatReviewBody(
	result: ReviewResult,
	unanchored: Finding[],
	marker: string,
): string {
	const sections = [containModelMarkdown(result.summary.trim())];
	if (unanchored.length > 0) {
		sections.push(
			[
				'### Additional findings',
				'',
				...unanchored.slice(0, 30).map((finding) =>
					[
						formatFindingLead(finding),
						'',
						`\`${containModelMarkdown(finding.path)}:${finding.line} ${finding.side}\``,
						'',
						containModelMarkdown(finding.body.slice(0, 1_000)),
					].join('\n'),
				),
			].join('\n'),
		);
	}
	sections.push(marker, `*${REVIEW_DISCLOSURE}*`);
	return sections.join('\n\n');
}

export function formatInlineFinding(finding: Finding): string {
	return `${formatFindingLead(finding)}\n\n${containModelMarkdown(finding.body)}`;
}

function formatFindingLead(finding: Finding): string {
	return `\`[${finding.severity}][${finding.area}]\`: ${containModelMarkdown(finding.title)}`;
}

function containModelMarkdown(value: string): string {
	return value
		.replaceAll('<', '&lt;')
		.replace(
			/^([ \t]{0,3})(`{3,}|~{3,})/gm,
			(_match, indentation: string, fence: string) => `${indentation}\\${fence}`,
		);
}
