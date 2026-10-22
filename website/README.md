# 3C Control Center — UI Preview

This folder contains the first static UI draft for the 3C Bot dashboard.

## Preview locally
Open `index.html` in a browser, or serve this folder with any simple static file server. No build step is required.

## What's interactive in this draft
- Sidebar navigation between the planned dashboard sections.
- Ticket panel preview with Discord's four supported button styles: blue, grey, green, red.
- Embed preview with a custom hex accent colour.
- Search filtering for the sample moderation-log rows.

## Important status
This is a **front-end preview only**, not a live dashboard. The example log rows are fake. It does not sign users in, contact Discord, send messages, save configuration, or enforce permissions.

Before real use, add a backend with Discord OAuth verification, server-side owner/staff permission checks, secure sessions, password hashing for invited accounts, CSRF protection, audit logging, persistent storage, and environment-based secrets. Do not put bot tokens, MongoDB credentials, or session secrets in browser code.

The website is intentionally being developed on the `feature/3c-command-updates` branch and is not deployed by this commit.
