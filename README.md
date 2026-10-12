# Kingshot StratForge Discord Bot — Kingdom 2446

Uses Playwright to read the **Top alliances** section on StratForge and posts up to the top 10 available rows in Discord with `/leaderboard kingdom:<number>` (for example, `/leaderboard kingdom:2446`). If no kingdom is supplied, it uses `KINGDOM` from `.env`. Without a saved login session, only public rows are retrieved.

**Limitations:** StratForge publicly shows only a limited number of alliances. The bot extracts the displayed alliance Power, Combat power, and member count; some values may be missing, and Combat power may be marked as estimated. This project does not bypass login, paywalls or verification and does not claim to retrieve the complete in-game power leaderboard. The site's layout may change; extraction is experimental and not live-tested.

## Install
1. Install Node.js LTS.
2. Open this folder in VS Code.
3. Run `npm install` and `npx playwright install chromium`.
4. Copy `.env.example` to `.env` and fill in your Discord token, application ID and server ID. Never share the token.
5. Run `npm start`.
6. Type `/leaderboard kingdom:2446` in your Discord server, replacing `2446` with the kingdom you want. The `kingdom` option is optional and defaults to `KINGDOM` in `.env`.

The bot registers a guild slash command, fetches the public listing, saves timestamped text files to `snapshots/`, and attaches them to Discord. If extraction fails it saves a diagnostic file. The first few publicly visible rows may be ranked by **real power**, not total alliance power; check the source before comparing.

## Optional StratForge login
1. Run `npm run login` from this project folder.
2. In the separate browser window, sign in to StratForge using Discord. Complete any verification manually and return to StratForge.
3. Confirm the site shows you as logged in, then press Enter in the terminal. Keep the browser open until the terminal confirms the session was saved.
4. Run the bot as usual. Each leaderboard request loads the saved session.

The login script saves only StratForge cookies and origin storage in `.auth/stratforge.json`, not Discord's cookies or your password. Your normal browser's existing login is not imported. Saving session data does not prove the login succeeded; confirm it in the browser before pressing Enter. Account access and site terms still apply; login does not guarantee ten rows. If the listing remains restricted, the bot reports an error rather than silently treating it as an authenticated result. Run `npm run login` again when your session expires. Delete `.auth/stratforge.json` to return to public-only access.

Running `npm run login` again opens a new browser window but loads the previously saved StratForge session. You only need to sign in again if it has expired or been revoked. Both the login command and bot use the session file in this project's `.auth` folder, independent of the terminal's working directory. Discord login cookies are intentionally not saved, so an expired StratForge session may require Discord verification again.

**Keep the session file private:** it grants account access, is excluded from Git, and must not be shared or uploaded. On Windows, restrict access using your account's file permissions; Unix permission modes alone do not protect a Windows file. Anyone who can invoke this bot's command can retrieve rankings available to the saved account, so use it only in a trusted Discord server.

## Automatisk udsendelse via GitHub Actions
Projektet indeholder en GitHub Actions workflow i [.github/workflows/daily-leaderboard.yml](.github/workflows/daily-leaderboard.yml), som automatisk henter data fra StratForge og opdaterer botens seneste besked i din Discord-kanal hvert femte minut. GitHub Actions understøtter ikke planlagte workflows oftere end hvert femte minut, og planlagte kørsler kan blive forsinkede.

### Opsætning i GitHub:
1. Upload/push koden til dit private GitHub repository (husk at `.env` og `.auth` automatisk ignoreres af `.gitignore` og ALDRIG må pushes).
2. Gå ind på dit repository på GitHub -> **Settings** -> **Secrets and variables** -> **Actions**.
3. Tilføj følgende **Repository secrets**:
   - `DISCORD_TOKEN`: Dit Discord bot token.
   - `DISCORD_CHANNEL_ID`: ID'et på den Discord-tekstkanal, hvor beskeden skal sendes.
   - `KINGDOM`: Det kingdom-nummer der skal hentes (f.eks. `2426`).
   - `STRATFORGE_SESSION_TOKEN`: Din session cookie-værdi fra StratForge (`__Secure-better-auth.session_token`).
4. Sørg for, at botten har **View Channel**, **Read Message History** og **Send Messages** i den valgte kanal, så den kan finde og redigere sin eksisterende besked. Kanalens egne tilladelser kan tilsidesætte bot-rollens standardtilladelser.
5. Under fanen **Actions** på GitHub kan du teste det med det samme ved at vælge workflowet og trykke **Run workflow**.

Intervallet kan justeres via cron-udtrykket i [.github/workflows/daily-leaderboard.yml](.github/workflows/daily-leaderboard.yml), men GitHub Actions tillader højst én planlagt kørsel hvert femte minut. For opdateringer hvert minut skal botten i stedet køre kontinuerligt på en altid tændt maskine eller server.
