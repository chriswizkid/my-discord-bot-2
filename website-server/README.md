# 3C Dashboard Server (early backend)

This is an isolated backend prototype for the 3C Control Center. It is intentionally separate from the live Discord bot process.

## Included so far
- Discord OAuth identity verification with a random, session-bound OAuth state.
- Main-owner identity configured only by DASHBOARD_OWNER_DISCORD_ID.
- Staff login requires both an owner-created username/password and the matching Discord identity.
- Password hashes use bcrypt; staff passwords must be at least 12 characters.
- MongoDB-backed sessions, HTTP-only cookies, production Secure cookies, rate limiting, Helmet security headers, and CSRF checks for state-changing authenticated API routes.
- Main-owner-only staff-account creation and suspension.
- Audit records for sign-in attempts and account changes.
- The static dashboard is served only after sign-in when served by this backend. Do not use the separate GitHub Pages preview for real/private data.

## Environment variables
Copy .env.example to .env for local testing, then fill in real values in your hosting provider's private environment settings:
- MONGODB_URI: a dedicated MongoDB connection string for the dashboard database.
- MONGODB_DATABASE: defaults to 3c_dashboard.
- SESSION_SECRET: a random secret of at least 32 characters.
- DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET: from the Discord Developer Portal OAuth2 page.
- DISCORD_REDIRECT_URI: must exactly match the OAuth2 redirect URI configured in Discord.
- DASHBOARD_OWNER_DISCORD_ID: the main owner's Discord user ID. Do not guess this value.
- NODE_ENV=production and a hosting-provided PORT.

Never commit real credentials, ask anyone to send them in chat, or put them in browser code.

## Run locally
    cd website-server
    npm install
    npm start

Open http://localhost:3000/login. For local OAuth, configure the matching local callback URL in the Discord application and set NODE_ENV=development.

## Important limitations — not ready for production
This is an initial secure-auth/API foundation, not a completed dashboard. The visual modules are still mostly previews. Server-scoped permissions, verified server-owner access, ticket and webhook CRUD, staff application reviews, live moderation data, password resets, session-management UI, backup/restore, comprehensive tests, and deployment configuration still need implementation and review. Do not connect the production bot token or deploy this backend publicly until those features and security checks are completed.
