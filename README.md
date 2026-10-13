# Kingshot Alliance Power Leaderboard

Posts a Kingshot **Alliance Power** leaderboard to Discord every hour using the Mightpulse API and GitHub Actions. No server, emulator or always-on bot is needed.

## What it posts
Every time the workflow runs (normally every hour at **XX:01 UTC**):
1. **Alliance Power — Top 10** from `https://api.mightpulse.com/v1/kingdoms/<KINGDOM>/ranks?board=alliance_power&limit=100`.
2. **Cumulative Power Ranking** below it (top 10).

Each run, every alliance gains points equal to the Alliance Power rank it holds (rank 1 = 1 point). Points stack all week and **lowest total wins**. Alliances outside the API's list receive last listed rank + 1 for that run; an alliance that appears mid-week is backfilled with those points for earlier runs, so it cannot get an unfairly low total.

## Weekly cycle (UTC)
- **Monday 01:01** – a new cumulative ranking starts.
- Every hour after that, points are added and the leaderboard is posted.
- **Monday 00:01** – the last hour of the week is counted and a **Weekly Final** is posted with last week's cumulative ranking.
- **Monday 01:01** – the next week starts from zero.

If the Monday 00:01 run is missed entirely, the next run posts the weekly final first and then starts the new week.

## GitHub Actions setup
The workflow is [.github/workflows/hourly-leaderboard.yml](.github/workflows/hourly-leaderboard.yml).

1. In the repository go to **Settings → Secrets and variables → Actions** and add:
   - `DISCORD_TOKEN` – bot token (the bot needs View Channel and Send Messages in the channel)
   - `DISCORD_CHANNEL_ID` – channel to post in
   - `MIGHTPULSE_API_KEY` – Mightpulse API key
   - `KINGDOM` – optional, defaults to `2426`
2. Create a GitHub token with access to this repository and **Actions: Read and write** (or a classic token with the `repo` and `workflow` scopes).
3. On [cron-job.org](https://cron-job.org), create a job that runs every hour at minute 1:
   - URL: `https://api.github.com/repos/slowzd/kingshot-bot/actions/workflows/hourly-leaderboard.yml/dispatches`
   - Request method: `POST`, body: `{"ref":"main"}`
   - Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `Content-Type: application/json`, `User-Agent: kingshot-leaderboard-cron`
   - Leave "Requires HTTP authentication" off. A successful test run returns `204 No Content`.
4. Optional: **Actions → Hourly Alliance Leaderboard → Run workflow** posts immediately.

Weekly standings are saved as `leaderboard.json` on the `leaderboard-state` branch, which the workflow creates and updates itself. Delete that branch to reset the standings.

### Snapshot log
Each posted update also writes `snapshot.ts` to the `leaderboard-state` branch: [view it on GitHub](https://github.com/slowzd/kingshot-bot/blob/leaderboard-state/snapshot.ts). It shows which Mightpulse snapshot was used:
- `latest`: update time, when the API was fetched, when Mightpulse captured the data (`apiCapturedAt`), its age in minutes, and every alliance returned (rank, tag, name, power).
- `history`: the same times for the last two weeks of updates, newest first.

The run summary in the **Actions** tab also says which API snapshot time each update used.

### Timing and reliability
GitHub's own scheduler delayed or dropped runs, so the workflow has no `schedule:` and is started by cron-job.org instead. **Every run posts and adds points**, so extra runs in the same hour (for example a manual **Run workflow**) post again and count again. Keep exactly one hourly trigger to avoid uneven scoring. A failed API or Discord request does not count.

Each run takes well under a minute. Public repositories get unlimited free Actions minutes.

Mightpulse decides how fresh its data is. The snapshot log shows when Mightpulse captured the rankings each update used.

## Local commands
Requires Node.js 24 or newer. Put the same variables in a local `.env` file.

- `npm install` – installs the TypeScript tooling (only needed for `check`).
- `npm run preview` – fetches the live API and prints the message without posting or saving.
- `npm start` – posts to Discord and saves standings to `state/leaderboard.json` and the snapshot log to `state/snapshot.ts`.
- `npm test` – runs the tests.
- `npm run check` – TypeScript type check.
