import "dotenv/config";
import fs from "node:fs";
import { Client, GatewayIntentBits, Message } from "discord.js";
import { getConnectedDevice, extractFromEmulator } from "./emulator.js";

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const kingdom = Number(process.env.KINGDOM || 2426);

if (!token || !channelId) {
  throw new Error("DISCORD_TOKEN and DISCORD_CHANNEL_ID must be set in environment variables.");
}

console.log(`Starting broadcast for Kingdom ${kingdom} from BlueStacks emulator to channel ${channelId}...`);

const device = getConnectedDevice();
if (!device) {
  console.error("No active BlueStacks device detected via ADB!");
  console.error("Make sure BlueStacks 5 is open, ADB is enabled in Settings -> Advanced, and Kingshot is on the leaderboard screen.");
  process.exit(1);
}

console.log(`Connected to BlueStacks device: ${device}`);
console.log("Extracting leaderboard data from emulator screen...");

const { alliances, screenshotPath } = await extractFromEmulator();

if (!alliances.length) {
  console.error(`No alliance rows could be parsed from the emulator screenshot (${screenshotPath}).`);
  process.exit(1);
}

const topAlliances = alliances.slice(0, 10);
const allianceLines = topAlliances.map((r) => {
  const tagPart = r.tag ? `[${r.tag}] ` : "";
  return `#${r.rank} ${tagPart}${r.name} | Power: ${r.power}`;
});

const updatedTime = new Date().toLocaleTimeString("da-DK", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const message = `**Live Leaderboard — Kingdom ${kingdom} Top 10 Alliances (In-Game Live)**\n${allianceLines.join("\n")}\n\n*Opdateret kl. ${updatedTime} UTC*`;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

await client.login(token);

const channel = await client.channels.fetch(channelId);
if (!channel || !("send" in channel)) {
  throw new Error(`Channel ${channelId} not found or is not a text channel.`);
}

let sent: Message;
try {
  sent = await channel.send({
    content: message,
  });
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === 50013) {
    throw new Error(
      `Discord denied permission to send in channel ${channelId}. Grant the bot View Channel and Send Messages permissions for that channel, then rerun the workflow.`,
    );
  }
  throw error;
}
console.log(`Sent new message (ID: ${sent.id}).`);

await client.destroy();
process.exit(0);
