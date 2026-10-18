import fs from "node:fs";
import path from "node:path";
import { sendDiscordMessage } from "./discord.ts";
import { runDailyUpdate } from "./daily.ts";
import { fetchPowerSnapshot } from "./mightpulse.ts";

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dry-run" && arg !== "--force")) {
  throw new Error("Supported options are --dry-run and --force.");
}
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
if (force) console.log("Forced test: bypassing daily guards without saving standings or snapshot history.");

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

const kingdom = Number(process.env.KINGDOM || 2426);
if (!Number.isSafeInteger(kingdom) || kingdom < 1) throw new Error("KINGDOM must be a positive integer.");
const apiKey = env("MIGHTPULSE_API_KEY");
const token = dryRun ? "" : env("DISCORD_TOKEN");
const channelId = dryRun ? "" : force ? "1561449272690344068" : env("DISCORD_CHANNEL_ID");
if (!dryRun) console.log(`Discord destination: ${channelId}${force ? " (test channel)" : ""}.`);

const result = await runDailyUpdate({
  now: new Date(),
  kingdom,
  stateFile: path.resolve(process.env.STATE_FILE || "state/leaderboard.json"),
  snapshotFile: path.resolve(process.env.SNAPSHOT_FILE || "state/snapshot.ts"),
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
  force,
});
if (result.status !== "posted") {
  const summary = result.status === "weekly-posted"
    ? `Kingdom ${kingdom} weekly cumulative ranking ${dryRun ? "previewed" : force ? "test posted (not saved)" : "posted"} without adding points or changing the daily posting timestamp.`
    : `Kingdom ${kingdom} update skipped: ${result.reason}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
} else {
  const used = result.snapshotUsed;
  const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
  const age = `${Math.floor(used.apiAgeMinutes / 60)}h ${used.apiAgeMinutes % 60}m`;
  const summary = `Kingdom ${kingdom} update ${utc(used.update)} ${dryRun ? "previewed" : force ? "test posted (not saved)" : "posted"} using Mightpulse snapshot captured ${utc(used.apiCapturedAt)} (${age} old).`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
