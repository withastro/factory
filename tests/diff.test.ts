import { describe, expect, it } from 'vitest';
import type { Finding, ReviewResult } from '../src/contracts/review.ts';
import {
	commentableLines,
	formatReviewBody,
	prepareReview,
} from '../src/github/diff.ts';

const patch = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,3 +20,3 @@ function example() {
 context
-removed
+added
 trailing`;

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		path: 'src/example.ts',
		line: 21,
		side: 'RIGHT',
		severity: 'high',
		title: 'Incorrect behavior',
		body: 'This change returns the wrong value.',
		...overrides,
	};
}

describe('GitHub diff locations', () => {
	it('maps additions, deletions, and context to the correct side', () => {
		expect([...commentableLines(patch)]).toEqual([
			'LEFT:10',
			'RIGHT:20',
			'LEFT:11',
			'RIGHT:21',
			'LEFT:12',
			'RIGHT:22',
		]);
	});

	it('ignores file headers before the first hunk', () => {
		const lines = commentableLines(patch);
		expect(lines.has('LEFT:0')).toBe(false);
		expect(lines.has('RIGHT:0')).toBe(false);
	});

	it('keeps only valid unique locations inline and preserves all others', () => {
		const result: ReviewResult = {
			summary: 'Review summary',
			findings: [
				finding(),
				finding({ title: 'Duplicate location' }),
				finding({ path: 'src/other.ts', line: 1 }),
			],
		};
		const prepared = prepareReview(result, [{ filename: 'src/example.ts', patch }]);

		expect(prepared.inline).toEqual([result.findings[0]]);
		expect(prepared.unanchored).toEqual(result.findings.slice(1));
	});

	it('includes explanatory text for findings that cannot be anchored', () => {
		const item = finding({ path: 'src/other.ts', line: 7, side: 'LEFT' });
		const body = formatReviewBody(
			{ summary: 'Review summary', findings: [item] },
			[item],
			'<!-- marker -->',
		);
		expect(body).toContain('This change returns the wrong value.');
		expect(body).toContain('`src/other.ts:7 LEFT`');
		expect(body).toContain('<!-- marker -->');
	});
});
