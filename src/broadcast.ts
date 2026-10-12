import "dotenv/config";
import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { collect } from "./scraper.js";

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const kingdom = Number(process.env.KINGDOM || 2426);

if (!token || !channelId) {
  throw new Error("DISCORD_TOKEN and DISCORD_CHANNEL_ID must be set in environment variables.");
}

console.log(`Starting scheduled broadcast for Kingdom ${kingdom} to channel ${channelId}...`);

const result = await collect(kingdom);

if (!result.rows.length) {
  console.error("No alliance rows could be extracted from StratForge.");
  process.exit(1);
}

const topAlliances = [...result.rows]
  .sort((a, b) => a.rank - b.rank)
  .slice(0, 10);

const url = `https://stratforge.tools/k/${kingdom}`;
const lines = [
  `StratForge Kingdom ${kingdom} — Alliance listing`,
  `Retrieved: ${new Date().toISOString()}`,
  `Source: ${url}`,
  "Only rows available to this session; missing power values are not zero.",
  "",
  ...topAlliances.map(
    (r) =>
      `#${r.rank} [${r.tag}] ${r.name} | Power: ${r.power ?? "Unavailable"} | Combat power: ${r.realPower ?? "Unavailable"} | Members: ${r.members ?? "Unavailable"}`,
  ),
];

await mkdir("snapshots", { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = path.join("snapshots", `kingdom-${kingdom}-${timestamp}.txt`);
await writeFile(filename, lines.join("\n"), "utf8");

const preview = lines.slice(5).join("\n");
const message = `**Daily Update — Kingdom ${kingdom} StratForge Alliances (top 10)**\n${preview}\n\nShowing ${topAlliances.length} available alliances.\nSource: ${url}`;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

await client.login(token);

const channel = await client.channels.fetch(channelId);
if (!channel || !("send" in channel)) {
  throw new Error(`Channel ${channelId} not found or is not a text channel.`);
}

await channel.send({
  content: message,
  files: [new AttachmentBuilder(filename)],
});

console.log("Message successfully posted to Discord.");
await client.destroy();
process.exit(0);
