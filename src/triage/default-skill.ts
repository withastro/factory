/**
 * The factory's bundled default triage skill. Used whenever the target
 * repository doesn't provide its own `.agents/skills/triage` override.
 * The markdown sources live in `skills/triage/` at the repository root and
 * are inlined into the Worker bundle at build time.
 */

import diagnoseMd from '../../skills/triage/diagnose.md?raw';
import fixMd from '../../skills/triage/fix.md?raw';
import reproduceMd from '../../skills/triage/reproduce.md?raw';
import skillMd from '../../skills/triage/SKILL.md?raw';
import verifyMd from '../../skills/triage/verify.md?raw';
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
