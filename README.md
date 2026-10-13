# Kingshot Alliance Power Leaderboard

Posts a Kingshot **Alliance Power** leaderboard to Discord every hour using the Mightpulse API and GitHub Actions. No server, emulator or always-on bot is needed.

## What it posts
Every hour at **XX:01 UTC**:
1. **Alliance Power — Top 10** from `https://api.mightpulse.com/v1/kingdoms/<KINGDOM>/ranks?board=alliance_power&limit=100`.
2. **Cumulative Power Ranking** below it (top 10).

Each counted hour, every alliance gains points equal to the Alliance Power rank it holds (rank 1 = 1 point). Points stack all week and **lowest total wins**. Alliances outside the API's list receive last listed rank + 1 for that hour; an alliance that appears mid-week is backfilled with those points for earlier hours, so it cannot get an unfairly low total.

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
2. Push to the default branch. The schedule starts automatically.
3. Optional: **Actions → Hourly Alliance Leaderboard → Run workflow** posts the current hour immediately, if that hour has not been posted yet.

Weekly standings are saved as `leaderboard.json` on the `leaderboard-state` branch, which the workflow creates and updates itself. Delete that branch to reset the standings.

### Snapshot log
Each posted update also writes `snapshot.ts` to the `leaderboard-state` branch: [view it on GitHub](https://github.com/slowzd/kingshot-stratforge-bot/blob/leaderboard-state/snapshot.ts). It shows which Mightpulse snapshot was used:
- `latest`: update time, when the API was fetched, when Mightpulse captured the data (`apiCapturedAt`), its age in minutes, and every alliance returned (rank, tag, name, power).
- `history`: the same times for the last two weeks of updates, newest first.

The run summary in the **Actions** tab also says which API snapshot time each update used.

### Timing and reliability
GitHub starts the job at XX:01, but GitHub's scheduler can delay runs, sometimes by 10+ minutes, or occasionally drop them. A fallback run at XX:20 posts the hour if the XX:01 run did not; otherwise it does nothing. Each hour is posted and counted **at most once**. A failed API or Discord request does not count the hour; if both runs miss an hour, that hour is skipped for everyone.

Each run takes well under a minute. In a private repository GitHub bills at least one minute per run, about 1,500 minutes a month in total. The Free plan includes 2,000 minutes a month.

Mightpulse decides how fresh its data is. The snapshot log shows when Mightpulse captured the rankings each update used.

## Local commands
Requires Node.js 24 or newer. Put the same variables in a local `.env` file.

- `npm install` – installs the TypeScript tooling (only needed for `check`).
- `npm run preview` – fetches the live API and prints the message without posting or saving.
- `npm start` – posts the current hour to Discord and saves standings to `state/leaderboard.json` and the snapshot log to `state/snapshot.ts`.
- `npm test` – runs the tests.
- `npm run check` – TypeScript type check.
