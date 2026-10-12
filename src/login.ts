import "dotenv/config";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { getSessionPath, sessionPath } from "./session.js";

const kingdom = Number(process.env.KINGDOM || 2426);
if (!Number.isInteger(kingdom) || kingdom < 1) {
  throw new Error("KINGDOM must be a positive integer.");
}

const browser = await chromium.launch({ headless: false });
const terminal = createInterface({ input: stdin, output: stdout });
try {
  const storageState = await getSessionPath();
  const context = await browser.newContext({ storageState });
  console.log(
    storageState
      ? "Loaded the saved StratForge session. Check whether you are still logged in."
      : "No saved StratForge session found. Sign in once to create it.",
  );
  const page = await context.newPage();
  await page.goto(`https://stratforge.tools/k/${kingdom}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await terminal.question(
    "If needed, log in to StratForge using Discord in the browser. Return to StratForge and confirm you are logged in, then press Enter here to save the session. Do not close the browser before saving. ",
  );
  if (!context.pages().some((openPage) =>
    new URL(openPage.url()).origin === "https://stratforge.tools"
  )) {
    throw new Error("Return to StratForge before saving the session.");
  }
  const state = await context.storageState({ indexedDB: true });
  // Save only StratForge state, not credentials from the Discord login flow.
  state.cookies = state.cookies.filter((cookie) =>
    cookie.domain.replace(/^\./, "") === "stratforge.tools"
  );
  state.origins = state.origins.filter((origin) =>
    origin.origin === "https://stratforge.tools"
  );
  if (!state.cookies.length && !state.origins.length) {
    throw new Error("No StratForge session data found. Log in and run npm run login again.");
  }
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, JSON.stringify(state), { mode: 0o600 });
  console.log("StratForge session saved. The bot will use it on the next /leaderboard request.");
} finally {
  terminal.close();
  await browser.close();
}
