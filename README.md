# 3ST Discord Bot

Discord.js v14 bot with the same moderation, AFK, snipes, tickets, roles, server info, webhook studio, welcome/goodbye, invite tracking and utility systems as the previous bot, configured for the 3ST server.

## Run locally
1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and put the new bot token in `DISCORD_TOKEN`.
3. Keep your existing `MONGODB_URI` if you want to retain the previous bot's stored configuration and data. The bot stores state in the `bot_state` collection, document `_id: main`.
4. Run `npm install`.
5. Run `npm start`.

## ModVC
- Build command: `npm install`
- Start command: `npm start`
- Environment variables: `DISCORD_TOKEN`, and optionally `MONGODB_URI`.
- Ensure the start command uses lowercase `npm`.

## Discord Developer Portal
Enable **Message Content Intent** and **Server Members Intent**. Invite the bot with the permissions it needs: View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Manage Channels, Manage Roles, Manage Nicknames, Moderate Members, Kick Members and Ban Members.
Put the bot's highest role above every role it needs to manage.

Set the application description manually in the Developer Portal to:
`~Created By Chris_wizkid~`

## Initial 3ST setup
- Prefix: `-` (default).
- Set the welcome channel with `-setwelcome #channel`.
- Set the goodbye channel with `-setgoodbye #channel`.
- Set the tryout channel with `-settryout #channel`.
- Owner-only level commands: `-lvl 30 @user`, `-lvl remove 30 @user`.
