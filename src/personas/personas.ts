/**
 * Personas: assignable GitHub identities in front of Factory capabilities.
 *
 * A persona is not a separate kind of agent. It is an addressing layer: a
 * GitHub user account (configured in `.github/factory.yml`) that maintainers
 * assign issues and pull requests to, or request reviews from, and the
 * capability that assignment starts.
 *
 * - triage   — assigning an issue runs the triage pipeline on it.
 * - reviewer — requesting its review (or assigning it) on a pull request runs
 *              the review capability.
 * - author   — assigning a Factory-created pull request hands ownership of it
 *              to the code author capability, which then addresses review
 *              feedback and failing checks until it is unassigned.
 *
 * The persona accounts are inert handles: Factory never signs in as them and
 * holds no credential for them. Everything Factory writes still comes from the
 * GitHub App installation, signed with the persona's name.
 */

import type { PersonasConfig } from '../config.ts';

export type PersonaName = 'triage' | 'reviewer' | 'author';

export const PERSONA_NAMES: readonly PersonaName[] = [
	'triage',
	'reviewer',
	'author',
];

/** Which persona, if any, a GitHub login addresses. Logins are case-insensitive. */
export function resolvePersona(
	personas: PersonasConfig | undefined,
	login: string | undefined,
): PersonaName | undefined {
	if (!personas || !login) return undefined;
	const normalized = login.toLowerCase();
	return PERSONA_NAMES.find(
		(name) => personas[name]?.login.toLowerCase() === normalized,
	);
}

/** True when `login` is the configured login of persona `name`. */
export function isPersona(
	personas: PersonasConfig | undefined,
	name: PersonaName,
	login: string | undefined,
): boolean {
	return resolvePersona(personas, login) === name;
}

/** True when any of `logins` is the configured login of persona `name`. */
export function includesPersona(
	personas: PersonasConfig | undefined,
	name: PersonaName,
	logins: readonly (string | undefined)[],
): boolean {
	return logins.some((login) => isPersona(personas, name, login));
}

/**
 * Attribution line appended to everything Factory writes for a persona. The
 * login is deliberately not an @-mention, so the persona account isn't
 * notified about its own output.
 */
export function personaSignature(login: string): string {
	return `<sub>— ${login} (Factory persona)</sub>`;
}

/**
 * Why an assignment delivery for persona `name` should not act, or undefined
 * when it should: the assignee must be that persona, and must still be
 * assigned when the queued run starts, so unassigning cancels a queued run.
 */
export function checkPersonaAssignment(
	personas: PersonasConfig | undefined,
	name: PersonaName,
	assignee: string | undefined,
	currentAssignees: readonly string[],
): string | undefined {
	if (!isPersona(personas, name, assignee)) {
		return `${assignee ?? 'The assignee'} is not the ${name} persona.`;
	}
	if (!includesPersona(personas, name, currentAssignees)) {
		return `The ${name} persona was unassigned before the run started.`;
	}
}
