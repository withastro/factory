/**
 * The factory's bundled default review skill. Used whenever the target
 * repository doesn't configure its own review skill override.
 *
 * Keep the source entry named `skill.md`; Flue's vite plugin reserves imports
 * literally named `SKILL.md` for packaged skills. Import the source explicitly
 * as raw text so it can be mounted into the review agent's sandbox for
 * workspace discovery.
 */

import license from '../../skills/review/LICENSE?raw';
import skillMd from '../../skills/review/skill.md?raw';
import { createSkillSnapshot, type SkillSnapshot } from '../github/skill.ts';

export function defaultReviewSkill(): SkillSnapshot {
	return createSkillSnapshot('.agents/skills/review', {
		'SKILL.md': skillMd,
		LICENSE: license,
	});
}
