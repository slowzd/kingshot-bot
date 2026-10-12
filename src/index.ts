import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
} from "discord.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { collect } from "./scraper.js";

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const kingdom = Number(process.env.KINGDOM || 2426);

if (!token || !appId || !guildId || !Number.isInteger(kingdom) || kingdom < 1) {
  throw new Error(
    "Set DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID and KINGDOM in .env",
  );
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const command = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Retrieve available StratForge alliances")
  .addIntegerOption((option) =>
    option
      .setName("kingdom")
      .setDescription(`Kingdom number (defaults to ${kingdom})`)
      .setRequired(false)
      .setMinValue(1),
  );
await new REST({ version: "10" })
  .setToken(token)
  .put(Routes.applicationGuildCommands(appId, guildId), {
    body: [command.toJSON()],
  });
client.once("clientReady", () =>
  console.log(
    `Bot online: ${client.user?.tag} | Kingdom ${kingdom} | /leaderboard`,
  ),
);
client.on("interactionCreate", async (interaction) => {
  if (
    !interaction.isChatInputCommand() ||
    interaction.commandName !== "leaderboard"
  )
    return;
  try {
    await interaction.deferReply();
    const kingdomNumber = interaction.options.getInteger("kingdom") ?? kingdom;
    const url = `https://stratforge.tools/k/${kingdomNumber}`;
    const result = await collect(kingdomNumber);
    await mkdir("snapshots", { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const topAlliances = [...result.rows]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 10);
    const lines = [
      `StratForge Kingdom ${kingdomNumber} — Alliance listing`,
      `Retrieved: ${new Date().toISOString()}`,
      `Source: ${url}`,
      "Only rows available to this session; missing power values are not zero.",
      "",
      ...topAlliances.map(
        (r) =>
          `#${r.rank} [${r.tag}] ${r.name} | Power: ${r.power ?? "Unavailable"} | Combat power: ${r.realPower ?? "Unavailable"} | Members: ${r.members ?? "Unavailable"}`,
      ),
    ];
    if (!result.rows.length) {
      const diagnostic = path.join("snapshots", `diagnostic-${timestamp}.txt`);
      await writeFile(
        diagnostic,
        `URL: ${url}\nTITLE: ${result.title}\nSECTION:\n${result.section}`,
        "utf8",
      );
      await interaction.editReply(
        `StratForge loaded for Kingdom ${kingdomNumber}, but no alliance rows could be reliably extracted. Diagnostic saved: ${diagnostic}. The site may have changed or require login.`,
      );
      return;
    }
    const filename = path.join(
      "snapshots",
      `kingdom-${kingdomNumber}-${timestamp}.txt`,
    );
    await writeFile(filename, lines.join("\n"), "utf8");
    const preview = lines.slice(5).join("\n");
    await interaction.editReply({
      content: `**Kingdom ${kingdomNumber} — StratForge alliances (top 10)**\n${preview}\n\nShowing ${topAlliances.length} available alliance${topAlliances.length === 1 ? "" : "s"}; additional rows depend on your StratForge access.\nSource: ${url}`,
      files: [new AttachmentBuilder(filename)],
    });
    console.log(`Saved ${filename}`);
  } catch (error) {
    console.error(error);
    const message = `Unable to retrieve StratForge rankings: ${error instanceof Error ? error.message : String(error)}`;
    if (interaction.deferred || interaction.replied)
      await interaction.editReply(message).catch(console.error);
    else
      await interaction
        .reply({ content: message, ephemeral: true })
        .catch(console.error);
  }
});
await client.login(token);
