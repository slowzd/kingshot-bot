import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Message,
} from "discord.js";
import {
  extractFromEmulator,
  getConnectedDevice,
  captureScreenshot,
  isLeaderboardScreen,
} from "./emulator.js";

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const channelId = process.env.DISCORD_CHANNEL_ID;
const kingdom = Number(process.env.KINGDOM || 2426);

if (!token || !appId || !guildId || !Number.isInteger(kingdom) || kingdom < 1) {
  throw new Error(
    "Set DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID and KINGDOM in .env",
  );
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const command = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Retrieve in-game alliance rankings from BlueStacks emulator");

await new REST({ version: "10" })
  .setToken(token)
  .put(Routes.applicationGuildCommands(appId, guildId), {
    body: [command.toJSON()],
  });

client.once("clientReady", async () => {
  console.log(
    `Bot online: ${client.user?.tag} | Kingdom ${kingdom} | /leaderboard (BlueStacks mode)`,
  );

  if (channelId) {
    // 1. Post initial snapshot on startup if BlueStacks has the leaderboard open
    try {
      console.log(`Checking emulator on startup to post initial snapshot to channel ${channelId}...`);
      await postLeaderboardSnapshot(channelId, true);
    } catch (err) {
      console.warn("Initial startup snapshot skipped:", err instanceof Error ? err.message : err);
    }

    // 2. Start 15-minute scheduler (:00, :15, :30, :45 of every hour)
    start15MinuteScheduler(channelId);
  }
});

/**
 * Captures the screen, parses rankings, and sends a snapshot message to Discord.
 */
async function postLeaderboardSnapshot(targetChannelId: string, silentIfNoScreen = false): Promise<boolean> {
  const device = getConnectedDevice();
  if (!device) {
    if (!silentIfNoScreen) {
      console.warn("BlueStacks device offline.");
    }
    return false;
  }

  const screenshotPath = path.resolve(`snapshots/bluestacks-capture-${Date.now()}.png`);
  await captureScreenshot(screenshotPath);

  const isLeaderboard = await isLeaderboardScreen(screenshotPath);
  if (!isLeaderboard) {
    if (!silentIfNoScreen) {
      console.log("BlueStacks is open, but not currently on the Alliance Leaderboard screen.");
    }
    // Clean up non-leaderboard snapshot
    if (fs.existsSync(screenshotPath)) fs.unlink(screenshotPath, () => {});
    return false;
  }

  const { alliances } = await extractFromEmulator(screenshotPath);
  if (!alliances.length) {
    console.warn("On leaderboard screen, but could not parse alliance rows.");
    return false;
  }

  const allianceLines = alliances.slice(0, 10).map((r) => {
    const tagPart = r.tag ? `[${r.tag}] ` : "";
    return `#${r.rank} ${tagPart}${r.name} | Power: ${r.power}`;
  });

  const updatedTime = new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
  const messageContent = `**Live Leaderboard — Kingdom ${kingdom} Top 10 Alliances (In-Game Live)**\n${allianceLines.join("\n")}\n\n*Opdateret kl. ${updatedTime}*`;

  const channel = await client.channels.fetch(targetChannelId);
  if (!channel || !("send" in channel)) {
    console.error(`Channel ${targetChannelId} not found or is not a text channel.`);
    return false;
  }

  try {
    const sent: Message = await channel.send({
      content: messageContent,
    });
    console.log(`[Snapshot Sent] Posted fresh leaderboard to Discord (Message ID: ${sent.id})`);
    return true;
  } catch (error) {
    console.error("Failed to post message to Discord:", error);
    return false;
  }
}

/**
 * Calculates the next scheduled quarter-hour mark string (e.g. "00:15", "00:30", "00:45", "01:00").
 */
function getNextScheduledTime(): string {
  const now = new Date();
  const minutes = now.getMinutes();
  const remainder = 15 - (minutes % 15);
  const nextTarget = new Date(
    now.getTime() + (remainder * 60 - now.getSeconds()) * 1000 - now.getMilliseconds(),
  );
  return nextTarget.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Automatically triggers a new update every 15 minutes (:00, :15, :30, :45 of every hour).
 */
let isRunningUpdate = false;
let lastScheduledSlot = "";

function start15MinuteScheduler(targetChannelId: string) {
  console.log(
    `15-minute leaderboard scheduler active (:00, :15, :30, :45 of every hour). Next scheduled update at ~${getNextScheduledTime()}`,
  );

  setInterval(async () => {
    const now = new Date();
    const minute = now.getMinutes();

    // Trigger on every 15-minute mark: 0, 15, 30, 45
    if (minute % 15 === 0) {
      const slotKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${minute}`;

      if (lastScheduledSlot !== slotKey && !isRunningUpdate) {
        lastScheduledSlot = slotKey;
        isRunningUpdate = true;
        const timeStr = now.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
        console.log(`\n[Quarter-Hour Trigger: ${timeStr}] Starting 15-minute scheduled update...`);

        try {
          await postLeaderboardSnapshot(targetChannelId, false);
        } catch (err) {
          console.error("Scheduled 15-minute update failed:", err);
        } finally {
          isRunningUpdate = false;
          console.log(`Next scheduled update at ~${getNextScheduledTime()}`);
        }
      }
    }
  }, 2000); // Check clock every 2 seconds
}

client.on("interactionCreate", async (interaction) => {
  if (
    !interaction.isChatInputCommand() ||
    interaction.commandName !== "leaderboard"
  )
    return;
  try {
    await interaction.deferReply();
    const device = getConnectedDevice();
    if (!device) {
      await interaction.editReply(
        "BlueStacks is not connected or ADB is offline. Please ensure BlueStacks 5 is open with ADB enabled and Kingshot is on the leaderboard screen.",
      );
      return;
    }

    const { alliances, screenshotPath } = await extractFromEmulator();

    if (!alliances.length) {
      await interaction.editReply(
        "Could not detect alliance rankings on the BlueStacks screen. Make sure the in-game Alliance Leaderboard is currently visible.",
      );
      return;
    }

    const topAlliances = alliances.slice(0, 10);
    const allianceLines = topAlliances.map((r) => {
      const tagPart = r.tag ? `[${r.tag}] ` : "";
      return `#${r.rank} ${tagPart}${r.name} | Power: ${r.power}`;
    });

    const updatedTime = new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
    const message = `**Kingdom ${kingdom} — Top 10 Alliances (In-Game Live)**\n${allianceLines.join("\n")}\n\n*Opdateret kl. ${updatedTime}*`;

    await interaction.editReply({
      content: message,
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
