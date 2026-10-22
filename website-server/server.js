require('dotenv').config();
require('express-async-errors');
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');

const requiredEnv = ['MONGODB_URI', 'SESSION_SECRET', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'DASHBOARD_OWNER_DISCORD_ID'];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length) {
  console.error('Missing required dashboard environment variables:', missing.join(', '));
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && process.env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be at least 32 characters in production.');
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const webRoot = path.resolve(__dirname, '../website');
const allowedPermissions = new Set([
  'tickets.view', 'tickets.manage', 'applications.view', 'applications.review',
  'webhooks.view', 'webhooks.manage', 'moderation.view', 'moderation.manage',
  'commands.view', 'commands.manage', 'staff.manage', 'settings.manage'
]);

app.disable('x-powered-by');
if (isProduction) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://i.postimg.cc'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

const mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
let db;
let sessionStore;

function audit(actorId, action, details = {}) {
  return db.collection('dashboardAudit').insertOne({
    actorId: String(actorId || 'unknown'),
    action,
    details,
    at: new Date(),
    ipHash: crypto.createHash('sha256').update(String(details.ip || '')).digest('hex')
  }).catch((error) => console.error('Dashboard audit write failed:', error.message));
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}
function requireOwner(req, res, next) {
  if (!req.session.user || !req.session.user.isMainOwner) return res.status(403).json({ error: 'Main owner access required.' });
  next();
}
function requirePermission(permission) {
  return (req, res, next) => {
    const user = req.session.user;
    if (!user) return res.status(401).json({ error: 'Sign in required.' });
    if (user.isMainOwner || (Array.isArray(user.permissions) && (user.permissions.includes('*') || user.permissions.includes(permission)))) return next();
    return res.status(403).json({ error: 'You do not have permission to do that.' });
  };
}
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = req.session.csrfToken;
  const supplied = req.get('x-csrf-token');
  if (!expected || !supplied || Buffer.byteLength(expected) !== Buffer.byteLength(String(supplied)) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(supplied)))) {
    return res.status(403).json({ error: 'Invalid CSRF token. Refresh the page and try again.' });
  }
  next();
}
function makeCsrf(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

let sessionMiddleware;
app.use((req, res, next) => {
  if (!sessionMiddleware) return res.status(503).send('3C Dashboard is starting. Refresh in a moment.');
  sessionMiddleware(req, res, next);
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/auth', loginLimiter);

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(webRoot, 'login.html'));
});

app.get('/auth/discord', async (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  req.session.oauthStartedAt = Date.now();
  await new Promise((resolve, reject) => req.session.save((err) => err ? reject(err) : resolve()));
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    state
  });
  res.redirect('https://discord.com/oauth2/authorize?' + params.toString());
});

app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error || !code || !state || !req.session.oauthState ||
        typeof state !== 'string' || state !== req.session.oauthState ||
        Date.now() - Number(req.session.oauthStartedAt || 0) > 10 * 60 * 1000) {
      return res.redirect('/login?error=oauth');
    }
    delete req.session.oauthState;
    delete req.session.oauthStartedAt;
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    });
    if (!tokenResponse.ok) throw new Error('Discord token exchange failed');
    const tokenData = await tokenResponse.json();
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    if (!userResponse.ok) throw new Error('Discord identity lookup failed');
    const discordUser = await userResponse.json();
    const guildResponse = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    const guilds = guildResponse.ok ? await guildResponse.json() : [];
    const isMainOwner = discordUser.id === process.env.DASHBOARD_OWNER_DISCORD_ID;
    let account = null;
    if (!isMainOwner) {
      account = await db.collection('dashboardUsers').findOne({
        discordId: String(discordUser.id),
        status: 'active'
      });
      if (!account || (req.session.pendingUsername && account.username !== req.session.pendingUsername)) {
        await audit(discordUser.id, 'login.denied', { reason: 'No matching active account', ip: req.ip });
        return res.redirect('/login?error=not_authorized');
      }
    }
    const ownedGuilds = Array.isArray(guilds)
      ? guilds.filter((guild) => guild.owner).map((guild) => ({ id: String(guild.id), name: String(guild.name) }))
      : [];
    await new Promise((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
    req.session.user = {
      id: String(discordUser.id),
      username: String(discordUser.username),
      avatar: discordUser.avatar ? 'https://cdn.discordapp.com/avatars/' + discordUser.id + '/' + discordUser.avatar + '.png' : null,
      isMainOwner,
      isServerOwner: ownedGuilds.length > 0,
      ownedGuilds,
      accountId: account?._id?.toString() || null,
      permissions: isMainOwner ? ['*'] : (account?.permissions || []),
      serverIds: isMainOwner ? ['*'] : (account?.serverIds || [])
    };
    req.session.loginAt = Date.now();
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    await new Promise((resolve, reject) => req.session.save((err) => err ? reject(err) : resolve()));
    await audit(discordUser.id, 'login.success', { ip: req.ip, isMainOwner });
    delete req.session.pendingUsername;
    res.redirect('/');
  } catch (error) {
    console.error('Discord OAuth error:', error.message);
    res.redirect('/login?error=oauth');
  }
});

app.post('/auth/password', loginLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || password.length < 1 || password.length > 200) return res.status(400).json({ error: 'Enter your username and password.' });
  const account = await db.collection('dashboardUsers').findOne({ username, status: 'active' });
  if (!account || !account.passwordHash || !(await bcrypt.compare(password, account.passwordHash))) {
    await audit('unknown', 'login.password_denied', { username, ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  req.session.pendingUsername = username;
  await new Promise((resolve, reject) => req.session.save((err) => err ? reject(err) : resolve()));
  res.json({ ok: true, next: '/auth/discord' });
});

app.post('/auth/logout', requireAuth, csrfGuard, async (req, res) => {
  const id = req.session.user.id;
  await audit(id, 'logout', { ip: req.ip });
  req.session.destroy(() => {
    res.clearCookie('3c_dashboard_session', { path: '/', httpOnly: true, sameSite: 'lax', secure: isProduction });
    res.json({ ok: true });
  });
});

app.get('/api/csrf', requireAuth, (req, res) => res.json({ csrfToken: makeCsrf(req) }));
app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.session.user }));
app.get('/api/health', (req, res) => res.json({ ok: true, service: '3c-dashboard', mode: isProduction ? 'production' : 'development' }));

app.get('/api/staff', requireAuth, requirePermission('staff.manage'), async (req, res) => {
  if (!req.session.user.isMainOwner) return res.status(403).json({ error: 'Only the main owner can list all dashboard accounts in this initial build.' });
  const users = await db.collection('dashboardUsers').find({}, {
    projection: { username: 1, discordId: 1, status: 1, permissions: 1, serverIds: 1, createdAt: 1 }
  }).sort({ createdAt: -1 }).limit(200).toArray();
  res.json({ users });
});

app.post('/api/staff', requireAuth, csrfGuard, requireOwner, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const discordId = String(req.body.discordId || '').trim();
  const permissions = Array.isArray(req.body.permissions) ? [...new Set(req.body.permissions.filter((p) => allowedPermissions.has(p)))] : [];
  const serverIds = Array.isArray(req.body.serverIds) ? [...new Set(req.body.serverIds.map(String).filter((id) => /^\d{15,22}$/.test(id)))].slice(0, 100) : [];
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–32 characters: letters, numbers, dots, underscores, or hyphens.' });
  if (password.length < 12 || password.length > 200) return res.status(400).json({ error: 'Staff passwords must be at least 12 characters.' });
  if (!/^\d{15,22}$/.test(discordId) || discordId === process.env.DASHBOARD_OWNER_DISCORD_ID) return res.status(400).json({ error: 'Enter the staff member’s Discord user ID. The main owner cannot be added as staff.' });
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const result = await db.collection('dashboardUsers').insertOne({
      username, passwordHash, discordId, permissions, serverIds,
      status: 'active', createdAt: new Date(), createdBy: req.session.user.id
    });
    await audit(req.session.user.id, 'staff.created', { accountId: result.insertedId.toString(), username, discordId, ip: req.ip });
    res.status(201).json({ ok: true, id: result.insertedId.toString(), username, discordId, permissions, serverIds, status: 'active' });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That username or Discord ID is already registered.' });
    throw error;
  }
});

app.patch('/api/staff/:id/status', requireAuth, csrfGuard, requireOwner, async (req, res) => {
  const status = req.body.status;
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Status must be active or suspended.' });
  const { ObjectId } = require('mongodb');
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid account ID.' });
  const result = await db.collection('dashboardUsers').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status, updatedAt: new Date(), updatedBy: req.session.user.id } }
  );
  if (!result.matchedCount) return res.status(404).json({ error: 'Account not found.' });
  await db.collection('dashboardSessions').deleteMany({ 'session.user.accountId': req.params.id });
  await audit(req.session.user.id, 'staff.status_changed', { accountId: req.params.id, status, ip: req.ip });
  res.json({ ok: true, status });
});

app.get('/api/audit', requireAuth, requirePermission('moderation.view'), async (req, res) => {
  const rows = await db.collection('dashboardAudit').find({}, { projection: { ipHash: 0 } })
    .sort({ at: -1 }).limit(100).toArray();
  res.json({ rows });
});

app.use('/api', (error, req, res, next) => {
  console.error('Dashboard API error:', error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong. Check server logs for details.' });
});

// Serve the real dashboard only after authentication. Never send the public redirect
// page here: index.html redirects back to login.html and would create a login loop.
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(webRoot, 'dashboard.html'));
});
app.get('/index.html', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(webRoot, 'dashboard.html'));
});
app.get('/dashboard.html', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(webRoot, 'dashboard.html'));
});
// Keep private HTML out of express.static; other public assets (CSS/JS/images) are safe.
app.use(express.static(webRoot, { index: false, maxAge: isProduction ? '1h' : 0 }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return res.status(404).json({ error: 'Not found.' });
  if (!req.session.user) return res.redirect('/login');
  res.status(404).send('Not found');
});

async function start() {
  await mongo.connect();
  db = mongo.db(process.env.MONGODB_DATABASE || '3c_dashboard');
  await db.collection('dashboardUsers').createIndex({ username: 1 }, { unique: true });
  await db.collection('dashboardUsers').createIndex({ discordId: 1 }, { unique: true });
  await db.collection('dashboardAudit').createIndex({ at: -1 });
  sessionStore = MongoStore.create({ client: mongo, dbName: db.databaseName, collectionName: 'dashboardSessions', ttl: 8 * 60 * 60, stringify: false });
  sessionMiddleware = session({
    name: '3c_dashboard_session',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, path: '/' }
  });
  app.listen(port, '0.0.0.0', () => console.log('3C dashboard listening on port ' + port));
}
start().catch((error) => {
  console.error('Failed to start 3C dashboard:', error.message);
  process.exit(1);
});
