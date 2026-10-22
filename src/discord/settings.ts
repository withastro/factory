/**
 * Worker-level settings for the Discord assistant.
 *
 * These live on the Worker rather than in a repository's factory.yml: the bot
 * token is a secret, and the Discord server, its roles, and which repository
 * the assistant works on belong to the team running Factory.
 */

const SNOWFLAKE = /^\d{1,25}$/;
const REPOSITORY = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

export interface DiscordAssistantSettings {
	botToken: string;
	/** The one Discord server the assistant answers in. */
	guildId: string;
	/** Members need at least one of these roles to use the assistant. */
	allowedRoleIds: readonly string[];
	/**
	 * Channels the assistant answers in (a thread counts as its parent
	 * channel). Empty means every channel in the server.
	 */
	channelIds: readonly string[];
	/** The repository the assistant reads, files issues on, and opens pull requests against. */
	owner: string;
	repo: string;
}

export interface DiscordAssistantEnv {
	DISCORD_BOT_TOKEN?: string;
	DISCORD_GUILD_ID?: string;
	DISCORD_ALLOWED_ROLE_IDS?: string;
	DISCORD_ASSISTANT_CHANNEL_IDS?: string;
	DISCORD_REPOSITORY?: string;
}

/**
 * The assistant's settings, or `undefined` when it isn't configured. The
 * role allowlist is required: without it, anyone in the server could spend
 * model tokens and create issues.
 */
export function discordAssistantSettingsFromEnv(
	env: DiscordAssistantEnv,
): DiscordAssistantSettings | undefined {
	const botToken = env.DISCORD_BOT_TOKEN?.trim();
	const guildId = env.DISCORD_GUILD_ID?.trim();
	const allowedRoleIds = parseIdList(env.DISCORD_ALLOWED_ROLE_IDS);
	const repository = env.DISCORD_REPOSITORY?.trim();
	if (!botToken || !guildId || allowedRoleIds.length === 0 || !repository) {
		return undefined;
	}
	if (!SNOWFLAKE.test(guildId)) {
		throw new Error('DISCORD_GUILD_ID must be a Discord server id.');
	}
	const match = REPOSITORY.exec(repository);
	if (!match) {
		throw new Error('DISCORD_REPOSITORY must look like "owner/repo".');
	}
	return {
		botToken,
		guildId,
		allowedRoleIds,
		channelIds: parseIdList(env.DISCORD_ASSISTANT_CHANNEL_IDS),
		owner: match[1] as string,
		repo: match[2] as string,
	};
}

function parseIdList(value: string | undefined): string[] {
	const ids = (value ?? '')
		.split(/[\s,]+/)
		.map((id) => id.trim())
		.filter(Boolean);
	for (const id of ids) {
		if (!SNOWFLAKE.test(id)) {
			throw new Error(`Invalid Discord id in settings: ${JSON.stringify(id)}.`);
		}
	}
	return ids;
}

/** True when a member holding `roles` may use the assistant. */
export function isAllowedMember(
	settings: Pick<DiscordAssistantSettings, 'allowedRoleIds'>,
	roles: readonly string[] | undefined,
): boolean {
	if (!roles?.length) return false;
	return roles.some((role) => settings.allowedRoleIds.includes(role));
}
