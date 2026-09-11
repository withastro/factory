import type { AdversarySandbox, CapturedPatch } from './sandbox.ts';
import {
	assertRepoIdentifier,
	assertSha,
	inspectPatch,
	MAX_PATCH_BYTES,
} from './sandbox.ts';

export interface PatchArtifact extends CapturedPatch {
	key: string;
}

export function bluePatchArtifactKey(input: {
	owner: string;
	repo: string;
	pullNumber: number;
	baseSha: string;
	headSha: string;
	sha256: string;
}): string {
	assertRepoIdentifier(input.owner);
	assertRepoIdentifier(input.repo);
	assertSha(input.baseSha);
	assertSha(input.headSha);
	if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1) {
		throw new Error('Pull request number is invalid.');
	}
	assertDigest(input.sha256);
	return `adversary/${input.owner}/${input.repo}/${input.pullNumber}/${input.baseSha}/${input.headSha}/${input.sha256}.patch`;
}

/** Stream raw patch bytes over Sandbox RPC directly into immutable R2 storage. */
export async function uploadBluePatch(
	bucket: R2Bucket,
	sandbox: AdversarySandbox,
	artifact: CapturedPatch,
	key: string,
): Promise<PatchArtifact> {
	assertArtifact(artifact);
	const file = await sandbox.readFile(artifact.path, { encoding: 'none' });
	if (file.size !== artifact.size || file.size > MAX_PATCH_BYTES) {
		throw new Error('Blue patch changed before artifact upload.');
	}
	const stored = await bucket.put(
		key,
		file.content.pipeThrough(new FixedLengthStream(file.size)),
		{
			onlyIf: { etagDoesNotMatch: '*' },
			httpMetadata: { contentType: 'application/octet-stream' },
			customMetadata: {
				sha256: artifact.sha256,
				size: String(artifact.size),
			},
			sha256: hexBytes(artifact.sha256),
		},
	);
	if (!stored) {
		const existing = await bucket.head(key);
		if (
			!existing ||
			existing.size !== artifact.size ||
			existing.customMetadata?.sha256 !== artifact.sha256
		) {
			throw new Error('An immutable blue patch artifact already exists.');
		}
	}
	return { ...artifact, key };
}

/** Stream an R2 object into a fresh sandbox and verify it before use. */
export async function downloadBluePatch(
	bucket: R2Bucket,
	sandbox: AdversarySandbox,
	artifact: Omit<PatchArtifact, 'path'>,
	destination: string,
): Promise<CapturedPatch> {
	assertArtifact({ ...artifact, path: destination });
	const separator = destination.lastIndexOf('/');
	if (separator < 1) throw new Error('Artifact destination must be absolute.');
	const object = await bucket.get(artifact.key);
	if (!object) throw new Error('Blue patch artifact was not found.');
	if (
		object.size !== artifact.size ||
		object.size > MAX_PATCH_BYTES ||
		object.customMetadata?.sha256 !== artifact.sha256
	) {
		throw new Error('Blue patch artifact metadata does not match.');
	}
	await sandbox.mkdir(destination.slice(0, separator), { recursive: true });
	await sandbox.writeFile(
		destination,
		object.body as ReadableStream<Uint8Array>,
	);
	const downloaded = await inspectPatch(sandbox, destination);
	if (
		downloaded.size !== artifact.size ||
		downloaded.sha256 !== artifact.sha256
	) {
		throw new Error('Blue patch artifact failed integrity verification.');
	}
	return downloaded;
}

function assertArtifact(artifact: CapturedPatch): void {
	if (
		!Number.isSafeInteger(artifact.size) ||
		artifact.size < 0 ||
		artifact.size > MAX_PATCH_BYTES
	) {
		throw new Error('Blue patch exceeds the artifact limit.');
	}
	assertDigest(artifact.sha256);
}

function assertDigest(value: string): void {
	if (!/^[0-9a-f]{64}$/.test(value)) {
		throw new Error('Blue patch digest is invalid.');
	}
}

function hexBytes(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
		Number.parseInt(byte, 16),
	);
}
