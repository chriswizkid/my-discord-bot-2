require('dotenv').config();

const { spawn } = require('node:child_process');
const path = require('node:path');

// Keep the existing bot as the primary process. The dashboard runs as a child
// process so a dashboard startup failure cannot call process.exit() on the bot.
require('./index.js');

const requiredDashboardEnv = [
  'MONGODB_URI',
  'SESSION_SECRET',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
  'DASHBOARD_OWNER_DISCORD_ID'
];
const missing = requiredDashboardEnv.filter((key) => !process.env[key]);

let dashboard = null;
if (missing.length) {
  console.warn(
    '[3C dashboard] Not started because required environment variables are missing: ' +
    missing.join(', ')
  );
  console.warn('[3C dashboard] The Discord bot will continue running.');
} else {
  dashboard = spawn(
    process.execPath,
    [path.join(__dirname, 'website-server', 'server.js')],
    { stdio: 'inherit', env: process.env }
  );

  dashboard.on('error', (error) => {
    console.error('[3C dashboard] Could not start dashboard process:', error.message);
  });
  dashboard.on('exit', (code, signal) => {
    console.error(
      '[3C dashboard] Process exited',
      signal ? 'after signal ' + signal : 'with code ' + code,
      '- the Discord bot process will continue running.'
    );
  });
}

function shutdown() {
  if (dashboard && !dashboard.killed) dashboard.kill('SIGTERM');
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
