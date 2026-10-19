# Kingshot Alliance Power Leaderboard

Posts a Kingshot **Alliance Power** leaderboard to Discord once daily at **01:01 UTC**, plus a cumulative-only weekly summary on **Monday at 00:01 UTC**, using the Mightpulse API and GitHub Actions. An hourly cron-job checks whether a post is due. No server, emulator or always-on bot is needed.

## What it posts
When the daily update is due:
1. **Alliance Power — Top 10** from `https://api.mightpulse.com/v1/kingdoms/<KINGDOM>/ranks?board=alliance_power&limit=100`.
2. **Daily Cumulative Ranking** below it (top 10).

Each successful daily update records the power of every alliance returned by the API (up to 100). **Average power = sum of observed daily power / number of daily observations**, with the highest average ranked first. Missing days do not count as zero; missed workflow runs add no samples.

Only alliances that reached the daily **top 10 at least once that week** qualify for the cumulative ranking, which displays the 10 highest averages. Their earlier observations outside the top 10 still count toward their average. After qualifying, an alliance remains eligible even if it drops out of the top 10 or disappears from the API; days absent from the API leave its average unchanged. An alliance observed for only one day has that day's power as its average and can rank immediately. Eligibility does not guarantee a displayed place if ten other qualifying alliances have higher averages. Equal averages are ordered by alliance ID; displayed averages use up to two decimal places.

## Weekly cycle (UTC)
- Each day at **01:01**, a power sample is recorded and Alliance Power plus **Daily Cumulative Ranking** are posted.
- **Sunday 01:01** – the last daily sample of the week is recorded as a normal daily update.
- **Monday 00:01** – **Weekly Cumulative Ranking** summarizes the completed week's saved average power. It contains no Alliance Power section, fetches no API data, and adds no samples.
- **Monday 01:01** – the next daily week starts with fresh power totals, observation counts, and top-10 eligibility.

The weekly summary is separate from daily slot protection: it neither checks nor changes the last daily posting timestamp. It is saved as posted so repeated hourly checks do not send it again. Once the summary is published, that week's averages are closed.

If Monday's 00:01 run is missed, the next run posts the saved weekly summary first. If a daily update is also eligible, it then posts separately and starts the new week. Only the daily update adds power samples. Failed weekly deliveries can be retried; a successfully saved summary is not repeated if the following daily API request fails.

## GitHub Actions setup
The workflow is [.github/workflows/hourly-leaderboard.yml](.github/workflows/hourly-leaderboard.yml).

1. In the repository go to **Settings → Secrets and variables → Actions** and add:
   - `DISCORD_TOKEN` – bot token (the bot needs View Channel and Send Messages in the channel)
   - `DISCORD_CHANNEL_ID` – channel to post in
   - `MIGHTPULSE_API_KEY` – Mightpulse API key
   - `KINGDOM` – optional, defaults to `2426`
2. Create a GitHub token with access to this repository and **Actions: Read and write** (or a classic token with the `repo` and `workflow` scopes).
3. On [cron-job.org](https://cron-job.org), create a job that runs every hour at minute 1:
   - Schedule: **Custom** → crontab expression `1 * * * *` (XX:01 every hour)
   - URL: `https://api.github.com/repos/slowzd/kingshot-bot/actions/workflows/hourly-leaderboard.yml/dispatches`
   - Request method: `POST`, body: `{"ref":"main"}`
   - Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `Content-Type: application/json`, `User-Agent: kingshot-leaderboard-cron`
   - Leave "Requires HTTP authentication" off. A successful test run returns `204 No Content`.
4. Optional: **Actions → Daily Alliance Leaderboard → Run workflow** checks immediately. Manual runs obey the same daily slot protection; they do not force a post.

Weekly standings are saved as `leaderboard.json` on the `leaderboard-state` branch, which the workflow creates and updates itself. Delete that branch to reset the standings.

Existing version-1 point-based standings finish their current week with the old scoring and `pts` display, including the Monday 00:01 weekly summary. At the next Monday daily reset, version-2 standings start tracking average power. Old points are not converted into power samples. The last saved slot prevents duplicate posts during migration. Deleting the state branch also clears duplicate protection.

There is no elapsed-time cooldown. A late Sunday update does not block Monday's 01:01 average-power update, and late daily updates never delay the next day's slot.

### Snapshot log
Each posted daily update also writes `snapshot.ts` to the `leaderboard-state` branch: [view it on GitHub](https://github.com/slowzd/kingshot-bot/blob/leaderboard-state/snapshot.ts). Weekly summaries leave it unchanged. It shows which Mightpulse snapshot was used:
- `latest`: update time, when the API was fetched, when Mightpulse captured the data (`apiCapturedAt`), its age in minutes, and every alliance returned (rank, tag, name, power).
- `history`: the same times for up to 336 updates, newest first (including any earlier hourly history).

The run summary in the **Actions** tab also says which API snapshot time each update used.

### Timing and reliability
GitHub's own scheduler delayed or dropped runs, so the workflow has no `schedule:` and is started by cron-job.org instead. Keep the hourly trigger: each run checks the most recent **01:01 UTC** daily slot. The daily update posts only if that slot has not already been posted, regardless of how recently the previous day's update was sent. The timestamp and slot are saved on the state branch and survive separate workflow runs. Concurrent workflow runs are serialized. Monday's weekly summary has its own saved duplicate guard and runs independently.

Keep the existing `1 * * * *` cron to check at **01:01 UTC** for daily posts and **Monday 00:01 UTC** for the weekly summary. GitHub startup can still add a delay.

Missed daily updates are sent on the next eligible hourly check, even across midnight, unless their week has already closed. Multiple missed days produce only one current update, not a backlog of samples. The target remains 01:01 UTC, not "24 hours after the last post." For example, a delayed 00:30 catch-up post can be followed by the new day's 01:01 post, just 31 minutes later. Repeated checks for the same slot still do not post again.

A failed API or Discord request does not count, so the next check can retry. Discord delivery and saving state are not one atomic operation: a partial multi-message delivery or a state-branch push failure can still cause a duplicate on retry.

Each run takes well under a minute. Public repositories get unlimited free Actions minutes.

Mightpulse decides how fresh its data is. The snapshot log shows when Mightpulse captured the rankings each update used.

## Local commands
Requires Node.js 24 or newer. Put the same variables in a local `.env` file.

- `npm install` – installs the TypeScript tooling (only needed for `check`).
- `npm run preview` – checks the daily schedule and, if due, fetches the live API and prints the message without posting or saving.
- `npm start` – checks the daily schedule and, if due, posts to Discord and saves standings to `state/leaderboard.json` and the snapshot log to `state/snapshot.ts`.
- `npm start -- --force` – sends a real Discord test post immediately to test channel `1561449272690344068`, ignoring `DISCORD_CHANNEL_ID` and bypassing daily slot duplicate protection. Does not save power samples, standings, the posting timestamp, or snapshot history, so the normal daily schedule is unaffected. Repeated calls send repeated test posts. The bot needs View Channel and Send Messages permissions in the test channel.
- `npm run preview -- --force` – bypasses daily slot duplicate protection to print a preview without sending to Discord or saving anything.
- `npm test` – runs the tests.
- `npm run check` – TypeScript type check.

Normal posts still use `DISCORD_CHANNEL_ID` (production channel `1559288525201866814`); keep that value in the GitHub Actions secret and local `.env`.
