import type {
	AdvisoryTriageResult,
	AdvisoryWorkflowParams,
} from './contracts.ts';
import type { AdvisorySnapshot } from './github.ts';

/**
 * Keep the complete triage, including everything too long for Discord, in
 * the private reports bucket. Discord is where maintainers read it; this is
 * the durable record.
 */
export async function storePrivateAdvisoryReport(
	bucket: R2Bucket,
	input: AdvisoryWorkflowParams,
	advisory: AdvisorySnapshot,
	result: AdvisoryTriageResult,
): Promise<string> {
	const key = `advisories/${input.owner}/${input.repo}/${input.ghsaId}/${input.deliveryId}.json`;
	await bucket.put(
		key,
		JSON.stringify(
			{ advisory, result, triagedAt: new Date().toISOString() },
			null,
			2,
		),
		{
			httpMetadata: { contentType: 'application/json; charset=utf-8' },
			customMetadata: {
				deliveryId: input.deliveryId,
				ghsaId: input.ghsaId,
				verdict: result.verdict,
				confidence: result.confidence,
			},
		},
	);
	return key;
}
