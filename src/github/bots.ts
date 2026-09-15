/**
 * Bot-account detection for webhook payloads.
 *
 * GitHub reports GitHub App accounts with `user.type === 'Bot'`, and that is
 * the only signal the router needs for them. Classic bots that run on plain
 * user accounts — for example withastro's astrobot-houston comment bot — are
 * typed `User` and are otherwise indistinguishable from humans in a webhook,
 * so they need an explicit list.
 *
 * The `[bot]` login suffix is GitHub's own convention for app accounts; it is
 * checked here as a belt-and-braces fallback for payloads that omit the type
 * field, and it costs nothing because GitHub reserves the suffix for apps.
 */

export const KNOWN_USER_TYPE_BOT_LOGINS: ReadonlySet<string> = new Set([
	'astrobot-houston',
]);

/** True when the author is a bot: a `[bot]` app account or a known bot login. */
export function isBotAuthor(login: string | undefined): boolean {
	if (!login) return false;
	return login.endsWith('[bot]') || KNOWN_USER_TYPE_BOT_LOGINS.has(login);
}
