import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { publishLeaderboard } from "./leaderboard.js";

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const kingdom = Number(process.env.KINGDOM || 2426);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--scheduled")) {
  throw new Error("Only the optional --scheduled broadcast argument is supported.");
}
const scheduledAt = args.includes("--scheduled") ? new Date() : undefined;

if (!token || !channelId || !Number.isSafeInteger(kingdom) || kingdom < 1) {
  throw new Error("Set DISCORD_TOKEN, DISCORD_CHANNEL_ID and a positive integer KINGDOM.");
}

console.log(`Starting Mightpulse broadcast for Kingdom ${kingdom} to channel ${channelId}...`);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
try {
  await client.login(token);
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) {
    throw new Error(`Channel ${channelId} not found or is not a text channel.`);
  }

  await publishLeaderboard(kingdom, async (message) => {
    try {
      const sent = await channel.send({
        content: message,
        allowedMentions: { parse: [] },
      });
      console.log(`Sent new message (ID: ${sent.id}).`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 50013) {
        throw new Error(
          `Discord denied permission to send in channel ${channelId}. Grant the bot View Channel and Send Messages permissions, then rerun the broadcast.`,
          { cause: error },
        );
      }
      throw error;
    }
  }, scheduledAt);
} finally {
  await client.destroy();
}
