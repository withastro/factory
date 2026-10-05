/**
 * The factory's bundled default advisory triage skill, used whenever the
 * target repository doesn't configure `advisories.skill`. Stored as
 * `skill.md` rather than `SKILL.md` for the same reason as the triage skill:
 * Flue's vite plugin would otherwise package it as a Flue skill module, and
 * we want the raw text to seed into the sandbox.
 */

import skillMd from '../../skills/advisory-triage/skill.md';
import { createSkillSnapshot, type SkillSnapshot } from '../github/skill.ts';

export function defaultAdvisorySkill(): SkillSnapshot {
	return createSkillSnapshot('.agents/skills/advisory-triage', {
		'SKILL.md': skillMd,
	});
}
