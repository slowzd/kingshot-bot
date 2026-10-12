import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
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
    const result = await collect(kingdomNumber);

    if (!result.rows.length) {
      await interaction.editReply(
        `StratForge loaded for Kingdom ${kingdomNumber}, but no alliance rows could be reliably extracted. The site may have changed or require login.`,
      );
      return;
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

    const message = `**Kingdom ${kingdomNumber} — Top 10 Alliances (Ranked by Power)**\n${allianceLines.join("\n")}`;

    await interaction.editReply({
      content: message,
    });
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
