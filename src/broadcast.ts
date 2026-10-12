import "dotenv/config";
import { Client, GatewayIntentBits, Message } from "discord.js";
import { collect } from "./scraper.js";

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const kingdom = Number(process.env.KINGDOM || 2426);

if (!token || !channelId) {
  throw new Error("DISCORD_TOKEN and DISCORD_CHANNEL_ID must be set in environment variables.");
}

console.log(`Starting broadcast for Kingdom ${kingdom} to channel ${channelId}...`);

const result = await collect(kingdom);

if (!result.rows.length) {
  console.error("No alliance rows could be extracted from StratForge.");
  process.exit(1);
}

// Sorter alliancerne efter total Power (højeste først) og tildel nye ranks 1..N
const sortedAlliances = [...result.rows]
  .sort((a, b) => b.powerValue - a.powerValue || b.combatPowerValue - a.combatPowerValue)
  .map((alliance, index) => ({
    ...alliance,
    displayRank: index + 1,
  }));

const topAlliances = sortedAlliances.slice(0, 10);
const allianceLines = topAlliances.map(
  (r) =>
    `#${r.displayRank} [${r.tag}] ${r.name} | Power: ${r.power ?? "Unavailable"} | Combat power: ${r.realPower ?? "Unavailable"} | Members: ${r.members ?? "Unavailable"}`,
);

const updatedTime = new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
const message = `**Live Leaderboard — Kingdom ${kingdom} Top 10 Alliances (Ranked by Power)**\n${allianceLines.join("\n")}\n\n*Opdateret kl. ${updatedTime}*`;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

await client.login(token);

const channel = await client.channels.fetch(channelId);
if (!channel || !("send" in channel)) {
  throw new Error(`Channel ${channelId} not found or is not a text channel.`);
}

let sent: Message;
try {
  sent = await channel.send(message);
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
