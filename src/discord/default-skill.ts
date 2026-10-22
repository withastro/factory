/**
 * The factory's bundled default Discord assistant skill, used whenever the
 * target repository doesn't configure `discord.skill`. Stored as `skill.md`
 * rather than `SKILL.md` for the same reason as the triage skill: Flue's vite
 * plugin would otherwise package it as a Flue skill module, and we want the
 * raw text to seed into the sandbox.
 */

import skillMd from '../../skills/discord-assistant/skill.md';
import { createSkillSnapshot, type SkillSnapshot } from '../github/skill.ts';

export function defaultDiscordSkill(): SkillSnapshot {
	return createSkillSnapshot('.agents/skills/discord-assistant', {
		'SKILL.md': skillMd,
	});
}
