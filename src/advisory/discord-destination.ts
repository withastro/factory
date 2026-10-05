/**
 * The Discord channel advisory triage posts to. Configured on the Worker,
 * not in the repository: the bot token is a secret, and the channel belongs
 * to the team running Factory rather than to any one repository.
 */

export interface DiscordDestination {
	botToken: string;
	channelId: string;
}

export function discordDestinationFromEnv(env: {
	DISCORD_BOT_TOKEN?: string;
	DISCORD_SECURITY_CHANNEL_ID?: string;
}): DiscordDestination | undefined {
	const botToken = env.DISCORD_BOT_TOKEN?.trim();
	const channelId = env.DISCORD_SECURITY_CHANNEL_ID?.trim();
	if (!botToken || !channelId) return undefined;
	if (!/^\d{1,25}$/.test(channelId)) {
		throw new Error(
			'DISCORD_SECURITY_CHANNEL_ID must be a Discord channel id.',
		);
	}
	return { botToken, channelId };
}
