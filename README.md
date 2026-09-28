# 3C Discord Bot

Discord.js v14 bot with moderation, AFK, snipes, tickets, roles, server info, prefix settings and utility commands.

## Run locally
1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and put your bot token in `DISCORD_TOKEN`.
3. Run `npm install`.
4. Run `npm start`.

## Render
- Create a **Web Service** or worker-style Node service from this GitHub repo.
- Build command: `npm install`
- Start command: `npm start`
- Add environment variable `DISCORD_TOKEN`.

## Discord Developer Portal
Enable **Message Content Intent** and **Server Members Intent** under Bot settings.
Give the bot the permissions it needs: View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Manage Channels, Manage Roles, Manage Nicknames, Moderate Members, Kick Members and Ban Members.
Put the bot's highest role above roles it needs to manage.

## Important persistence note
`data.json` stores prefixes, warnings and ticket-panel configs. Render's normal filesystem can be reset on redeploy/restart, so use a database or persistent disk if you need these settings to survive every restart.


## Ticket panel setup
Use `!ticket` by itself to open the interactive setup message. Click **Configure Ticket Panel**, then fill in:
- Ticket name
- Embed color
- Embed title
- Embed description (multi-line)

## Audit log
Use `!setupaudit` (or `!auditsetup`) once. The bot creates a private `#3c-audit-log` channel and records moderation actions and ticket activity such as warnings, timeouts, kicks, bans, role changes, locks/unlocks, purges, and ticket creation/closure.

After it creates the channel, add your staff/mod role to the channel's **View Channel** permission so staff can read the logs.
