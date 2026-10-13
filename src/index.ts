import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { publishLeaderboard } from "./leaderboard.js";

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const channelId = process.env.DISCORD_CHANNEL_ID;
const kingdom = Number(process.env.KINGDOM || 2426);

if (!token || !appId || !guildId || !Number.isSafeInteger(kingdom) || kingdom < 1) {
  throw new Error(
    "Set DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID and KINGDOM in .env",
  );
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const leaderboardCommand = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription(
    "Retrieve in-game alliance rankings from Mightpulse",
  );
const postLeaderboardCommand = new SlashCommandBuilder()
  .setName("post-leaderboard")
  .setDescription(
    "Fetch and send the current leaderboard to the configured channel",
  );

await new REST({ version: "10" })
  .setToken(token)
  .put(Routes.applicationGuildCommands(appId, guildId), {
    body: [leaderboardCommand.toJSON(), postLeaderboardCommand.toJSON()],
  });

client.once("clientReady", async () => {
  console.log(
    `Bot online: ${client.user?.tag} | Kingdom ${kingdom} | /leaderboard, /post-leaderboard (Mightpulse API)`,
  );

  if (channelId) {
    try {
      console.log(
        `Fetching initial Mightpulse snapshot for channel ${channelId}...`,
      );
      await postLeaderboardSnapshot(channelId);
    } catch (err) {
      console.warn(
        "Initial startup snapshot skipped:",
        err instanceof Error ? err.message : err,
      );
    }

    startHourlyScheduler(channelId);
  }
});

async function postLeaderboardSnapshot(
  targetChannelId: string,
  scheduledAt?: Date,
): Promise<void> {
  const channel = await client.channels.fetch(targetChannelId);
  if (!channel?.isSendable()) {
    throw new Error(
      `Channel ${targetChannelId} not found or is not a text channel.`,
    );
  }

  await publishLeaderboard(kingdom, async (message) => {
    const sent = await channel.send({
      content: message,
      allowedMentions: { parse: [] },
    });
    console.log(
      `[Snapshot Sent] Posted Mightpulse leaderboard to Discord (Message ID: ${sent.id})`,
    );
  }, scheduledAt);
}

/**
 * Calculates the next hourly update time at UTC :01.
 */
function getNextScheduledTime(): string {
  const hourMs = 60 * 60 * 1000;
  const offsetMs = 60 * 1000;
  const nextTarget = new Date(
    (Math.floor((Date.now() - offsetMs) / hourMs) + 1) * hourMs + offsetMs,
  );
  return nextTarget.toLocaleTimeString("da-DK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/**
 * Automatically triggers a new update at one minute past each UTC hour.
 */
let isRunningUpdate = false;
let lastScheduledSlot = "";

function startHourlyScheduler(targetChannelId: string) {
  console.log(
    `Hourly leaderboard scheduler active (UTC :01). Next scheduled update at ~${getNextScheduledTime()} UTC`,
  );

  setInterval(async () => {
    const now = new Date();
    const minute = now.getUTCMinutes();

    if (minute === 1) {
      const slotKey = now.toISOString().slice(0, 16);

      if (lastScheduledSlot !== slotKey && !isRunningUpdate) {
        lastScheduledSlot = slotKey;
        isRunningUpdate = true;
        const timeStr = now.toLocaleTimeString("da-DK", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "UTC",
        });
        console.log(
          `\n[Hourly Trigger: ${timeStr} UTC] Starting hourly scheduled update...`,
        );

        try {
          await postLeaderboardSnapshot(targetChannelId, now);
        } catch (err) {
          console.error("Scheduled hourly update failed:", err);
        } finally {
          isRunningUpdate = false;
          console.log(
            `Next scheduled update at ~${getNextScheduledTime()} UTC`,
          );
        }
      }
    }
  }, 2000); // Check clock every 2 seconds
}

client.on("interactionCreate", async (interaction) => {
  if (
    !interaction.isChatInputCommand() ||
    !["leaderboard", "post-leaderboard"].includes(interaction.commandName)
  )
    return;
  try {
    if (interaction.commandName === "post-leaderboard") {
      await interaction.deferReply({ ephemeral: true });
      if (!channelId) {
        await interaction.editReply(
          "DISCORD_CHANNEL_ID is not configured, so I cannot post the leaderboard.",
        );
        return;
      }

      await postLeaderboardSnapshot(channelId);
      await interaction.editReply(
        "The current Mightpulse leaderboard snapshot was sent to the configured Discord channel.",
      );
      return;
    }

    await interaction.deferReply();
    let firstMessage = true;
    await publishLeaderboard(kingdom, async (message) => {
      const options = {
        content: message,
        allowedMentions: { parse: [] },
      };
      if (firstMessage) {
        await interaction.editReply(options);
        firstMessage = false;
      } else {
        await interaction.followUp(options);
      }
    });
  } catch (error) {
    console.error(error);
    const message = `Unable to retrieve in-game rankings: ${error instanceof Error ? error.message : String(error)}`;
    if (interaction.deferred || interaction.replied)
      await interaction.editReply(message).catch(console.error);
    else
      await interaction
        .reply({ content: message, ephemeral: true })
        .catch(console.error);
  }
});

await client.login(token);
