import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AdvisoryTriageResult } from '../src/advisory/contracts.ts';
import { discordDestinationFromEnv } from '../src/advisory/discord-destination.ts';
import {
	formatAnnouncement,
	formatFailureMessage,
	formatThreadName,
	formatTriageMessages,
} from '../src/advisory/discord-output.ts';
import {
	listKnownAdvisories,
	renderAdvisoryMarkdown,
	renderKnownAdvisories,
	toAdvisorySnapshot,
} from '../src/advisory/github.ts';
import type { InstallationClient } from '../src/github/client.ts';
import { createSkillSnapshot } from '../src/github/skill.ts';

const rawAdvisory = {
	ghsa_id: 'GHSA-ff38-p3qj-4pmf',
	html_url:
		'https://github.com/withastro/astro/security/advisories/GHSA-ff38-p3qj-4pmf',
	state: 'triage',
	summary: 'XSS in [prism](https://evil.example) `code`\nsecond line',
	description: 'Steps to reproduce…',
	severity: 'high',
	cve_id: null,
	created_at: '2026-09-20T00:00:00Z',
	published_at: null,
	closed_at: null,
	withdrawn_at: null,
	author: { login: 'reporter' },
	cvss: { vector_string: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:N' },
	cwe_ids: ['CWE-79'],
	vulnerabilities: [
		{
			package: { ecosystem: 'npm', name: '@astrojs/prism' },
			vulnerable_version_range: '<= 4.0.2',
			patched_versions: null,
		},
	],
	extra_field: 'ignored',
};

const advisory = toAdvisorySnapshot(rawAdvisory);

const result: AdvisoryTriageResult = {
	verdict: 'vulnerability',
	confidence: 'high',
	isBug: true,
	title: 'XSS through unescaped code in @astrojs/prism',
	summary: 'Reproduced: Markdoc content can inject HTML.',
	reproduction: { attempted: true, reproduced: true, details: 'Built it.' },
	duplicateOf: null,
	severity: {
		level: 'medium',
		cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N',
		cwe: 'CWE-79',
	},
	affectedPackages: [
		{ name: '@astrojs/prism', vulnerableVersions: '<= 4.0.2' },
	],
	assessment: '## Claim\n\nLong assessment.',
	reporterReply: 'Thanks — we reproduced this and are working on a fix.',
	fixBrief: '## Problem\n\nEscape code when there is no grammar.',
};

describe('advisory snapshots', () => {
	it('normalizes the GitHub advisory payload', () => {
		expect(advisory).toMatchObject({
			ghsaId: 'GHSA-ff38-p3qj-4pmf',
			state: 'triage',
			reporter: 'reporter',
			severity: 'high',
			cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:N',
			cweIds: ['CWE-79'],
			packages: [
				{
					ecosystem: 'npm',
					name: '@astrojs/prism',
					vulnerableVersions: '<= 4.0.2',
					patchedVersions: null,
				},
			],
		});
		expect(advisory).not.toHaveProperty('extra_field');
	});

	it('renders the report for the agent, marked untrusted', () => {
		const markdown = renderAdvisoryMarkdown(advisory);
		expect(markdown).toContain('# GHSA-ff38-p3qj-4pmf:');
		expect(markdown).toContain('untrusted input');
		expect(markdown).toContain('`@astrojs/prism` — vulnerable: <= 4.0.2');
		expect(markdown).toContain('Steps to reproduce…');
	});

	it('truncates long descriptions in known advisories', () => {
		const known = JSON.parse(
			renderKnownAdvisories([{ ...advisory, description: 'x'.repeat(5_000) }]),
		);
		expect(known[0].description).toHaveLength(4_000 + '\n[truncated]'.length);
	});

	it('lists every other advisory across pages', async () => {
		const page = (count: number, offset: number) =>
			Array.from({ length: count }, (_, index) => ({
				...rawAdvisory,
				ghsa_id: `GHSA-${String(offset + index).padStart(4, '0')}-aaaa-bbbb`,
			}));
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				data: [
					...page(99, 0),
					{ ...rawAdvisory, ghsa_id: 'GHSA-ff38-p3qj-4pmf' },
				],
			})
			.mockResolvedValueOnce({ data: page(3, 100) });
		const known = await listKnownAdvisories(
			{ request } as unknown as InstallationClient,
			'withastro',
			'astro',
			'GHSA-ff38-p3qj-4pmf',
		);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[0]?.[1]).toMatchObject({
			per_page: 100,
			page: 1,
		});
		expect(request.mock.calls[0]?.[1]).not.toHaveProperty('state');
		expect(known).toHaveLength(102);
		expect(known.some((entry) => entry.ghsaId === 'GHSA-ff38-p3qj-4pmf')).toBe(
			false,
		);
	});
});

describe('advisory Discord output', () => {
	it('announces a report with untrusted text neutralized', () => {
		const content = formatAnnouncement('withastro/astro', advisory, {
			kind: 'running',
		});
		expect(content).toContain(
			'[GHSA-ff38-p3qj-4pmf](<https://github.com/withastro/astro/security/advisories/GHSA-ff38-p3qj-4pmf>)',
		);
		expect(content).toContain(
			'> XSS in prism(https://evil.example) code second line',
		);
		expect(content).toContain('Reported by @reporter · claimed severity: high');
		expect(content).toContain('Factory is triaging this report');
	});

	it('shows the verdict once triaged', () => {
		expect(
			formatAnnouncement('withastro/astro', advisory, {
				kind: 'triaged',
				result: {
					verdict: 'not-vulnerability',
					confidence: 'high',
					isBug: true,
				},
			}),
		).toContain('Triage: **Not a vulnerability** (high confidence · real bug)');
		expect(
			formatAnnouncement('withastro/astro', advisory, { kind: 'failed' }),
		).toContain('could not triage');
	});

	it('names the thread after the advisory within Discord limits', () => {
		const name = formatThreadName({ ...advisory, summary: 'y'.repeat(200) });
		expect(name.startsWith('GHSA-ff38-p3qj-4pmf: ')).toBe(true);
		expect(name.length).toBeLessThanOrEqual(100);
	});

	it('posts the triage with attachments and the reply inline', () => {
		const messages = formatTriageMessages(advisory, result);
		expect(messages.summary.content).toContain(
			'🔴 **Vulnerability** · high confidence',
		);
		expect(messages.summary.content).toContain(
			'Suggested severity: medium (`CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N`) · CWE-79',
		);
		expect(messages.summary.content).toContain('Reproduction: reproduced');
		expect(messages.summary.content).not.toContain('Real bug worth fixing');
		expect(messages.summary.content.length).toBeLessThanOrEqual(2_000);
		expect(messages.summary.files.map((file) => file.name)).toEqual([
			'GHSA-ff38-p3qj-4pmf-assessment.md',
			'GHSA-ff38-p3qj-4pmf-reporter-reply.md',
			'GHSA-ff38-p3qj-4pmf-fix-brief.md',
		]);
		expect(messages.followUps).toEqual([
			'**Draft reply to the reporter**',
			result.reporterReply,
		]);
	});

	it('omits the fix brief when there is none', () => {
		const messages = formatTriageMessages(advisory, {
			...result,
			verdict: 'duplicate',
			duplicateOf: ['GHSA-8mhh-aaaa-bbbb'],
			severity: null,
			isBug: false,
			fixBrief: null,
		});
		expect(messages.summary.files).toHaveLength(2);
		expect(messages.summary.content).toContain(
			'Duplicate of: GHSA-8mhh-aaaa-bbbb',
		);
		expect(messages.summary.content).toContain('Real bug worth fixing: no');
	});

	it('keeps failure output inside one code block', () => {
		const content = formatFailureMessage('boom ```\n@everyone');
		expect(content.match(/```/g)).toHaveLength(2);
		expect(content.length).toBeLessThanOrEqual(2_000);
	});
});

describe('Discord destination', () => {
	it('requires both the bot token and the channel id', () => {
		expect(discordDestinationFromEnv({})).toBeUndefined();
		expect(
			discordDestinationFromEnv({ DISCORD_BOT_TOKEN: 'token' }),
		).toBeUndefined();
		expect(
			discordDestinationFromEnv({
				DISCORD_BOT_TOKEN: 'token',
				DISCORD_SECURITY_CHANNEL_ID: '1432493454784462970',
			}),
		).toEqual({ botToken: 'token', channelId: '1432493454784462970' });
		expect(() =>
			discordDestinationFromEnv({
				DISCORD_BOT_TOKEN: 'token',
				DISCORD_SECURITY_CHANNEL_ID: '#security',
			}),
		).toThrow();
	});
});

describe('bundled advisory triage skill', () => {
	// Read from disk: the `.md` import in default-skill.ts is resolved by the
	// Worker build's vite plugin and isn't available here.
	const skill = readFileSync('skills/advisory-triage/skill.md', 'utf8');

	it('is a valid skill named after its directory', () => {
		expect(
			createSkillSnapshot('.agents/skills/advisory-triage', {
				'SKILL.md': skill,
			}).name,
		).toBe('advisory-triage');
	});

	it('names the submit tool and every staged input file', () => {
		for (const name of [
			'submit_advisory_triage',
			'advisory.md',
			'advisory.json',
			'known-advisories.json',
		]) {
			expect(skill).toContain(name);
		}
	});
});
