# Kingshot Alliance Power Leaderboard

Posts a Kingshot **Alliance Power** leaderboard to Discord once daily, starting checks at **01:01 UTC** and waiting for fresh Mightpulse data, plus a cumulative-only weekly summary on **Monday at 00:01 UTC**. An hourly cron-job starts the GitHub Actions workflow. No server, emulator or always-on bot is needed.

## What it posts
When the daily update is due:
1. Read Alliance Power from board `1` at the website's public endpoint `https://mightpulse.com/api/kingdoms/<KINGDOM>/ingame-ranks` (no API key required). Check that board's `captured_at` timestamp: it must belong to the daily slot's **UTC date** and be newer than the last accepted capture. Invalid or future timestamps fail explicitly.
2. If Mightpulse has not captured that day's data yet, do not post, change standings, or save a snapshot. Leave the slot open for the next hourly workflow run.
3. Once fresh data is available, take only alliances ranked **1–10**, save their snapshot after successful delivery, and post **Today's Alliance Power — Top 10** plus **Current Average Power Ranking** below it.

Each successful daily update records that day's **top 20**, while displaying only the **top 10** daily power and average power rankings. **Average power = sum of accepted daily top-20 power / number of top-20 observations**, with the highest average ranked first. This is a true weekly average, not `(yesterday's average + today's power) / 2`: powers of 100, 200, and 600 produce averages of 100, 150, and 300. Monday's first accepted sample naturally has its daily power as its average.

Alliances observed in the daily **top 20 at least once that week** qualify for the average ranking, which displays the 10 highest averages. Observations at ranks 11–20 count even before an alliance enters the displayed top 10. When an alliance drops below the daily top 20, its saved average remains unchanged until it returns. Missing days do not count as zero; stale data and missed workflow runs add no samples. Eligibility does not guarantee a displayed place if ten other qualifying alliances have higher averages. Equal averages are ordered by alliance ID; displayed averages use up to two decimal places.

## Weekly cycle (UTC)
- Each day from **01:01**, hourly runs check for fresh daily data. The first run with eligible data posts Alliance Power plus **Current Average Power Ranking**, then saves the sample and marks the daily slot complete.
- **Sunday from 01:01** – the last daily sample of the week is accepted once fresh data is available.
- **Monday 00:01** – **Weekly Cumulative Ranking** summarizes the completed week's saved average power. It contains no Alliance Power section, fetches no API data, and adds no samples.
- **Monday from 01:01** – checks resume for Monday's Mightpulse data. The first fresh daily update starts the new week with fresh power totals, observation counts, and top-20 eligibility. Sunday's stale capture cannot start the new week.

The weekly summary is separate from daily slot protection: it neither checks nor changes the last daily posting timestamp. It is saved as posted so repeated hourly checks do not send it again. Once the summary is published, that week's averages are closed.

If Monday's 00:01 run is missed, the next run posts the saved weekly summary first. If a daily update is also eligible, it then posts separately and starts the new week. Only the daily update adds power samples. Failed weekly deliveries can be retried; a successfully saved summary is not repeated if the following daily API request fails.

## GitHub Actions setup
The workflow is [.github/workflows/hourly-leaderboard.yml](.github/workflows/hourly-leaderboard.yml).

1. In the repository go to **Settings → Secrets and variables → Actions** and add:
   - `DISCORD_TOKEN` – bot token (the bot needs View Channel and Send Messages in the channel)
   - `DISCORD_CHANNEL_ID` – channel to post in
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

Existing version-1 point-based standings finish their current week with the old scoring, including the Monday 00:01 weekly summary. Ranking values display without `pts` or `avg power` suffixes. At the next Monday daily reset, version-2 standings start tracking average power. Old points are not converted into power samples. The last saved slot prevents duplicate posts during migration. Deleting the state branch also clears duplicate protection.

Existing saved averages and previously counted samples are not rewritten. New samples use the daily top 20; ranks 11–20 from earlier top-10-only snapshots cannot be recovered retroactively. Existing version-2 observations remain in that week's totals until the next weekly reset. Older standings without a saved source timestamp use the snapshot log's latest capture when available; the UTC-date check also applies when no history exists.

There is no elapsed-time cooldown. A late Sunday update does not block Monday's fresh average-power update, and late daily updates never delay the next day's slot.

### Snapshot log
Each posted daily update also writes `snapshot.ts` to the `leaderboard-state` branch: [view it on GitHub](https://github.com/slowzd/kingshot-bot/blob/leaderboard-state/snapshot.ts). Weekly summaries leave it unchanged. It shows which Mightpulse snapshot was used:
- `latest`: update slot, when the API was fetched, when Mightpulse captured the data (`apiCapturedAt`), its age in minutes, and the accepted daily top 20 (rank, ID, tag, name, power).
- `history`: the same times **and each day's top-20 data** for up to 336 updates, newest first. Older entries may contain only top-10 data or timestamps.

The run summary in the **Actions** tab says which API snapshot time each update used, or why the bot is waiting. Discord's daily footer shows only the update slot. Equal power values on different days are valid if Mightpulse's capture timestamp confirms a new daily snapshot.

### Timing and reliability
GitHub's own scheduler delayed or dropped runs, so the workflow has no `schedule:` and is started by cron-job.org instead. Keep the hourly trigger: each run checks the most recent **01:01 UTC** daily slot. The daily update posts only if that slot has not already been posted **and** Mightpulse has a fresh, unused capture for that slot's UTC date. The source capture timestamp and slot are saved on the state branch and survive separate workflow runs. Concurrent workflow runs are serialized. Monday's weekly summary has its own saved duplicate guard and runs independently.

Keep the existing `1 * * * *` cron to check at **01:01 UTC** for daily posts and **Monday 00:01 UTC** for the weekly summary. GitHub startup can still add a delay.

For each daily slot, the 01:01 UTC run checks Mightpulse. Stale data produces no Discord post and no state changes; each following hourly run checks again. API or Discord failures also leave the slot open for retry. Only successful delivery marks that slot as posted. Once saved, all further checks skip that daily ranking until the next day's 01:01 UTC slot, including checks after midnight but before 01:01.

Missed daily updates can be sent on the next eligible hourly check, even across midnight, only if the API capture belongs to that slot's UTC date and the week has not closed. A newer day's capture is never backdated into yesterday's slot. Multiple missed days produce only one current update, not a backlog of samples. The target remains 01:01 UTC, not "24 hours after the last post." A delayed 00:30 catch-up using yesterday's capture can be followed by the new day's 01:01 post if a fresh capture for the new day is available. Repeated checks for the same slot still do not post again.

A failed API or Discord request does not count, so the next check can retry. Discord delivery and saving state are not one atomic operation: a partial multi-message delivery or a state-branch push failure can still cause a duplicate on retry.

Each run takes well under a minute. Public repositories get unlimited free Actions minutes.

Mightpulse decides when it captures data; the bot waits rather than presenting an old capture as a new daily update.

## Local commands
Requires Node.js 24 or newer. Put the same variables in a local `.env` file.

- `npm install` – installs the TypeScript tooling (only needed for `check`).
- `npm run preview` – checks the daily schedule and, if due, fetches the live API and prints the message without posting or saving.
- `npm start` – checks the daily schedule and, if due, posts to Discord and saves standings to `state/leaderboard.json` and the snapshot log to `state/snapshot.ts`. These local files are not automatically synced with GitHub's state branch.
- `npm run correct` – requests a correction of today's automatic post through GitHub Actions, using the shared saved standings. See below.
- `npm start -- --force` – sends a real Discord test post immediately to test channel `1561449272690344068`, ignoring `DISCORD_CHANNEL_ID` and bypassing daily slot and source freshness guards. Does not save power samples, standings, the posting timestamp, or snapshot history, so the normal daily schedule is unaffected. Repeated calls send repeated test posts. The bot needs View Channel and Send Messages permissions in the test channel.
- `npm run preview -- --force` – bypasses daily slot and source freshness guards to print a preview without sending to Discord or saving anything.
- `npm test` – runs the tests.
- `npm run check` – TypeScript type check.

Normal posts still use `DISCORD_CHANNEL_ID` (production channel `1559288525201866814`); keep that value in the GitHub Actions secret and local `.env`.

### Correct today's automatic post

First deploy these code and workflow changes to `main`. Set `GH_TOKEN` (or `GITHUB_TOKEN`) in your local `.env` to a GitHub token with **Actions: Read and write** access to this repository, or a classic token with `repo` and `workflow` scopes. Do not commit your token. The correction runs in GitHub Actions and uses the existing bot/API secrets there; your PC only dispatches it.

Then run from the project directory:

```powershell
npm run correct
```

The command requests a correction for **today's UTC date**, at or after **01:01 UTC**. Check the linked Actions run for the actual result: successful dispatch is not confirmation that Discord delivery or saving succeeded.

The workflow:
1. Waits in the same concurrency group as normal cron runs and loads `leaderboard-state`.
2. Requires an existing, open average-power week with today's accepted daily slot and its matching saved snapshot. It cannot correct an older day, a closed week, or legacy point-based standings.
3. Fetches the latest Mightpulse capture for today's UTC date. It bypasses the already-posted guard and permits reusing today's capture, but does not accept stale or future-dated data.
4. Subtracts the old sample, applies the latest top 20, and recalculates the weekly average **without increasing the daily update count**. Alliances with no remaining observations are removed. Existing historical observations are preserved.
5. Sends a **new correction message to the normal channel**. It does not edit or delete the previous Discord message.
6. Saves the replacement standings and snapshot to the shared state branch. Snapshot history keeps one accepted entry for the corrected slot. Failed API or Discord requests leave the saved sample unchanged for retry.

The request is pinned to its UTC date; if queued until another day, it fails instead of correcting the wrong day. Repeating the command sends another correction but still replaces the same sample rather than counting it again. The same non-atomic Discord/state-save limitations described above apply.

Alternatively, use **Actions → Daily Alliance Leaderboard → Run workflow**, enable `correct`, and enter today's UTC date in `correction_date`. Leave these inputs at their defaults for normal runs. The existing `--force` option remains an unsaved test-channel post, not a production correction.
