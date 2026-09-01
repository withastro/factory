import type { ConversationStreamChunk } from '@flue/runtime';
import type { ReleaseSecurityWorkflowParams } from './contracts.ts';

const MAX_TRANSCRIPT_BYTES = 2 * 1_024 * 1_024;

export function createReleaseSecurityTranscript(
	input: ReleaseSecurityWorkflowParams,
	agentId: string,
): {
	append(chunk: ConversationStreamChunk): void;
	finish(bucket: R2Bucket): Promise<string>;
} {
	const encoder = new TextEncoder();
	const records: Uint8Array[] = [];
	let bytes = 0;
	let truncated = false;
	const appendValue = (value: unknown) => {
		const record = encoder.encode(`${JSON.stringify(value)}\n`);
		if (bytes + record.byteLength > MAX_TRANSCRIPT_BYTES) {
			truncated = true;
			return;
		}
		records.push(record);
		bytes += record.byteLength;
	};
	appendValue({
		type: 'transcript_start',
		version: 1,
		deliveryId: input.deliveryId,
		agentId,
		reviewedSha: input.headSha,
	});

	return {
		append(chunk) {
			appendValue(chunk);
		},
		async finish(bucket) {
			if (truncated) appendValue({ type: 'transcript_truncated' });
			appendValue({ type: 'transcript_end' });
			const body = new Uint8Array(bytes);
			let offset = 0;
			for (const record of records) {
				body.set(record, offset);
				offset += record.byteLength;
			}
			const key = `${input.owner}/${input.repo}/${input.pullNumber}/${input.headSha}/${input.deliveryId}-transcript.ndjson`;
			await bucket.put(key, body, {
				httpMetadata: {
					contentType: 'application/x-ndjson; charset=utf-8',
				},
				customMetadata: {
					deliveryId: input.deliveryId,
					agentId,
					reviewedSha: input.headSha,
					truncated: String(truncated),
				},
			});
			return key;
		},
	};
}
