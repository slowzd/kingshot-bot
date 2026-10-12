# Kingshot Discord Bot — BlueStacks In-Game Live Leaderboard

Reads the live **Alliance Power Leaderboard** directly from **BlueStacks 5** via ADB and Optical Character Recognition (OCR), completely bypassing third-party sites like StratForge for 100% accurate, in-game stats.

## How It Works
1. Connects to your active BlueStacks 5 instance via ADB (`HD-Adb.exe`).
2. Captures the in-game screen directly from the emulator.
3. Parses alliance ranks, tags, names, and power values using Tesseract OCR.
4. Posts the live leaderboard directly to Discord.

## Requirements
- **BlueStacks 5** installed and running on your PC.
- In BlueStacks **Settings -> Advanced**, toggle **Android Debug Bridge (ADB)** to **ON**.
- Kingshot open to your kingdom's **Alliance Power Leaderboard** screen.

## Commands
- `npm start`: Starts the Discord bot, sends an initial snapshot message on startup, and automatically posts a new update every 15 minutes aligned to the clock (:00, :15, :30, :45 of every hour). Also registers the `/leaderboard` slash command.
- `npm run emulator:test` or `npm run broadcast`: Manually triggers an immediate capture from BlueStacks and posts a new snapshot message to Discord.

