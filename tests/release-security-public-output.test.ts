import { describe, expect, it } from 'vitest';
import {
	hasReleaseSecurityCommentMarker,
	sanitizedReleaseSecurityComment,
} from '../src/release-security/public-output.ts';

describe('release security public output', () => {
	it('withholds private blocker details', () => {
		const comment = sanitizedReleaseSecurityComment(
			{ verdict: 'BLOCK', reviewedSha: 'a'.repeat(40) },
			'withastro/astro',
			'release',
		);
		expect(hasReleaseSecurityCommentMarker(comment)).toBe(true);
		expect(comment).toContain('Details are withheld');
		expect(comment).not.toContain('exploit');
	});

	it('labels incomplete reviews without exposing the reason', () => {
		const comment = sanitizedReleaseSecurityComment(
			{ verdict: 'INCOMPLETE', reviewedSha: 'b'.repeat(40) },
			'withastro/astro',
			'release',
		);
		expect(comment).toContain('**Incomplete**');
		expect(comment).toContain('could not be completed');
	});
});
