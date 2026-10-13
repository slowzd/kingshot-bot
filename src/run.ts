import path from "node:path";
import { sendDiscordMessage } from "./discord.ts";
import { runHourlyUpdate } from "./hourly.ts";
import { fetchPowerSnapshot } from "./mightpulse.ts";

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dry-run")) {
  throw new Error("The only supported option is --dry-run.");
}
const dryRun = args.includes("--dry-run");

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

const kingdom = Number(process.env.KINGDOM || 2426);
if (!Number.isSafeInteger(kingdom) || kingdom < 1) throw new Error("KINGDOM must be a positive integer.");
const apiKey = env("MIGHTPULSE_API_KEY");
const token = dryRun ? "" : env("DISCORD_TOKEN");
const channelId = dryRun ? "" : env("DISCORD_CHANNEL_ID");

const result = await runHourlyUpdate({
  now: new Date(),
  kingdom,
  stateFile: path.resolve(process.env.STATE_FILE || "state/leaderboard.json"),
  fetchSnapshot: () => fetchPowerSnapshot(kingdom, apiKey),
  send: async (content) => {
    if (dryRun) {
      console.log(`${content}\n`);
      return;
    }
    const id = await sendDiscordMessage(token, channelId, content);
    console.log(`Posted Discord message ${id}.`);
  },
  dryRun,
});
console.log(result === "posted" ? `Kingdom ${kingdom} leaderboard ${dryRun ? "previewed" : "posted"}.` : "Nothing to do.");
