# Kingshot Discord Bot — Mightpulse Alliance Leaderboard

Reads in-game **Alliance Power** rankings from the public Mightpulse API and posts the top 10 alliances to Discord. BlueStacks, ADB, screenshots, OCR, and browser login are not required.

## How It Works
1. Requests `https://mightpulse.com/api/kingdoms/<KINGDOM>/ingame-ranks`.
2. Uses the Alliance Power board (`boards["1"]`) and its exact `game_power` values.
3. Adds each alliance's rank to a weekly cumulative total on scheduled hourly updates.
4. Posts the current power leaderboard, a separate **Cumulative Power** ranking, and the API's capture date/time in UTC.

Mightpulse controls how often the underlying rankings are refreshed. Fetching the API does not capture new in-game data. Each scheduled hour counts the ranks returned, even when the source snapshot is unchanged; the displayed UTC capture time makes its age visible.

## Requirements
- Node.js 20 or newer.
- A Discord bot with View Channel and Send Messages permissions.
- Internet access to Discord and Mightpulse.

Install dependencies with `npm ci`. Configure these variables in a local `.env` file:

```dotenv
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-id
DISCORD_GUILD_ID=your-server-id
DISCORD_CHANNEL_ID=your-channel-id
KINGDOM=2426
```

`KINGDOM` defaults to `2426`. The one-shot broadcast needs only `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, and optionally `KINGDOM`; client and guild IDs are needed for the running slash-command bot.

## Commands
- `npm start`: Registers Discord commands, posts an initial snapshot, and automatically posts hourly at one minute past each UTC hour (01:01, 02:01, and so on).
- `/post-leaderboard`: Immediately fetches the API rankings and posts them to `DISCORD_CHANNEL_ID`, with a private confirmation.
- `/leaderboard`: Fetches the same rankings as a public response in the channel where the command is used.
- `npm run broadcast`: Fetches and sends one snapshot, then exits.
- `npm run broadcast:emulator` and `npm run emulator:test`: Compatibility aliases for the API broadcast; neither uses an emulator anymore.
- `npm run check`: Runs TypeScript validation.
- `npm test`: Runs focused API and cumulative-ranking tests without contacting Discord.

## Cumulative Power
This separate section sums **rank positions**, not power values. Lower totals are better: three hourly updates in first place give `1 + 1 + 1 = 3`. Every alliance that has entered the top 10 this week is included in the cumulative list, even after leaving the top 10. Totals are sorted lowest first, with alliance ID breaking ties deterministically. Long lists are split across Discord messages without dropping alliances.

Before any hourly updates have been counted, the current top 10 are shown with `Cumulative rank: 0` in their current ranking order. These display-only zeros do not count an update or change saved totals.

Only successfully posted scheduled hourly updates count, at most once per UTC hourly slot. Startup posts, slash commands, ordinary broadcasts, and manually dispatched workflows only display the totals. No missed hours are invented after downtime.

An alliance is tracked once it appears in the current top 10. Tracked alliances outside the top 10 receive rank **11** for each counted update. A new entrant also receives 11 for each earlier counted update that week, so joining late does not create an unfairly low total. Stable alliance IDs retain scores across rank, tag, and name changes.

Totals reset **Monday at 00:01 UTC**. The first scheduled update at that time starts the new week's scores. Data is stored per kingdom in `snapshots/cumulative-ranking-<KINGDOM>.json` and survives restarts. Old power-difference files are no longer used. A failed API request or Discord send does not change totals. Posts within a running process are serialized; avoid running multiple bot/broadcast processes against the same files at once.

## GitHub Actions
The broadcast workflow runs hourly at one minute past each UTC hour (GitHub may delay scheduled runs) and supports manual dispatch. Configure `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, and optionally `KINGDOM` as repository secrets. No emulator or browser setup is needed. Scheduled runs use `npm run broadcast -- --scheduled` to count an hourly update; manual dispatch does not count. Delayed runs use the latest UTC :01 hourly slot at their start time. The workflow caches cumulative data between successful runs; a cache miss starts new totals.
