import fs from "node:fs";
import path from "node:path";
import { sendDiscordMessage } from "./discord.ts";
import { fetchActiveGiftCodes, runGiftCodeUpdate } from "./gift-codes.ts";

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dry-run")) throw new Error("Supported option is --dry-run.");
const dryRun = args.includes("--dry-run");

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

const channelId = env("DISCORD_CODES_CHANNEL_ID");
const token = dryRun ? "" : env("DISCORD_TOKEN");
const result = await runGiftCodeUpdate({
  channelId,
  stateFile: path.resolve(process.env.GIFT_CODES_STATE_FILE || "state/gift-codes.json"),
  fetchCodes: () => fetchActiveGiftCodes(new Date()),
  send: async (message) => {
    if (dryRun) {
      console.log(JSON.stringify(message, null, 2));
      return;
    }
    const id = await sendDiscordMessage(token, channelId, message);
    console.log(`Posted gift-code Discord message ${id}.`);
  },
  dryRun,
});
const summary = `Gift codes ${result.status}: ${result.count} active code(s).`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
