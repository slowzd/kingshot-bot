import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client, GatewayIntentBits, Message } from "discord.js";
import { getConnectedDevice, extractFromEmulator } from "./emulator.js";

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const kingdom = Number(process.env.KINGDOM || 2426);

  console.log("Checking BlueStacks ADB connection...");
  const device = getConnectedDevice();
  if (!device) {
    console.error("No active BlueStacks device detected via ADB!");
    console.log("Please make sure:");
    console.log("1. BlueStacks 5 is open and running.");
    console.log("2. In BlueStacks Settings -> Advanced -> Android Debug Bridge (ADB) is enabled.");
    process.exit(1);
  }

  console.log(`Connected to BlueStacks device: ${device}`);
  console.log("Capturing screenshot from BlueStacks and running OCR...");

  const { alliances, rawText, screenshotPath } = await extractFromEmulator();

  console.log(`\nScreenshot saved to: ${screenshotPath}`);
  console.log("\n--- Raw OCR Text Preview ---");
  console.log(rawText.substring(0, 1000));
  console.log("----------------------------");

  console.log(`\nFound ${alliances.length} parsed alliances:`);
  for (const a of alliances) {
    console.log(`#${a.rank} [${a.tag}] ${a.name} | Power: ${a.power}`);
  }

  if (!token || !channelId) {
    console.log("\nDISCORD_TOKEN or DISCORD_CHANNEL_ID not set in .env. Skipping Discord post.");
    return;
  }

  if (alliances.length === 0) {
    console.warn("\nNo alliances could be parsed from the current emulator screenshot. Skipping Discord post.");
    return;
  }

  const allianceLines = alliances.slice(0, 10).map((r) => {
    const tagPart = r.tag ? `[${r.tag}] ` : "";
    return `#${r.rank} ${tagPart}${r.name} | Power: ${r.power}`;
  });

  const updatedTime = new Date().toLocaleTimeString("da-DK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const messageContent = `**Live Leaderboard — Kingdom ${kingdom} Top 10 Alliances (In-Game Live)**\n${allianceLines.join("\n")}\n\n*Opdateret kl. ${updatedTime} UTC*`;

  console.log(`\nPosting update to Discord channel ${channelId}...`);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);

  const channel = await client.channels.fetch(channelId);
  if (!channel || !("send" in channel)) {
    throw new Error(`Channel ${channelId} not found or is not a text channel.`);
  }

  let sent: Message;
  try {
    sent = await channel.send({
      content: messageContent,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 50013) {
      throw new Error(
        `Discord denied permission to send in channel ${channelId}. Grant the bot View Channel and Send Messages permissions for that channel, then rerun.`,
      );
    }
    throw error;
  }
  console.log(`Sent new Discord message (ID: ${sent.id}).`);

  await client.destroy();
  console.log("Done!");
}

main().catch(console.error);
