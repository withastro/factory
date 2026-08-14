/**
 * The factory's bundled default triage skill. Used whenever the target
 * repository doesn't provide its own `.agents/skills/triage` override.
 *
 * The markdown sources live in `skills/triage/` at the repository root and
 * are inlined into the Worker bundle as markdown text modules. The entry file
 * is stored as `skill.md` (not `SKILL.md`) because Flue's vite plugin
 * packages any import literally named SKILL.md as a Flue skill module; we
 * want the raw text, since these files are seeded into the pipeline sandbox
 * where Flue discovers them from `<cwd>/.agents/skills/`.
 */

import diagnoseMd from '../../skills/triage/diagnose.md';
import fixMd from '../../skills/triage/fix.md';
import reproduceMd from '../../skills/triage/reproduce.md';
import skillMd from '../../skills/triage/skill.md';
import verifyMd from '../../skills/triage/verify.md';
import { createSkillSnapshot, type SkillSnapshot } from '../github/skill.ts';

export function defaultTriageSkill(): SkillSnapshot {
	return createSkillSnapshot('.agents/skills/triage', {
		'SKILL.md': skillMd,
		'reproduce.md': reproduceMd,
		'diagnose.md': diagnoseMd,
		'verify.md': verifyMd,
		'fix.md': fixMd,
	});
}
