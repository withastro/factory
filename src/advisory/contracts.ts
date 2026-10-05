import * as v from 'valibot';
import { thinkingLevelSchema } from '../thinking.ts';

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

/** GitHub advisory ids: `GHSA-xxxx-xxxx-xxxx`, lowercase letters and digits. */
export const GHSA_ID_PATTERN = /^GHSA(?:-[0-9a-z]{4}){3}$/;
const ghsaIdSchema = v.pipe(v.string(), v.regex(GHSA_ID_PATTERN));

/**
 * One advisory triage per `repository_advisory.reported` delivery. The
 * workflow re-reads the advisory when it runs, so it always acts on the
 * current report rather than the webhook snapshot.
 */
export const advisoryWorkflowParamsSchema = v.object({
	deliveryId: nonEmptyString,
	installationId: positiveInteger,
	repositoryId: positiveInteger,
	owner: nonEmptyString,
	repo: nonEmptyString,
	defaultBranch: nonEmptyString,
	/** Private repositories get an authenticated, self-contained clone. */
	repoIsPrivate: v.optional(v.boolean(), false),
	ghsaId: ghsaIdSchema,
});

export type AdvisoryWorkflowParams = v.InferOutput<
	typeof advisoryWorkflowParamsSchema
>;

export function advisoryCoordinatorKey(
	input: Pick<AdvisoryWorkflowParams, 'repositoryId' | 'ghsaId'>,
): string {
	return `${input.repositoryId}:${input.ghsaId}`;
}

/** Durable agent id: one conversation per triage attempt. */
export function advisoryAgentId(input: AdvisoryWorkflowParams): string {
	return ['advisory', input.repositoryId, input.ghsaId, input.deliveryId].join(
		':',
	);
}

/**
 * One sandbox per advisory and delivery. Sandbox ids become DNS labels, so
 * keep them lowercase alphanumeric/hyphen and at most 63 characters.
 */
export function advisorySandboxId(input: AdvisoryWorkflowParams): string {
	const ghsa = input.ghsaId.toLowerCase().replace(/^ghsa-/, '');
	const delivery = input.deliveryId.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
	return `a-${input.repositoryId}-${ghsa}-${delivery}`
		.slice(0, 63)
		.replace(/-+$/, '');
}

/**
 * The local branch the advisory checkout sits on. It exists only so the
 * checkout isn't detached; nothing is ever committed or pushed from it.
 */
export function advisoryWorkBranch(ghsaId: string): string {
	return `factory/advisory-${ghsaId.toLowerCase()}`;
}

// ---------- Agent contracts ----------

export const advisoryAgentInputSchema = v.object({
	sandboxId: nonEmptyString,
	owner: nonEmptyString,
	repo: nonEmptyString,
	ghsaId: ghsaIdSchema,
	defaultBranch: nonEmptyString,
	/** Directory holding advisory.md, advisory.json, and known-advisories.json. */
	advisoryDirectory: nonEmptyString,
	skillName: nonEmptyString,
	skillDirectory: nonEmptyString,
	model: nonEmptyString,
	thinkingLevel: v.optional(thinkingLevelSchema),
});

export type AdvisoryAgentInput = v.InferOutput<typeof advisoryAgentInputSchema>;

export const ADVISORY_VERDICTS = [
	'vulnerability',
	'not-vulnerability',
	'duplicate',
	'needs-information',
] as const;

export type AdvisoryVerdict = (typeof ADVISORY_VERDICTS)[number];

const markdown = (max: number) =>
	v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));

/** What the agent submits; the workflow validates it again before acting. */
export const advisoryTriageResultSchema = v.object({
	verdict: v.picklist(ADVISORY_VERDICTS),
	confidence: v.picklist(['low', 'medium', 'high']),
	/** A real bug worth fixing, whatever the security verdict. */
	isBug: v.boolean(),
	title: markdown(200),
	summary: markdown(1_000),
	reproduction: v.object({
		attempted: v.boolean(),
		reproduced: v.boolean(),
		details: markdown(8_000),
	}),
	duplicateOf: v.nullable(v.pipe(v.array(ghsaIdSchema), v.maxLength(10))),
	severity: v.nullable(
		v.object({
			level: v.picklist(['low', 'medium', 'high', 'critical']),
			cvssVector: v.nullable(
				v.pipe(v.string(), v.regex(/^CVSS:3\.[01]\/[A-Z:/]+$/)),
			),
			cwe: v.nullable(v.pipe(v.string(), v.regex(/^CWE-\d+$/))),
		}),
	),
	affectedPackages: v.pipe(
		v.array(
			v.object({
				name: markdown(214),
				vulnerableVersions: v.nullable(markdown(200)),
			}),
		),
		v.maxLength(20),
	),
	assessment: markdown(60_000),
	reporterReply: markdown(8_000),
	fixBrief: v.nullable(markdown(30_000)),
});

export type AdvisoryTriageResult = v.InferOutput<
	typeof advisoryTriageResultSchema
>;

export type AdvisoryWorkflowOutcome =
	| { outcome: 'ignored'; reason: string }
	| { outcome: 'skipped'; reason: string }
	| { outcome: 'triaged'; verdict: AdvisoryVerdict; reportKey: string }
	| { outcome: 'failed'; reason: string };
