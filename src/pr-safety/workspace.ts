/**
 * The PR safety reviewer's workspace: a credential-free container holding a
 * blobless clone of the base repository with the pull request head checked
 * out (fork heads arrive through `refs/pull/N/head`), plus trusted context
 * staged by Factory: pull request metadata, the diff, and the Tier 0
 * signals.
 *
 * Nothing from the checkout is ever executed. The model reaches it only
 * through the read-only CodeMode tools shared with release security, which is
 * why this module reuses that capability's directory layout.
 */

import { getSandbox } from '@cloudflare/sandbox';
import type { WorkerEnv } from '../env.ts';
import type { InstallationClient } from '../github/client.ts';
import {
	execReleaseCommand as exec,
	RELEASE_CONTEXT_DIR,
	RELEASE_REPO_DIR,
	type ReleaseSandbox,
	shellQuote,
} from '../release-security/sandbox.ts';
import type { PrSafetyWorkflowParams } from './contracts.ts';
import { collectSignals, type SignalReport } from './signals.ts';

export const PR_SAFETY_REPO_DIR = RELEASE_REPO_DIR;
export const PR_SAFETY_CONTEXT_DIR = RELEASE_CONTEXT_DIR;
export const PR_SAFETY_PULL_REQUEST_PATH = `${PR_SAFETY_CONTEXT_DIR}/pull-request.json`;
export const PR_SAFETY_DIFF_PATH = `${PR_SAFETY_CONTEXT_DIR}/pr.diff`;
export const PR_SAFETY_SIGNALS_PATH = `${PR_SAFETY_CONTEXT_DIR}/signals.json`;
export const PR_SAFETY_READY_PATH = `${PR_SAFETY_CONTEXT_DIR}/ready`;

/** Above this the diff is not parsed; the size is itself reported. */
export const MAX_DIFF_BYTES = 20 * 1_024 * 1_024;

export type PrSafetySandbox = ReleaseSandbox;

export function getPrSafetySandbox(
	env: Pick<WorkerEnv, 'PR_SAFETY_SANDBOX'>,
	id: string,
): PrSafetySandbox {
	return getSandbox(env.PR_SAFETY_SANDBOX, id, {
		sleepAfter: '1h',
		enableDefaultSession: false,
	});
}

/** What Factory knows about the author, beyond the webhook. Best effort. */
export interface AuthorContext {
	login: string;
	association: string;
	accountCreatedAt?: string;
	mergedPullRequestsInRepository?: number;
}

export interface PullRequestContext {
	owner: string;
	repo: string;
	pullNumber: number;
	pullUrl: string;
	title: string;
	body: string;
	headRepository: string;
	baseRef: string;
	baseSha: string;
	headSha: string;
	mergeBaseSha: string;
	author: AuthorContext;
}

export type PrSafetyWorkspace =
	| { status: 'stale' }
	| {
			status: 'ready';
			mergeBaseSha: string;
			diffBytes: number;
			signals: Pick<SignalReport, 'totals' | 'files' | 'truncated'>;
	  };

/**
 * Prepare the workspace, or confirm one prepared earlier for this delivery is
 * intact. `stale` means the pull request head moved on; a newer delivery
 * will review it.
 */
export async function ensurePrSafetyWorkspace(
	sandbox: PrSafetySandbox,
	input: PrSafetyWorkflowParams,
	loadAuthor: () => Promise<AuthorContext>,
): Promise<PrSafetyWorkspace> {
	const existing = await readyWorkspace(sandbox, input);
	if (existing) return existing;

	await exec(
		sandbox,
		`rm -rf ${PR_SAFETY_REPO_DIR} ${PR_SAFETY_CONTEXT_DIR} && mkdir -p ${PR_SAFETY_CONTEXT_DIR}`,
		30,
		undefined,
		'prepare workspace',
	);
	assertRepositoryName(input.owner);
	assertRepositoryName(input.repo);
	assertGitRef(input.baseRef);
	await exec(
		sandbox,
		[
			'git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 clone',
			'--filter=blob:none --no-checkout --no-tags --single-branch',
			`--branch ${shellQuote(input.baseRef)}`,
			shellQuote(`https://github.com/${input.owner}/${input.repo}.git`),
			PR_SAFETY_REPO_DIR,
		].join(' '),
		600,
		undefined,
		'clone repository',
	);

	const pullRef = `refs/remotes/origin/pull/${input.pullNumber}`;
	await exec(
		sandbox,
		`git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 fetch --filter=blob:none --no-tags origin ${shellQuote(`+refs/pull/${input.pullNumber}/head:${pullRef}`)}`,
		240,
		PR_SAFETY_REPO_DIR,
		'fetch pull request',
	);
	const fetched = await exec(
		sandbox,
		`git rev-parse ${shellQuote(pullRef)}`,
		30,
		PR_SAFETY_REPO_DIR,
		'verify pull request',
	);
	if (fetched.stdout.trim() !== input.headSha) return { status: 'stale' };

	const hasBase = await exec(
		sandbox,
		`git cat-file -e ${shellQuote(`${input.baseSha}^{commit}`)}`,
		30,
		PR_SAFETY_REPO_DIR,
		'find base commit',
		false,
	);
	if (!hasBase.success) {
		await exec(
			sandbox,
			`git fetch --filter=blob:none --no-tags origin ${shellQuote(input.baseSha)}`,
			240,
			PR_SAFETY_REPO_DIR,
			'fetch base commit',
		);
	}
	const mergeBaseSha = (
		await exec(
			sandbox,
			`git merge-base ${shellQuote(input.baseSha)} ${shellQuote(input.headSha)}`,
			60,
			PR_SAFETY_REPO_DIR,
			'find merge base',
		)
	).stdout.trim();
	await exec(
		sandbox,
		`git checkout --force --detach ${shellQuote(input.headSha)}`,
		600,
		PR_SAFETY_REPO_DIR,
		'checkout pull request head',
	);

	// The diff is taken from the merge base, matching what GitHub shows. No
	// textconv or external diff drivers: the repository must not choose how
	// its own changes are rendered.
	await exec(
		sandbox,
		`git -c core.quotePath=true diff --no-ext-diff --no-textconv --no-color -M ${shellQuote(mergeBaseSha)} ${shellQuote(input.headSha)} > ${shellQuote(PR_SAFETY_DIFF_PATH)}`,
		300,
		PR_SAFETY_REPO_DIR,
		'stage diff',
	);
	const diffBytes = Number(
		(
			await exec(
				sandbox,
				`stat --format=%s ${shellQuote(PR_SAFETY_DIFF_PATH)}`,
				30,
				undefined,
				'inspect diff',
			)
		).stdout.trim(),
	);

	const report = await signalsFor(sandbox, input, diffBytes);
	const author = await loadAuthor();
	const context: PullRequestContext = {
		owner: input.owner,
		repo: input.repo,
		pullNumber: input.pullNumber,
		pullUrl: input.pullUrl,
		title: input.pullTitle,
		body: input.pullBody,
		headRepository: input.headRepository,
		baseRef: input.baseRef,
		baseSha: input.baseSha,
		headSha: input.headSha,
		mergeBaseSha,
		author,
	};
	await sandbox.writeFile(
		PR_SAFETY_PULL_REQUEST_PATH,
		JSON.stringify(context, null, 2),
	);
	await sandbox.writeFile(
		PR_SAFETY_SIGNALS_PATH,
		JSON.stringify(report, null, 2),
	);
	await sandbox.writeFile(PR_SAFETY_READY_PATH, workspaceMarker(input));
	return {
		status: 'ready',
		mergeBaseSha,
		diffBytes,
		signals: {
			totals: report.totals,
			files: report.files,
			truncated: report.truncated,
		},
	};
}

async function signalsFor(
	sandbox: PrSafetySandbox,
	input: PrSafetyWorkflowParams,
	diffBytes: number,
): Promise<SignalReport> {
	if (diffBytes > MAX_DIFF_BYTES) {
		return {
			signals: [
				{
					rule: 'oversized-diff',
					severity: 'high',
					detail: `The diff is ${diffBytes} bytes, too large for rule-based signals; review it with the git tools.`,
					occurrences: 1,
				},
			],
			totals: { high: 1, medium: 0, info: 0 },
			files: 0,
			addedLines: 0,
			removedLines: 0,
			truncated: true,
		};
	}
	const file = await sandbox.readFile(PR_SAFETY_DIFF_PATH);
	if (typeof file.content !== 'string') {
		throw new Error('The staged diff is not text.');
	}
	return collectSignals(file.content, {
		title: input.pullTitle,
		body: input.pullBody,
	});
}

async function readyWorkspace(
	sandbox: PrSafetySandbox,
	input: PrSafetyWorkflowParams,
): Promise<PrSafetyWorkspace | undefined> {
	const result = await exec(
		sandbox,
		[
			`test -d ${PR_SAFETY_REPO_DIR}/.git`,
			`test "$(git -C ${PR_SAFETY_REPO_DIR} rev-parse HEAD)" = ${shellQuote(input.headSha)}`,
			`test -f ${shellQuote(PR_SAFETY_PULL_REQUEST_PATH)}`,
			`test -f ${shellQuote(PR_SAFETY_SIGNALS_PATH)}`,
			`test -f ${shellQuote(PR_SAFETY_DIFF_PATH)}`,
			`test "$(cat ${shellQuote(PR_SAFETY_READY_PATH)})" = ${shellQuote(workspaceMarker(input))}`,
		].join(' && '),
		30,
		undefined,
		'check workspace',
		false,
	);
	if (!result.success) return undefined;
	const context = JSON.parse(
		await readText(sandbox, PR_SAFETY_PULL_REQUEST_PATH),
	) as PullRequestContext;
	const report = JSON.parse(
		await readText(sandbox, PR_SAFETY_SIGNALS_PATH),
	) as SignalReport;
	const diffBytes = Number(
		(
			await exec(
				sandbox,
				`stat --format=%s ${shellQuote(PR_SAFETY_DIFF_PATH)}`,
				30,
				undefined,
				'inspect diff',
			)
		).stdout.trim(),
	);
	return {
		status: 'ready',
		mergeBaseSha: context.mergeBaseSha,
		diffBytes,
		signals: {
			totals: report.totals,
			files: report.files,
			truncated: report.truncated,
		},
	};
}

/** Read the staged signal report, for the private record. */
export async function readStagedSignals(
	sandbox: PrSafetySandbox,
): Promise<SignalReport> {
	return JSON.parse(
		await readText(sandbox, PR_SAFETY_SIGNALS_PATH),
	) as SignalReport;
}

async function readText(
	sandbox: PrSafetySandbox,
	path: string,
): Promise<string> {
	const file = await sandbox.readFile(path);
	if (typeof file.content !== 'string') {
		throw new Error(`${path} is not text.`);
	}
	return file.content;
}

function workspaceMarker(input: PrSafetyWorkflowParams): string {
	return `${input.deliveryId}:${input.baseSha}:${input.headSha}`;
}

export async function destroyPrSafetySandbox(
	sandbox: PrSafetySandbox,
): Promise<void> {
	try {
		await Promise.race([
			sandbox.destroy(),
			new Promise((resolve) => setTimeout(resolve, 10_000)),
		]);
	} catch (error) {
		console.warn('Failed to destroy PR safety sandbox:', error);
	}
}

/**
 * Author context for the reviewer. Account age and track record are hints,
 * never a verdict: new contributors are welcome, and established accounts
 * get compromised. Failures leave the fields out rather than fail the review.
 */
export async function loadAuthorContext(
	client: InstallationClient,
	input: Pick<
		PrSafetyWorkflowParams,
		'owner' | 'repo' | 'author' | 'authorAssociation'
	>,
): Promise<AuthorContext> {
	const context: AuthorContext = {
		login: input.author,
		association: input.authorAssociation,
	};
	try {
		const user = await client.rest.users.getByUsername({
			username: input.author,
		});
		context.accountCreatedAt = user.data.created_at;
	} catch (error) {
		console.warn('PR safety: author lookup failed:', errorName(error));
	}
	try {
		const search = await client.rest.search.issuesAndPullRequests({
			q: `repo:${input.owner}/${input.repo} is:pr is:merged author:${input.author}`,
			per_page: 1,
		});
		context.mergedPullRequestsInRepository = search.data.total_count;
	} catch (error) {
		console.warn('PR safety: author history lookup failed:', errorName(error));
	}
	return context;
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : 'UnknownError';
}

function assertRepositoryName(value: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..')) {
		throw new Error('Repository name is invalid.');
	}
}

function assertGitRef(value: string): void {
	if (
		!value ||
		value.startsWith('-') ||
		value.includes('..') ||
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
	) {
		throw new Error('Base branch is invalid.');
	}
}
