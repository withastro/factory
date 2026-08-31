const MAX_CODE_OUTPUT_LENGTH = 100_000;

export function formatCodeResult(result: unknown): string {
	const text =
		result === undefined
			? '(no result)'
			: typeof result === 'string'
				? result
				: typeof result === 'bigint'
					? result.toString()
					: JSON.stringify(result, null, 2);
	if (text.length > MAX_CODE_OUTPUT_LENGTH) {
		throw new Error(
			`code tool output exceeded ${MAX_CODE_OUTPUT_LENGTH} characters; return focused excerpts or summaries instead of complete files`,
		);
	}
	return text;
}
