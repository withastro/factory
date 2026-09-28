/**
 * Containment for model-authored Markdown that Factory posts to GitHub.
 *
 * Model text sits between trusted content: verdict notices above it, and
 * markers and the LLM disclosure below it. It must not be able to hide or
 * spoof that content, which means:
 *
 * - no raw HTML outside code (`<` is escaped), so it can't open an HTML
 *   comment or element that swallows what follows;
 * - no `<!--` anywhere, even in code, so it can't carry a Factory marker that
 *   Factory later parses back out of the comment;
 * - no unclosed code fence, which would swallow everything after it.
 *
 * Code blocks and code spans are otherwise left intact, since GitHub renders
 * their contents literally (an escaped `&lt;` inside code would show as-is).
 */

const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
// A whole-body fence around Markdown, which models sometimes add to "show"
// their summary as Markdown.
const MARKDOWN_WRAPPER = /^(`{3,}|~{3,})[ \t]*(?:md|markdown)[ \t]*$/i;

interface OpenFence {
	char: string;
	length: number;
}

export function containModelMarkdown(value: string): string {
	const lines = unwrapMarkdownFence(value).split('\n');
	const contained: string[] = [];
	let open: OpenFence | undefined;
	for (const line of lines) {
		const fence = FENCE_LINE.exec(line);
		if (open) {
			if (fence && closesFence(open, fence[2] ?? '', fence[3] ?? '')) {
				open = undefined;
				contained.push(line);
			} else {
				contained.push(neutralizeComments(line));
			}
			continue;
		}
		const [, indentation = '', marker = '', info = ''] = fence ?? [];
		// A backtick fence's info string may not contain backticks; if it
		// does, the line is inline code, not a fence.
		if (fence && !(marker.startsWith('`') && info.includes('`'))) {
			open = { char: marker.charAt(0), length: marker.length };
			contained.push(`${indentation}${marker}${escapeHtml(info)}`);
			continue;
		}
		contained.push(containInline(line));
	}
	if (open) contained.push(open.char.repeat(open.length));
	return contained.join('\n');
}

function closesFence(open: OpenFence, marker: string, rest: string): boolean {
	return (
		marker.charAt(0) === open.char &&
		marker.length >= open.length &&
		rest.trim() === ''
	);
}

/** Drop a ```md fence wrapped around the whole value. */
function unwrapMarkdownFence(value: string): string {
	const lines = value.trim().split('\n');
	if (lines.length < 2) return value;
	const opening = MARKDOWN_WRAPPER.exec(lines[0]?.trim() ?? '');
	const closing = lines.at(-1)?.trim() ?? '';
	const marker = opening?.[1];
	if (
		!marker ||
		closing.length < marker.length ||
		closing !== marker.charAt(0).repeat(closing.length)
	) {
		return value;
	}
	return lines.slice(1, -1).join('\n').trim();
}

/** Escape HTML outside code spans; neutralize comments inside them. */
function containInline(line: string): string {
	let result = '';
	let index = 0;
	while (index < line.length) {
		const start = line.indexOf('`', index);
		if (start === -1) {
			result += escapeHtml(line.slice(index));
			break;
		}
		result += escapeHtml(line.slice(index, start));
		const run = backtickRun(line, start);
		const end = findClosingRun(line, start + run, run);
		if (end === -1) {
			// No matching run: the backticks are literal text.
			result += line.slice(start, start + run);
			index = start + run;
			continue;
		}
		result += neutralizeComments(line.slice(start, end + run));
		index = end + run;
	}
	return result;
}

function backtickRun(line: string, start: number): number {
	let end = start;
	while (line[end] === '`') end++;
	return end - start;
}

function findClosingRun(line: string, from: number, length: number): number {
	let index = line.indexOf('`', from);
	while (index !== -1) {
		const run = backtickRun(line, index);
		if (run === length) return index;
		index = line.indexOf('`', index + run);
	}
	return -1;
}

function escapeHtml(text: string): string {
	return text.replaceAll('<', '&lt;');
}

/**
 * Break `<!--` inside code with a zero-width space. It renders the same, but
 * can no longer match a Factory marker pattern.
 */
function neutralizeComments(text: string): string {
	return text.replaceAll('<!--', '<!\u200b--');
}
