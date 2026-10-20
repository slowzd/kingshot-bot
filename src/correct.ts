try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

if (process.argv.length > 2) throw new Error("Usage: npm run correct (no arguments).");
const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
if (!token) throw new Error("Set GH_TOKEN or GITHUB_TOKEN locally to a GitHub token with Actions read/write access.");

const now = new Date();
if (now.getUTCHours() < 1 || (now.getUTCHours() === 1 && now.getUTCMinutes() < 1)) {
  throw new Error("Today's daily update can only be corrected at or after 01:01 UTC.");
}
const date = now.toISOString().slice(0, 10);
const repository = "slowzd/kingshot-bot";
const response = await fetch(
  `https://api.github.com/repos/${repository}/actions/workflows/hourly-leaderboard.yml/dispatches`,
  {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kingshot-leaderboard-correction",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { correct: true, correction_date: date } }),
    signal: AbortSignal.timeout(30_000),
  },
);
if (response.status !== 204) {
  throw new Error(`GitHub correction dispatch failed: HTTP ${response.status}. Check token permissions and that the updated workflow is on main.`);
}
console.log(`Correction requested for ${date} UTC. This confirms dispatch, not delivery.`);
console.log("The serialized workflow will fetch Mightpulse, replace today's sample, post to the normal channel, and save shared state.");
console.log(`Check the run result: https://github.com/${repository}/actions/workflows/hourly-leaderboard.yml`);
