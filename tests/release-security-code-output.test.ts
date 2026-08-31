import { describe, expect, it } from 'vitest';
import { formatCodeResult } from '../src/release-security/code-output.ts';

describe('release security code output', () => {
	it('formats structured values', () => {
		expect(formatCodeResult({ safe: true })).toBe('{\n  "safe": true\n}');
	});

	it('rejects oversized model-facing output', () => {
		expect(() => formatCodeResult('x'.repeat(100_001))).toThrow(
			'code tool output exceeded',
		);
	});
});
