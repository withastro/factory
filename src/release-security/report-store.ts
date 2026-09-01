import type {
	ReleaseSecurityResult,
	ReleaseSecurityWorkflowParams,
} from './contracts.ts';

export async function storePrivateReleaseSecurityReport(
	bucket: R2Bucket,
	input: ReleaseSecurityWorkflowParams,
	result: ReleaseSecurityResult,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(result.report),
	);
	const hash = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	const key = `${input.owner}/${input.repo}/${input.pullNumber}/${input.headSha}/${input.deliveryId}-${result.verdict.toLowerCase()}-${hash}.md`;
	await bucket.put(key, result.report, {
		httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
		customMetadata: {
			deliveryId: input.deliveryId,
			verdict: result.verdict,
			reviewedSha: result.reviewedSha,
			pullNumber: String(input.pullNumber),
		},
	});
	return key;
}
