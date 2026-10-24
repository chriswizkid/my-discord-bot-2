require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  StringSelectMenuBuilder,
  MentionableSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  OverwriteType,
  AuditLogEvent,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { handleWebhookCommand, handleWebhookInteraction, recoverSchedules } = require('./webhook-manager');

const MONGODB_URI = process.env.MONGODB_URI;
let mongoClient = null;
let mongoCollection = null;
let mongoSaveQueue = Promise.resolve();

const TOKEN = process.env.DISCORD_TOKEN || process.env.MY_DISC_TOKEN || process.env['my disc token'];
if (!TOKEN) throw new Error('Missing DISCORD_TOKEN environment variable.');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// Small JSON database. Good for testing. For a Render production bot,
// move this to MongoDB/Postgres or a persistent Render disk so it survives restarts.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const defaultData = {
  prefixes: {},
  warnings: {},
  tickets: {},
  ticketPanels: {},
  auditChannels: {},
  reportLogs: {},
  reportCooldowns: {},
  reportsReceived: {},
  staffStats: {},
  staffCases: {},
  temporaryRoles: {},
  webhooks: {},
  scheduledWebhookMessages: {},
};
let data = loadData();
function loadData() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { ...defaultData, ...saved };
  } catch { return structuredClone(defaultData); }
}

function saveData() {
  const snapshot = structuredClone(data);
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.error('Could not save bot data locally:', error);
  }

  if (mongoCollection) {
    mongoSaveQueue = mongoSaveQueue
      .then(() => mongoCollection.replaceOne(
        { _id: 'main' },
        { _id: 'main', payload: snapshot, updatedAt: new Date() },
        { upsert: true }
      ))
      .catch(error => console.error('Could not save bot data to MongoDB:', error));
  }
}

async function initializeMongoDB() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI is not set; using DATA_FILE only.');
    return;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await mongoClient.connect();
    const db = mongoClient.db();
    const collection = db.collection('bot_state');
    const stored = await collection.findOne({ _id: 'main' });

    if (stored && stored.payload && typeof stored.payload === 'object') {
      data = { ...defaultData, ...stored.payload };
      console.log('Loaded bot data from MongoDB.');
    } else {
      // First connection: migrate the existing local data.json into MongoDB.
      await collection.insertOne({ _id: 'main', payload: structuredClone(data), updatedAt: new Date() });
      console.log('Migrated existing DATA_FILE data into MongoDB.');
    }
    // Only start database writes after the initial load/import has completed.
    mongoCollection = collection;
  } catch (error) {
    mongoCollection = null;
    if (mongoClient) await mongoClient.close().catch(() => {});
    mongoClient = null;
    console.error('MongoDB connection failed; continuing with DATA_FILE only:', error.message);
  }
}

const STAFF_ROLE_ID = '1514317861706006598';
const LEVEL_30_ROLE_ID = '1527252788634193960';

function isLevel30Member(member) {
  return Boolean(member?.roles?.cache?.has(LEVEL_30_ROLE_ID));
}

function isStaffMember(member) {
  if (!member) return false;
  return member.roles?.cache?.has(STAFF_ROLE_ID) || false;
}

function staffStatsFor(guildId, userId) {
  const k = key(guildId, userId);
  if (!data.staffStats[k]) data.staffStats[k] = {
    actions: {}, commands: 0, messages: 0, ticketsClaimed: 0, ticketsClosed: 0,
    lastSeen: 0, lastCommand: 0,
  };
  const stats = data.staffStats[k];
  if (!stats.actions) stats.actions = {};
  return stats;
}

const recentStaffActionKeys = new Map();
function recordStaffAction(guildId, moderatorId, action, targetId, reason = '', source = '3c') {
  if (!guildId || !moderatorId || !action) return false;
  const now = Date.now();
  const dedupeKey = `${guildId}:${moderatorId}:${action}:${targetId || 'none'}`;
  const last = recentStaffActionKeys.get(dedupeKey) || 0;
  if (now - last < 10000) return false;
  recentStaffActionKeys.set(dedupeKey, now);
  const stats = staffStatsFor(guildId, moderatorId);
  stats.actions[action] = (stats.actions[action] || 0) + 1;
  stats.lastSeen = now;
  if (['warn', 'kick', 'ban', 'timeout', 'untimeout', 'unban'].includes(action)) {
    if (!Array.isArray(data.staffCases[guildId])) data.staffCases[guildId] = [];
    data.staffCases[guildId].push({
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      guildId, moderatorId, action, targetId: targetId || null,
      reason: String(reason || '').slice(0, 1000), at: now, source,
    });
    if (data.staffCases[guildId].length > 5000) data.staffCases[guildId] = data.staffCases[guildId].slice(-5000);
  }
  saveData();
  return true;
}

const afk = new Map(); // guildId:userId -> { reason, since }
const deletedSnipes = new Map(); // channelId -> array of deleted messages, newest first
const editedSnipes = new Map(); // channelId -> message data
const tempMuteTimers = new Map();
const blehhhCooldowns = new Map();
const blehhhTimers = new Map();
const temporaryRoleTimers = new Map();
const reportCooldowns = new Map();
const BLEHHH_BOOSTER_ROLE_ID = '1523016721865244753';
const BLEHHH_BOOSTER_TOO_ROLE_ID = '1555575858515804170';
const BLEHHH_ROLE_ID = '1555571971801088031';
const POOP_ROLE_ID = '1562791606581469314';
const BIRTHDAY_ROLE_ID = '1563579108779098244';
const BIRTHDAY_DURATION_MS = 24 * 60 * 60 * 1000;
const BOT_APPLICATION_ID = '1562157711867781230';
const TEMP_ROLE_DURATION_MS = 5 * 60 * 1000;
const BLEHHH_COOLDOWN_MS = 10 * 1000;

function getPrefix(guildId) { return data.prefixes[guildId] || '!'; }
function key(guildId, userId) { return `${guildId}:${userId}`; }
function cleanReason(parts) { return parts.join(' ').trim(); }
function tokenize(text) {
  const out = [];
  const re = /\"([^\"]*)\"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
function truncate(s, n = 1024) { return String(s || '').slice(0, n); }
function mention(userId) { return `<@${userId}>`; }
function removeMentionArgs(args) { return args.filter(x => !/^<@!?\d+>$/.test(x)); }

function parseDuration(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^(\d+(?:\.\d+)?)(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit.startsWith('s') ? 1000 : unit.startsWith('m') ? 60000 : unit.startsWith('h') ? 3600000 : 86400000;
  return Math.floor(n * mult);
}
function prettyDuration(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  const out = [];
  if (d) out.push(`${d}d`); if (h) out.push(`${h}h`); if (m) out.push(`${m}m`); if (s || !out.length) out.push(`${s}s`);
  return out.join(' ');
}
function parseTime(input) {
  const ms = parseDuration(input);
  if (!ms) return null;
  return ms;
}
function hasPerm(member, perm) { return member.permissions.has(perm); }
function canAct(actor, target) {
  if (!target) return false;
  if (target.id === actor.id) return false;
  if (target.id === target.guild.ownerId) return false;
  return actor.id === target.guild.ownerId || actor.roles.highest.position > target.roles.highest.position;
}

function canBotModerate(target) {
  const me = target?.guild?.members?.me;
  if (!me || !target) return false;
  if (target.id === target.guild.ownerId) return false;
  return me.roles.highest.position > target.roles.highest.position;
}
async function safeDelete(msg) { try { await msg.delete(); } catch {} }
async function sendTemp(channel, content, ms = 7000) {
  // Keep bot responses visible; invoking command messages are cleaned up separately.
  return channel.send(content).catch(() => null);
}

function scheduleTemporaryRoleExpiry(guildId, userId, roleId, expiresAt, reason = 'Temporary role expired') {
  const expiryKey = `${guildId}:${userId}:${roleId}`;
  const oldTimer = temporaryRoleTimers.get(expiryKey);
  if (oldTimer) clearTimeout(oldTimer);
  const expire = async () => {
    temporaryRoleTimers.delete(expiryKey);
    const entry = data.temporaryRoles?.[expiryKey];
    if (!entry) return;
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    const role = guild?.roles.cache.get(roleId);
    if (member && role && member.roles.cache.has(roleId)) {
      await member.roles.remove(role, reason).catch(error => console.error('Temporary role removal failed:', error.message));
    }
    delete data.temporaryRoles[expiryKey];
    saveData();
  };
  const delay = Number(expiresAt) - Date.now();
  if (delay <= 0) { void expire(); return; }
  temporaryRoleTimers.set(expiryKey, setTimeout(expire, delay));
}

function recoverTemporaryRoles() {
  if (!data.temporaryRoles || typeof data.temporaryRoles !== 'object') data.temporaryRoles = {};
  for (const entry of Object.values(data.temporaryRoles)) {
    if (entry?.guildId && entry?.userId && entry?.roleId && Number.isFinite(Number(entry.expiresAt))) {
      scheduleTemporaryRoleExpiry(entry.guildId, entry.userId, entry.roleId, Number(entry.expiresAt), entry.reason || 'Temporary role expired');
    }
  }
}

async function auditLog(guild, title, description, color = 0x5865F2, fields = []) {
  const channelId = data.auditChannels[guild.id];
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description || '\u200b')
    .setTimestamp();
  if (fields.length) embed.addFields(fields.slice(0, 25).map(f => ({
    name: truncate(f.name, 256),
    value: truncate(f.value, 1024) || '\u200b',
    inline: !!f.inline
  })));
  await channel.send({ embeds: [embed] }).catch(() => {});
}

function moderationDMEmbed(guild, action, moderator, reason) {
  const colors = { warn: 0xF39C12, kick: 0xE67E22, ban: 0xE74C3C, mute: 0x95A5A6 };
  const labels = { warn: 'Warned', kick: 'Kicked', ban: 'Banned', mute: 'Muted' };
  const icon = guild.iconURL({ extension: 'png', size: 128 });
  return new EmbedBuilder()
    .setColor(colors[action] || 0xF39C12)
    .setTitle(labels[action] || action)
    .setDescription(`You have been ${action === 'kick' ? 'kicked' : action === 'ban' ? 'banned' : action === 'muted' ? 'muted' : 'warned'} in\n**${guild.name}**`)
    .setThumbnail(icon || 'https://cdn.discordapp.com/embed/avatars/0.png')
    .addFields(
      { name: 'Moderator', value: moderator.tag || moderator.username, inline: false },
      { name: 'Reason', value: reason ? truncate(reason) : '\u200b', inline: false },
    )
    .setFooter({ text: `Contact a staff member to discuss this ${action} • ${new Date().toLocaleString('en-GB', { timeZone: 'UTC' })} UTC` });
}

async function dmModeration(targetUser, guild, action, moderator, reason) {
  try { await targetUser.send({ embeds: [moderationDMEmbed(guild, action, moderator, reason)] }); return true; }
  catch { return false; }
}

function warningsFor(guildId, userId) {
  const k = key(guildId, userId);
  if (!Array.isArray(data.warnings[k])) data.warnings[k] = [];
  return data.warnings[k];
}

function normalizeRoleName(text) {
  return String(text || '')
    // Discord custom emoji: <:name:id> / <a:name:id>
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    // Unicode emoji / symbols, variation selectors and zero-width joiners.
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, ' ')
    // Common decorative separators/text-art characters around role names.
    .replace(/[|•·★☆◆◇►◄→←➜➤➥「」『』【】《》<>*_~`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findRole(guild, text) {
  const rawWanted = String(text || '').trim();
  const mentionMatch = rawWanted.match(/^<@&(\d+)>$/);
  const idMatch = rawWanted.match(/^\d{15,25}$/);
  if (mentionMatch) return guild.roles.cache.get(mentionMatch[1]) || null;
  if (idMatch) return guild.roles.cache.get(idMatch[0]) || null;

  const wanted = normalizeRoleName(rawWanted);
  if (!wanted) return null;

  // Exact first, then normalized, then partial normalized matching.
  return guild.roles.cache.find(r => r.name.trim().toLowerCase() === rawWanted.toLowerCase()) ||
         guild.roles.cache.find(r => normalizeRoleName(r.name) === wanted) ||
         guild.roles.cache.find(r => normalizeRoleName(r.name).includes(wanted)) ||
         guild.roles.cache.find(r => wanted.includes(normalizeRoleName(r.name)));
}

function commandList(prefix) {
  return [
    [`${prefix}warn/shout @user [reason]`, 'Warn a member and DM them the warning card.'],
    [`${prefix}unwarn @user <number>`, 'Remove one or more warning numbers.'],
    [`${prefix}warnings @user`, 'Show how many warnings a member has and list their warnings.'],
    [`${prefix}mute/timeout/jail @user <time> [reason]`, 'Timeout a member for a duration.'],
    [`${prefix}unmute/untimeout @user`, 'Remove a member timeout.'],
    [`${prefix}afk [reason]`, 'Set yourself AFK; it is removed when you return.'],
    [`${prefix}nick/ n @user <nickname>`, 'Change a member nickname.'],
    [`${prefix}clearnick/ cn @user`, 'Clear a member nickname.'],
    [`${prefix}serverinfo`, 'Show server statistics and icon.'],
    [`${prefix}roleinfo [@role]`, 'Choose a role from a dropdown or show details for a specified role.'],
    [`${prefix}checkuser @user`, 'Show a normal member profile and tracked warnings received (Level 30+ role).'],
    [`${prefix}modcheck @staff`, 'Staff-only dashboard showing tracked moderation actions issued by a staff member.'],
    [`${prefix}embed #HEX <message>`, 'Send multiline text, Markdown and mentions inside a custom-color embed; attach a photo to include it.'],
    [`${prefix}panelbutton <messageID> | label | #channel or URL`, 'Add a button to one of your bot messages.'],
    [`${prefix}role/ r add|give|remove @user <role>`, 'Add or remove a role by name.'],
    [`${prefix}prefix <prefix>`, 'Change this server’s bot prefix.'],
    [`${prefix}slowmode <time|off>`, 'Set channel slowmode or turn it off, e.g. 10s, 5m, 1h, off.'],
    [`${prefix}lock`, 'Lock this channel so @everyone cannot send messages.'],
    [`${prefix}unlock`, 'Unlock this channel so @everyone can send messages again.'],
    [`${prefix}p/ c/ purge <amount>`, 'Delete recent messages.'],
    [`${prefix}s/ snipe`, 'Show the latest deleted message in this channel.'],
    [`${prefix}cs`, 'Clear deleted-message snipes.'],
    [`${prefix}es`, 'Show the latest edited message in this channel.'],
    [`${prefix}ces`, 'Clear edited-message snipes.'],
    [`${prefix}ticket`, 'Create a single ticket panel with editable embed and button settings.'],
    [`${prefix}multipleticket`, 'Create one shared embed with up to six ticket buttons.'],
    [`${prefix}closeticket/ ct`, 'Close the current ticket.'],
    [`${prefix}say <message>`, 'Send a message as the bot while preserving spaces, line breaks and Discord formatting.'],
    [`${prefix}reply <message>`, 'Reply to the message you selected/replied to as the bot.'],
    [`${prefix}kick @user [reason]`, 'Kick a member and DM the kick card.'],
    [`${prefix}ban/execute @user [reason]`, 'Ban a member and DM the ban card.'],
    [`${prefix}staff @user`, 'Give the Staff role to a member (Manage Roles required).'],
    [`${prefix}poop @user`, 'Give the Poop role for five minutes (boosters or staff only).'],
    [`${prefix}unban <user ID>`, 'Unban a user by ID.'],
    [`${prefix}invite <10m|1h|1d|7d|never> [max uses]`, 'Create a server invite with a chosen expiry and optional use limit.'],
    [`${prefix}Birthday @user`, 'Staff: assign the birthday role for one day.'],
    [`${prefix}endbirthday @user`, 'Staff: remove the birthday role early.'],
    [`${prefix}invite <10m|1h|1d|7d|never> [max uses]`, 'Create a server invite with a chosen expiry and optional use limit.'],
    [`${prefix}pus @user <amount>`, 'Purge a specific member’s recent messages. Example: !pus @user 10.'],
    [`${prefix}report @user <reason>`, 'Privately report a member to the configured 3C User Report channel. 7-minute cooldown per reporter.'],
    [`${prefix}setupreportlog/ setupreport #channel`, 'Connect the 3C User Report log to an existing channel.'],
    [`${prefix}hug @user`, 'Hug a member.'],
    [`${prefix}kiss @user`, 'Kiss a member.'],
    [`${prefix}slap @user`, 'Slap a member.'],
    [`${prefix}ship @user @user`, 'Give two members a random compatibility score and GIF.'],
    [`${prefix}whisper/ w @user <message>`, 'Send a private whisper to a member by DM.'],
    [`${prefix}blehhh @user`, 'Give a member the Blehhh role for five minutes (boosters only).'],
    [`${prefix}unblehhh @user`, 'Remove the Blehhh role immediately (boosters only).'],
    [`${prefix}help <command>`, 'Explain one command.'],
    [`${prefix}setupaudit #channel`, 'Connect 3C audit logs to an existing channel; never creates a new channel.'],
    [`${prefix}webhook help`, 'Manage saved webhooks, custom embeds, link buttons, and scheduled announcements (Manage Webhooks required).'],
    [`${prefix}commands`, 'Show the full command list.'],
  ];
}

async function recoverTicketPanels() {
  // Persisted configs are preferred. This also validates their saved panel messages.
  for (const [id, config] of Object.entries(data.tickets || {})) {
    if (!config?.guildId) continue;
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) continue;
    if (!config.tagIds) config.tagIds = config.tagId ? [config.tagId] : [];
    if (!config.tagTypes) config.tagTypes = config.tagType ? [config.tagType] : [];
  }

  // If a host/redeploy wiped data.json, recover already-posted public panels from Discord.
  // Also recover a report-log channel by its fixed 3C-User-Report name.
  // Existing panel messages contain the stable ticket:create:<id> button. Existing ticket
  // channels let us recover the category, ticket-name base and access roles/users.
  for (const guild of client.guilds.cache.values()) {
    if (!data.reportLogs?.[guild.id]) {
      const reportChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name.toLowerCase() === '3c-user-report');
      if (reportChannel) data.reportLogs[guild.id] = reportChannel.id;
    }

    const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText && c.viewable);
    for (const channel of textChannels.values()) {
      const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!messages) continue;
      for (const msg of messages.values()) {
        const button = msg.components?.flatMap(row => row.components || []).find(comp => comp.customId?.startsWith('ticket:create:'));
        if (!button) continue;
        const id = button.customId.split(':')[2];
        if (data.tickets[id]?.categoryId) continue;

        const embed = msg.embeds?.[0];
        if (!embed) continue;

        // Match an existing ticket to this panel by its actual ticket embed.
        // This matters when a server has multiple ticket types/categories.
        let existingTicket = null;
        const possibleTickets = guild.channels.cache.filter(c =>
          c.type === ChannelType.GuildText &&
          typeof c.topic === 'string' &&
          c.topic.startsWith('3C-TICKET:') &&
          c.name.includes('-ticket-')
        );

        for (const ticketChannel of possibleTickets.values()) {
          const ticketMessages = await ticketChannel.messages.fetch({ limit: 15 }).catch(() => null);
          if (!ticketMessages) continue;
          const ticketEmbed = ticketMessages.find(m =>
            m.author?.id === client.user.id &&
            m.embeds?.[0] &&
            (
              (embed.title && m.embeds[0].footer?.text === embed.title) ||
              (embed.description && m.embeds[0].description?.startsWith(embed.description))
            )
          );
          if (ticketEmbed) {
            existingTicket = ticketChannel;
            break;
          }
        }

        let categoryId = existingTicket?.parentId || null;
        let recoveredName = null;
        let recoveredColor = 0x5865F2;
        let recoveredTags = [];

        if (existingTicket) {
          const marker = existingTicket.name.indexOf('-ticket-');
          if (marker > 0) recoveredName = existingTicket.name.slice(0, marker).replace(/-/g, ' ');
          const everyoneId = guild.roles.everyone.id;
          const meId = client.user.id;
          for (const [overwriteId, overwrite] of existingTicket.permissionOverwrites.cache) {
            if (overwriteId === everyoneId || overwriteId === meId) continue;
            if (overwrite.type === OverwriteType.Role) recoveredTags.push({ id: overwriteId, type: 'role' });
            if (overwrite.type === OverwriteType.Member) {
              const ownerId = existingTicket.topic.split(':')[1];
              if (overwriteId !== ownerId) recoveredTags.push({ id: overwriteId, type: 'user' });
            }
          }
          if (embed.data?.color != null) recoveredColor = embed.data.color;
        }

        if (!data.tickets[id]) {
          data.tickets[id] = {
            guildId: guild.id,
            createdBy: msg.author?.id || guild.ownerId,
            panelChannelId: channel.id,
            panelMessageId: msg.id,
            categoryId,
            name: recoveredName || (embed.title ? embed.title.replace(/^🎟️\s*/,'') : 'ticket'),
            color: recoveredColor,
            title: embed.title || 'Create Ticket',
            description: embed.description || 'Open a ticket and a staff member will help you.',
            embedColor: embed.data?.color ?? 0x5865F2,
            tagId: recoveredTags[0]?.id || null,
            tagType: recoveredTags[0]?.type || null,
            tagIds: recoveredTags.map(t => t.id),
            tagTypes: recoveredTags.map(t => t.type),
          };
        } else {
          data.tickets[id].panelChannelId = channel.id;
          data.tickets[id].panelMessageId = msg.id;
          if (!data.tickets[id].categoryId && categoryId) data.tickets[id].categoryId = categoryId;
          if ((!data.tickets[id].tagIds || !data.tickets[id].tagIds.length) && recoveredTags.length) {
            data.tickets[id].tagIds = recoveredTags.map(t => t.id);
            data.tickets[id].tagTypes = recoveredTags.map(t => t.type);
            data.tickets[id].tagId = recoveredTags[0].id;
            data.tickets[id].tagType = recoveredTags[0].type;
          }
        }
      }
    }
  }
  saveData();
}

client.on('guildAuditLogEntryCreate', (entry, guild) => {
  try {
    const moderatorId = entry.executorId;
    const targetId = entry.targetId;
    if (!moderatorId || moderatorId === client.user?.id) return;
    let action = null;
    if (entry.action === AuditLogEvent.MemberKick) action = 'kick';
    else if (entry.action === AuditLogEvent.MemberBanAdd) action = 'ban';
    else if (entry.action === AuditLogEvent.MemberBanRemove) action = 'unban';
    else if (entry.action === AuditLogEvent.MemberUpdate) {
      const timeoutChange = (entry.changes || []).find(change => change.key === 'communication_disabled_until');
      if (timeoutChange) action = timeoutChange.new ? 'timeout' : 'untimeout';
    }
    if (action) recordStaffAction(guild.id, moderatorId, action, targetId, entry.reason || '', 'discord-audit-log');
  } catch (error) {
    console.error('Staff audit tracking error:', error);
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initializeMongoDB();
  recoverTemporaryRoles();
  recoverSchedules(client, data, saveData);
  await recoverTicketPanels().catch(err => console.error('Ticket recovery error:', err));
  // Register /commands per guild without deleting the server's other application commands.
  if (TOKEN && BOT_APPLICATION_ID) {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const command = new SlashCommandBuilder().setName('commands').setDescription('Show the 3C Bot command list.');
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.post(Routes.applicationGuildCommands(BOT_APPLICATION_ID, guild.id), { body: command.toJSON() });
      } catch (error) {
        console.error(`Could not register /commands in guild ${guild.id}:`, error.message);
      }
    }
  }
  client.user.setPresence({ activities: [{ name: '3C moderation' }], status: 'online' });
});

// React to every message from a member currently holding the Blehhh role.
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  if (message.member?.roles.cache.has(BLEHHH_ROLE_ID)) {
    const emoji = message.guild.emojis.cache.find(e => e.name.toLowerCase() === 'blehhh');
    if (emoji) await message.react(emoji).catch(() => {});
  }
  if (message.member?.roles.cache.has(BIRTHDAY_ROLE_ID)) {
    const cake = message.guild.emojis.cache.find(e => e.name.toLowerCase() === 'birthday_cake');
    if (cake) await message.react(cake).catch(() => {});
  }
  // While the temporary Poop role is active, react to every message this member sends.
  if (message.member?.roles.cache.has(POOP_ROLE_ID)) {
    const poopEmoji = message.guild.emojis.cache.find(e => /poop|poo/i.test(e.name));
    await message.react(poopEmoji || '💩').catch(() => {});
  }
});

client.on('messageDelete', async (message) => {
  if (!message.guild || !message.author || message.author.bot) return;
  // Webhook URLs are credentials: never copy webhook setup commands into snipe history.
  if (/^\s*[!?]webhook\s+add\b/i.test(message.content || '')) return;
  const history = deletedSnipes.get(message.channel.id) || [];
  history.unshift({ authorId: message.author.id, authorTag: message.author.tag, content: message.content || '[no text]', attachments: [...message.attachments.values()].map(a => a.url), time: Date.now() });
  deletedSnipes.set(message.channel.id, history.slice(0, 50));
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!oldMessage.guild || oldMessage.author?.bot) return;
  if (oldMessage.partial || newMessage.partial) return;
  if (oldMessage.content === newMessage.content) return;
  editedSnipes.set(newMessage.channel.id, {
    authorId: newMessage.author.id,
    authorTag: newMessage.author.tag,
    oldContent: oldMessage.content || '[no text]',
    newContent: newMessage.content || '[no text]',
    time: Date.now(),
  });
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const memberForActivity = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (isStaffMember(memberForActivity)) {
    const activity = staffStatsFor(message.guild.id, message.author.id);
    activity.messages = (activity.messages || 0) + 1;
    activity.lastSeen = Date.now();
    const isBotCommand = message.content.startsWith(getPrefix(message.guild.id));
    if (isBotCommand) {
      activity.commands = (activity.commands || 0) + 1;
      activity.lastCommand = Date.now();
    }
    // Keep writes modest: persist every 10th staff message and every command.
    if (isBotCommand || activity.messages % 10 === 0) saveData();
  }
  const prefix = getPrefix(message.guild.id);

  // Only greet an explicit tag of the configured bot application ID.
  const botTagPattern = new RegExp(`<@!?${BOT_APPLICATION_ID}>`);
  if (botTagPattern.test(message.content) && !message.content.trim().startsWith(prefix)) {
    await message.channel.send(`Hi There! My prefix is ${prefix}`).catch(() => {});
  }

  // Mention an AFK member.
  for (const user of message.mentions.users.values()) {
    const a = afk.get(key(message.guild.id, user.id));
    if (a) {
      await sendTemp(message.channel, `💤 **${user.tag}** is AFK${a.reason ? ` — ${a.reason}` : ''}.`, 7000);
    }
  }

  // Coming back from AFK.
  const myAfkKey = key(message.guild.id, message.author.id);
  const myAfk = afk.get(myAfkKey);
  const isAfkCommand = message.content.trim().toLowerCase().startsWith(`${prefix}afk`);
  if (myAfk && !isAfkCommand) {
    afk.delete(myAfkKey);
    await sendTemp(message.channel, `👋 Welcome back, ${message.author}! You were AFK for **${prettyDuration(Date.now() - myAfk.since)}**${myAfk.reason ? ` — ${myAfk.reason}` : ''}.`, 8000);
  }

  if (!message.content.startsWith(prefix)) return;
  const body = message.content.slice(prefix.length).trim();
  if (!body) return;
  const args = tokenize(body);
  const cmd = args.shift().toLowerCase();

  if (cmd === 'webhook') {
    return handleWebhookCommand({ message, args, data, saveData, client });
  }

  // Delete the invoking user's command message after a short delay; bot responses remain visible.
  setTimeout(() => safeDelete(message), 5000);

  let target = message.mentions.members.first();
  if (!target) {
    const rawTarget = args.map(x => x.match(/^<@!?(\d{15,25})>$/)?.[1] || x).find(x => /^\d{15,25}$/.test(x));
    if (rawTarget && message.guild) target = await message.guild.members.fetch(rawTarget).catch(() => null);
  }

  try {
    // FUN GIF REACTIONS
    if (cmd === 'hug' || cmd === 'slap') {
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}${cmd} @user`, 5000);

      const reaction = cmd  ;
      try {
        const response = await fetch(`https://api.otakugifs.xyz/gif?reaction=${reaction}`);
        if (!response.ok) throw new Error(`GIF API returned ${response.status}`);
        const gif = await response.json();
        if (!gif?.url) throw new Error('GIF API returned no URL');

        const embed = new EmbedBuilder()
          .setImage(gif.url)
          .setTimestamp();

        return message.channel.send({
          content: `${message.author} ${reaction === 'hug' ? 'hugged' : 'slapped'} ${target}!`,
          embeds: [embed],
        });
      } catch (error) {
        console.error('GIF API Error:', error);
        return sendTemp(message.channel, `❌ Couldn't get a ${reaction} GIF right now 😭`, 5000);
      }
    }

    if (cmd === "kiss") {
    const target = message.mentions.users.first();

    if (!target) {
        return message.reply("Mention someone to kiss!");
    }
    try {
        const response = await fetch(
            "https://api.otakugifs.xyz/gif?reaction=kiss"
        );

        const data = await response.json();

        const embed = new EmbedBuilder()
            .setImage(data.url)
            .setTimestamp();

        await message.channel.send({
            content: `${message.author} kissed ${target}!`,
            embeds: [embed]
        });

    } catch (error) {
        console.error("GIF API Error:", error);
        await message.reply("Couldn't get a GIF right now 😭");
    }
}
    // SHIP
    if (cmd === 'coinflip') {
    const result = Math.random() < 0.5 ? 'Heads 🪙' : 'Tails 🪙';
    return message.channel.send('🪙 **Coinflip:** ' + result);
  }

  if (cmd === 'ship') {
      const users = [...message.mentions.users.values()].filter(u => !u.bot);
      if (users.length < 2) return sendTemp(message.channel, `Usage: ${prefix}ship @user @user`, 5000);

      const first = users[0];
      const second = users[1];
      const score = Math.floor(Math.random() * 101);
      let verdict = score >= 90 ? '💞 Perfect match' :
        score >= 75 ? '❤️ Pretty strong' :
        score >= 50 ? '💗 There might be something here' :
        score >= 25 ? '💀 The math is struggling' :
        '😭 Absolutely not';

      // Use a curated reaction by compatibility band so the GIF matches the result.
      const reaction = score >= 90 ? 'kiss' : score >= 75 ? 'hug' : score >= 50 ? 'pat' : score >= 25 ? 'slap' : 'cry';
      try {
        const response = await fetch(`https://api.otakugifs.xyz/gif?reaction=${reaction}`);
        if (!response.ok) throw new Error(`GIF API returned ${response.status}`);
        const gif = await response.json();
        const embed = new EmbedBuilder()
          .setColor(0xFF66B3)
          .setTitle('💘 3C Ship Meter')
          .setDescription(`${first} + ${second}\n\n**Compatibility: ${score}%**\n${verdict}`)
          .setTimestamp();
        if (gif?.url) embed.setImage(gif.url);
        return message.channel.send({ embeds: [embed] });
      } catch (error) {
        console.error('Ship GIF Error:', error);
        return message.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xFF66B3)
            .setTitle('💘 3C Ship Meter')
            .setDescription(`${first} + ${second}\n\n**Compatibility: ${score}%**\n${verdict}`)
            .setTimestamp()]
        });
      }
    }

    // WHISPER — Discord prefix commands cannot create an ephemeral message for another member,
    // so this sends the whisper privately to the target's DMs.
    if (cmd === 'whisper' || cmd === 'w') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageMessages)) return sendTemp(message.channel, '❌ You need **Manage Messages** permission to use whisper.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}whisper @user <message>`, 5000);
      if (target.id === message.author.id || target.user.bot) return sendTemp(message.channel, '❌ You cannot whisper to yourself or a bot.', 5000);
      const rawWhisper = message.content.slice(prefix.length + cmd.length).trim();
      const mentionText = message.mentions.users.first()?.toString() || '';
      const whisperText = rawWhisper.replace(mentionText, '').trim();
      if (!whisperText) return sendTemp(message.channel, `Usage: ${prefix}whisper @user <message>`, 5000);
      if (whisperText.length > 1900) return sendTemp(message.channel, '❌ Whisper is too long.', 5000);

      try {
        await target.user.send(`🤫 **Whisper from ${message.author.tag}:**\n${whisperText}`);
      } catch {
        return sendTemp(message.channel, '❌ I could not DM that member. Their DMs may be closed.', 6000);
      }

      await safeDelete(message);
      return message.channel.send('🤫 whisper sent').catch(() => {});
    }

    // BLEHHH
    if (cmd === 'blehhh') {
      if (message.member.roles.cache.has(BLEHHH_ROLE_ID)) {
        return sendTemp(message.channel, '❌ Members with the **Blehhh** role cannot use this command.', 6000);
      }

      const freshInvoker = await message.guild.members.fetch(message.author.id).catch(() => message.member);
      const hasBoosterRole =
        freshInvoker.roles.cache.has(BLEHHH_BOOSTER_ROLE_ID) ||
        freshInvoker.roles.cache.has(BLEHHH_BOOSTER_TOO_ROLE_ID);

      if (!hasBoosterRole) {
        return sendTemp(message.channel, '❌ Only server boosters or members with the **booster toooo** role can use this command.', 6000);
      }

      if (!target) {
        return sendTemp(message.channel, `Usage: ${prefix}blehhh @user`, 6000);
      }

      const duration = TEMP_ROLE_DURATION_MS;

      const cooldownKey = key(message.guild.id, message.author.id);
      const now = Date.now();
      const cooldownUntil = blehhhCooldowns.get(cooldownKey) || 0;
      if (cooldownUntil > now) {
        return sendTemp(message.channel, `⏳ You can use \`${prefix}blehhh\` again in **${Math.ceil((cooldownUntil - now) / 1000)}s**.`, 5000);
      }
      blehhhCooldowns.set(cooldownKey, now + BLEHHH_COOLDOWN_MS);
      setTimeout(() => {
        if ((blehhhCooldowns.get(cooldownKey) || 0) <= Date.now()) blehhhCooldowns.delete(cooldownKey);
      }, BLEHHH_COOLDOWN_MS + 250);

      const blehhhRole = message.guild.roles.cache.get(BLEHHH_ROLE_ID) ||
        message.guild.roles.cache.find(r => r.name.toLowerCase() === 'blehhh');

      if (!blehhhRole) {
        return sendTemp(message.channel, '❌ I could not find the **blehhh** role. Check the role ID/name.', 6000);
      }
      if (blehhhRole.managed || !message.guild.members.me || blehhhRole.position >= message.guild.members.me.roles.highest.position) {
        return sendTemp(message.channel, '❌ I cannot give the **blehhh** role. Move my bot role above it.', 6000);
      }

      try {
        const timerKey = key(message.guild.id, target.id);
        const oldTimer = blehhhTimers.get(timerKey);
        if (oldTimer) clearTimeout(oldTimer);

        await target.roles.add(blehhhRole, `Blehhh by ${message.author.tag} for ${prettyDuration(duration)}`);

        const blehhhEmoji = message.guild.emojis.cache.find(e => e.name === 'blehhh');
        if (blehhhEmoji) await message.react(blehhhEmoji).catch(() => {});
        else await message.react('😛').catch(() => {});

        const expiryKey = `${message.guild.id}:${target.id}:${blehhhRole.id}`;
        data.temporaryRoles[expiryKey] = {
          guildId: message.guild.id, userId: target.id, roleId: blehhhRole.id,
          expiresAt: Date.now() + duration, reason: 'Blehhh duration expired'
        };
        saveData();
        scheduleTemporaryRoleExpiry(message.guild.id, target.id, blehhhRole.id, data.temporaryRoles[expiryKey].expiresAt, 'Blehhh duration expired');

        return sendTemp(message.channel, `😛 ${target} has **5 minutes** of blehhh!`, 5000);
      } catch (err) {
        console.error('Blehhh role error:', err);
        return sendTemp(message.channel, '❌ I could not give the **blehhh** role. Check my role position and Manage Roles permission.', 6000);
      }
    }

    // UNBLEHHH
    if (cmd === 'unblehhh') {
      const freshInvoker = await message.guild.members.fetch(message.author.id).catch(() => message.member);
      const allowed = freshInvoker.roles.cache.has(BLEHHH_BOOSTER_ROLE_ID) || freshInvoker.roles.cache.has(BLEHHH_BOOSTER_TOO_ROLE_ID);
      if (!allowed) return sendTemp(message.channel, '❌ Only Server Boosters or Boost toooo can use this command.', 6000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}unblehhh @user`, 6000);
      const role = message.guild.roles.cache.get(BLEHHH_ROLE_ID);
      if (!role) return sendTemp(message.channel, '❌ I could not find the Blehhh role.', 6000);
      const timerKey = key(message.guild.id, target.id);
      const timer = blehhhTimers.get(timerKey);
      if (timer) clearTimeout(timer);
      blehhhTimers.delete(timerKey);
      const expiryKey = `${message.guild.id}:${target.id}:${role.id}`;
      const roleExpiryTimer = temporaryRoleTimers.get(expiryKey);
      if (roleExpiryTimer) clearTimeout(roleExpiryTimer);
      temporaryRoleTimers.delete(expiryKey);
      delete data.temporaryRoles[expiryKey];
      saveData();
      await target.roles.remove(role, `Unblehhh by ${message.author.tag}`).catch(() => {});
      await auditLog(message.guild, '😛 Member Unblehhh’d', `${target.user} was unblehhh’d by ${message.author}.`, 0x5865F2);
      return sendTemp(message.channel, `✅ ${target} is no longer **blehhh**.`, 5000);
    }
    // NORMAL MEMBER PROFILE: Level 30 role or staff can use this. Does not expose staff-issued statistics.
    if (cmd === 'checkuser' || cmd === 'cu') {
      if (!isLevel30Member(message.member) && !isStaffMember(message.member)) return sendTemp(message.channel, '❌ You need the Level 30 role or staff access to use this command.', 5000);
      const targetUser = message.mentions.users.first();
      if (!targetUser) return sendTemp(message.channel, `Usage: ${prefix}checkuser @user`, 5000);
      const targetMember = await message.guild.members.fetch(targetUser.id).catch(() => null);
      const received = (Array.isArray(data.staffCases[message.guild.id]) ? data.staffCases[message.guild.id] : []).filter(item => item.targetId === targetUser.id);
      const roles = targetMember ? targetMember.roles.cache.filter(role => role.id !== message.guild.id).map(role => role.toString()).slice(0, 15).join(', ') : 'Not currently in this server';
      const embed = new EmbedBuilder().setColor(0x99AAB5)
        .setAuthor({ name: targetUser.tag, iconURL: targetUser.displayAvatarURL() })
        .setTitle('👤 Member Profile')
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: 'Account Created', value: `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:D>`, inline: true },
          { name: 'Joined Server', value: targetMember?.joinedTimestamp ? `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:D>` : 'Not in server', inline: true },
          { name: 'Staff Status', value: targetMember && isStaffMember(targetMember) ? 'Staff member' : 'Not staff', inline: true },
          { name: 'Roles', value: truncate(roles || 'No roles', 1024), inline: false },
          { name: 'Warnings Received (3C tracked)', value: String(warningsFor(message.guild.id, targetUser.id).length), inline: true },
          { name: 'Moderation Cases Received (tracked)', value: String(received.length), inline: true },
          { name: 'Reports Received', value: String(Number(data.reportsReceived?.[key(message.guild.id, targetUser.id)] || 0)), inline: true }
        )
        .setFooter({ text: 'Warning history from other bots is only available if their logs/data are imported.' }).setTimestamp();
      return message.channel.send({ embeds: [embed] });
    }

    // STAFF-ONLY MODERATION DASHBOARD: actions this staff member has issued, as tracked by 3C.
    if (cmd === 'modcheck') {
      if (!isStaffMember(message.member)) return sendTemp(message.channel, '❌ Only authorized staff can use this command.', 5000);
      const targetUser = message.mentions.users.first();
      if (!targetUser) return sendTemp(message.channel, `Usage: ${prefix}modcheck @staff`, 5000);
      const targetMember = await message.guild.members.fetch(targetUser.id).catch(() => null);
      if (!targetMember || !isStaffMember(targetMember)) return sendTemp(message.channel, '❌ You can use this command only to inspect a staff member.', 5000);
      const cases = Array.isArray(data.staffCases[message.guild.id]) ? data.staffCases[message.guild.id] : [];
      const issued = cases.filter(item => item.moderatorId === targetUser.id);
      const received = cases.filter(item => item.targetId === targetUser.id);
      const warningsIssued = Object.entries(data.warnings || {})
        .filter(([warningKey]) => warningKey.startsWith(`${message.guild.id}:`))
        .flatMap(([, items]) => Array.isArray(items) ? items : [])
        .filter(item => item.moderatorId === targetUser.id).length;
      const count = action => action === 'warn' ? Math.max(warningsIssued, issued.filter(item => item.action === 'warn').length) : issued.filter(item => item.action === action).length;
      const stats = staffStatsFor(message.guild.id, targetUser.id);
      const recent = issued.slice(-10).reverse().map(item => `• **${item.action.toUpperCase()}** <@${item.targetId || targetUser.id}> — ${truncate(item.reason || 'No reason', 150)} • <t:${Math.floor(item.at / 1000)}:R>`);
      const embed = new EmbedBuilder().setColor(0x5865F2)
        .setAuthor({ name: targetUser.tag, iconURL: targetUser.displayAvatarURL() })
        .setTitle('🛡️ Staff Moderation Dashboard')
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: 'Warnings Issued', value: String(count('warn')), inline: true },
          { name: 'Kicks Issued', value: String(count('kick')), inline: true },
          { name: 'Bans Issued', value: String(count('ban')), inline: true },
          { name: 'Timeouts Issued', value: String(count('timeout')), inline: true },
          { name: 'Untimeouts Issued', value: String(count('untimeout')), inline: true },
          { name: 'Unbans Issued', value: String(count('unban')), inline: true },
          { name: 'Tickets Closed', value: String(stats.ticketsClosed || 0), inline: true },
          { name: 'Tracked Actions', value: String(issued.length), inline: true },
          { name: 'Moderation Cases Received', value: String(received.length), inline: true },
          { name: 'Recent Actions', value: truncate(recent.join('\n') || 'No tracked staff actions yet.', 1024), inline: false }
        )
        .setFooter({ text: "3C-tracked actions only; other bots' private staff records need to be imported." }).setTimestamp();
      return message.channel.send({ embeds: [embed] });
    }

    // WARN
    if (cmd === 'warn' || cmd === 'shout') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ModerateMembers)) return sendTemp(message.channel, '❌ You need **Moderate Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}warn/shout @user [reason]`, 5000);
      if (!canAct(message.member, target)) return sendTemp(message.channel, '❌ You cannot warn that member because of role hierarchy.', 5000);
      const reason = cleanReason(args.filter(x => !x.startsWith('<@')));
      const list = warningsFor(message.guild.id, target.id);
      list.push({ reason, moderatorId: message.author.id, at: Date.now() });
      recordStaffAction(message.guild.id, message.author.id, 'warn', target.id, reason, '3c');
      saveData();
      await dmModeration(target.user, message.guild, 'warn', message.author, reason);
      await auditLog(message.guild, '⚠️ Member Warned', `${target.user} was warned by ${message.author}.`, 0xF39C12, [
        { name: 'Reason', value: reason || 'No reason' },
      ]);
      return message.channel.send(
        `## ⚠️ **WARNED!**\n${target.user} has been warned for **${reason || 'No reason provided'}**. You Better Not Do It Again!`
      ).catch(() => {});
    }

    // UNWARN
    if (cmd === 'unwarn') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ModerateMembers)) return sendTemp(message.channel, '❌ You need **Moderate Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}unwarn @user <number>`, 5000);
      const nums = args.map(Number).filter(n => Number.isInteger(n) && n > 0);
      if (!nums.length) return sendTemp(message.channel, `Usage: ${prefix}unwarn @user <warning number>`, 5000);
      const list = warningsFor(message.guild.id, target.id);
      const unique = [...new Set(nums)].sort((a,b) => b-a);
      let removed = 0;
      for (const n of unique) if (n <= list.length) { list.splice(n - 1, 1); removed++; }
      saveData();
      return sendTemp(message.channel, `✅ Removed **${removed}** warning${removed === 1 ? '' : 's'} from ${target}.`, 6000);
    }

    // WARNINGS
    if (cmd === 'warnings' || cmd === 'warns') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ModerateMembers)) return sendTemp(message.channel, '❌ You need **Moderate Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}warnings @user`, 5000);
      const list = warningsFor(message.guild.id, target.id);
      if (!list.length) return sendTemp(message.channel, `🛡️ **${target.user.tag}** has **0 warnings**.`, 6000);
      const lines = list.map((w, i) => {
        const reason = w.reason ? ` — ${truncate(w.reason, 500)}` : '';
        const mod = message.guild.members.cache.get(w.moderatorId)?.user.tag || 'Unknown moderator';
        return `**${i + 1}.** ${reason || 'No reason'} • ${mod} • <t:${Math.floor(w.at / 1000)}:R>`;
      });
      const e = new EmbedBuilder().setColor(0xF39C12).setTitle(`Warnings — ${target.user.tag}`).setDescription(lines.join('\n')).setFooter({ text: `Total warnings: ${list.length}` });
      return message.channel.send({ embeds: [e] });
    }

    // MUTE / TIMEOUT / JAIL
    if (cmd === 'mute' || cmd === 'timeout' || cmd === 'jail') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ModerateMembers)) return sendTemp(message.channel, '❌ You need **Moderate Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}${cmd} @user <time> [reason]`, 5000);
      if (!canAct(message.member, target) || !canBotModerate(target)) return sendTemp(message.channel, '❌ I cannot moderate that member because of role hierarchy.', 5000);
      const durationArg = args.find(x => /^\d+(?:\.\d+)?(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.test(x));
      const ms = parseTime(durationArg);
      if (!ms || ms < 1000 || ms > 28 * 86400000) return sendTemp(message.channel, `❌ ${cmd === 'jail' ? 'Jail' : 'Timeout'} duration must be between 1 second and 28 days, e.g. \`10m\` or \`7d\`. Discord's timeout limit is 28 days.`, 7000);
      const reason = cleanReason(args.filter(x => x !== durationArg && !/^<@!?\d+>$/.test(x)));
      const endsAt = Date.now() + ms;
      await target.timeout(ms, reason || undefined);
      recordStaffAction(message.guild.id, message.author.id, 'timeout', target.id, reason, '3c');
      await dmModeration(target.user, message.guild, 'mute', message.author, reason);
      await auditLog(message.guild, cmd === 'jail' ? '🔒 Member Jailed' : '🔇 Member Timed Out', `${target.user} was ${cmd === 'jail' ? 'jailed' : 'timed out'} by ${message.author}.`, 0x95A5A6, [
        { name: 'Duration', value: prettyDuration(ms) },
        { name: 'Return time', value: new Date(endsAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) },
        { name: 'Reason', value: reason || 'No reason' },
      ]);
      const actionLabel = cmd === 'jail' ? 'JAILED' : 'TIMEOUT ACTIVATED';
      return message.channel.send(
        `## **${cmd === 'jail' ? '🔫 OFF TO JAIL THEM' : '🔇 TIMEOUT ACTIVATED'}**\n${target.user} has been ${cmd === 'jail' ? 'jailed' : 'put in timeout'} for **${prettyDuration(ms)}**. They will be back on <t:${Math.floor(endsAt / 1000)}:F> at <t:${Math.floor(endsAt / 1000)}:t>. ${cmd === 'jail' ? 'CRIMINAL!' : ''}${reason ? `\n**Reason:** ${reason}` : ''}`
      ).catch(() => {});
    }
    if (cmd === 'unmute' || cmd === 'untimeout') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ModerateMembers)) return sendTemp(message.channel, '❌ You need **Moderate Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}unmute @user`, 5000);
      if (!canBotModerate(target)) return sendTemp(message.channel, '❌ I cannot unmute that member because their highest role is equal to or higher than my bot role.', 5000);
      await target.timeout(null);
      recordStaffAction(message.guild.id, message.author.id, 'untimeout', target.id, 'Timeout removed', '3c');
      return sendTemp(message.channel, `🔊 **${target.user.tag}** was unmuted.`, 6000);
    }

    // AFK
    if (cmd === 'afk') {
      const reason = cleanReason(args);
      afk.set(myAfkKey, { reason, since: Date.now() });
      return sendTemp(message.channel, `💤 **${message.author.username}** is now AFK${reason ? ` — ${reason}` : ''}.`, 6000);
    }

    // NICK
    if (cmd === 'nick' || cmd === 'n') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageNicknames)) return sendTemp(message.channel, '❌ You need **Manage Nicknames** permission.', 5000);
      if (!target || !args.length) return sendTemp(message.channel, `Usage: ${prefix}nick @user <nickname>`, 5000);
      if (!canAct(message.member, target)) return sendTemp(message.channel, '❌ You cannot nickname that member because of role hierarchy.', 5000);
      const nickname = removeMentionArgs(args).join(' ').trim().slice(0, 32);
      if (!nickname) return sendTemp(message.channel, `Usage: ${prefix}nick @user <nickname>`, 5000);
      await target.setNickname(nickname);
      return sendTemp(message.channel, `✏️ Changed **${target.user.tag}**'s nickname to **${nickname}**.`, 6000);
    }
    if (cmd === 'clearnick' || cmd === 'cn') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageNicknames)) return sendTemp(message.channel, '❌ You need **Manage Nicknames** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}clearnick @user`, 5000);
      if (!canAct(message.member, target)) return sendTemp(message.channel, '❌ You cannot nickname that member because of role hierarchy.', 5000);
      await target.setNickname(null);
      return sendTemp(message.channel, `✅ Cleared ${target}'s nickname.`, 6000);
    }

    // SERVER INFO
    if (cmd === 'serverinfo') {
      const owner = await message.guild.fetchOwner().catch(() => null);
      const icon = message.guild.iconURL({ extension: 'png', size: 512 });
      const e = new EmbedBuilder().setColor(0x5865F2).setTitle(message.guild.name).setThumbnail(icon || null)
        .addFields(
          { name: 'Owner', value: owner ? owner.user.tag : 'Unknown', inline: true },
          { name: 'Members', value: String(message.guild.memberCount), inline: true },
          { name: 'Channels', value: String(message.guild.channels.cache.size), inline: true },
          { name: 'Roles', value: String(message.guild.roles.cache.size), inline: true },
          { name: 'Boosts', value: String(message.guild.premiumSubscriptionCount || 0), inline: true },
          { name: 'Created', value: `<t:${Math.floor(message.guild.createdTimestamp / 1000)}:F>`, inline: false },
        ).setFooter({ text: `Server ID: ${message.guild.id}` });
      return message.channel.send({ embeds: [e] });
    }

    // ROLE INFO — details vertically; permissions arranged in two columns.
    if (cmd === 'roleinfo' || cmd === 'ri') {
      const roleMention = message.mentions.roles.first();
      const roleToken = args.find(x => /^\d{15,25}$/.test(x));
      const role = roleMention || (roleToken ? message.guild.roles.cache.get(roleToken) : null) ||
        (args.length ? findRole(message.guild, args.join(' ')) : null);
      const orderedRoles = [...message.guild.roles.cache.values()].filter(r => r.id !== message.guild.id).sort((a, b) => b.position - a.position);
      if (!role) {
        const options = orderedRoles.slice(0, 25).map(r => ({
          label: truncate(r.name, 100) || 'Unnamed role',
          value: r.id,
          description: truncate(`Members: ${r.members.size} • Position: ${r.position}`, 100)
        }));
        if (!options.length) return sendTemp(message.channel, '❌ No roles are available to display.', 5000);
        const menu = new StringSelectMenuBuilder().setCustomId('roleinfo:select').setPlaceholder('Select a role to view its information').addOptions(options);
        return message.channel.send({ content: 'Choose a role from the list:', components: [new ActionRowBuilder().addComponents(menu)] });
      }
      const positionFromTop = orderedRoles.findIndex(r => r.id === role.id) + 1;
      const permissionNames = role.permissions.toArray().map(p => p.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '));
      const leftPermissions = permissionNames.filter((_, i) => i % 2 === 0);
      const rightPermissions = permissionNames.filter((_, i) => i % 2 === 1);
      const permissionText = list => truncate(list.join('\n') || 'No permissions', 1024);
      const e = new EmbedBuilder().setColor(role.color || 0x5865F2).setTitle('🎭 Role Information')
        .setDescription(`**Role:** ${role}\n**Role ID:** \`${role.id}\`\n**Hoisted:** ${role.hoist ? 'Yes' : 'No'}\n**Mentionable:** ${role.mentionable ? 'Yes' : 'No'}\n**Position from top:** ${positionFromTop} of ${orderedRoles.length}\n**Created:** <t:${Math.floor(role.createdTimestamp / 1000)}:F>`)
        .addFields(
          { name: 'Permissions · 1', value: permissionText(leftPermissions), inline: true },
          { name: 'Permissions · 2', value: permissionText(rightPermissions), inline: true }
        ).setFooter({ text: `Role ID: ${role.id}` });
      return message.channel.send({ embeds: [e] });
    }

    // ROLE
    if (cmd === 'poop') {
      const freshInvoker = await message.guild.members.fetch(message.author.id).catch(() => message.member);
      const allowed = freshInvoker.roles.cache.has(BLEHHH_BOOSTER_ROLE_ID) ||
        freshInvoker.roles.cache.has(BLEHHH_BOOSTER_TOO_ROLE_ID) ||
        freshInvoker.roles.cache.has(STAFF_ROLE_ID);
      if (!allowed) return sendTemp(message.channel, '❌ Only boosters or staff can use this command.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}poop @user`, 5000);
      const role = message.guild.roles.cache.get(POOP_ROLE_ID);
      if (!role) return sendTemp(message.channel, '❌ I could not find the Poop role. Check the role ID.', 5000);
      const botMember = message.guild.members.me;
      if (role.managed || !botMember || role.position >= botMember.roles.highest.position) {
        return sendTemp(message.channel, '❌ I cannot give the Poop role. Move my bot role above it.', 5000);
      }
      try {
        await target.roles.add(role, `Pooped by ${message.author.tag} for 5 minutes`);
        const poopEmoji = message.guild.emojis.cache.find(e => /poop|poo/i.test(e.name));
        if (poopEmoji) await message.react(poopEmoji).catch(() => {});
        else await message.react('💩').catch(() => {});
        const expiryKey = `${message.guild.id}:${target.id}:${role.id}`;
        data.temporaryRoles[expiryKey] = {
          guildId: message.guild.id, userId: target.id, roleId: role.id,
          expiresAt: Date.now() + TEMP_ROLE_DURATION_MS, reason: 'Poop role duration expired'
        };
        saveData();
        scheduleTemporaryRoleExpiry(message.guild.id, target.id, role.id, data.temporaryRoles[expiryKey].expiresAt, 'Poop role duration expired');
        await auditLog(message.guild, '💩 Member Pooped', `${target.user} was given the Poop role by ${message.author} for 5 minutes.`, 0xD6A46B);
        return sendTemp(message.channel, `💩 ${target} has been pooped for **5 minutes**!`, 5000);
      } catch (error) {
        console.error('Poop role error:', error);
        return sendTemp(message.channel, '❌ I could not give the Poop role. Check my Manage Roles permission and role position.', 5000);
      }
    }

    // BIRTHDAY ROLE — staff only, expires automatically after one day.
    if (cmd === 'birthday') {
      if (!isStaffMember(message.member)) return sendTemp(message.channel, '❌ Only staff can use this command.', 5000);
      if (!target) return sendTemp(message.channel, '❌ Mention a server member: !Birthday @user', 5000);
      const role = message.guild.roles.cache.get(BIRTHDAY_ROLE_ID);
      const botMember = message.guild.members.me;
      if (!role || !botMember || role.managed || role.position >= botMember.roles.highest.position) {
        return sendTemp(message.channel, '❌ I cannot assign the birthday role. Check the role ID and move my bot role above it.', 6000);
      }
      try {
        await target.roles.add(role, `Birthday role assigned by ${message.author.tag} for 1 day`);
        const expiryKey = `${message.guild.id}:${target.id}:${role.id}`;
        data.temporaryRoles[expiryKey] = {
          guildId: message.guild.id, userId: target.id, roleId: role.id,
          expiresAt: Date.now() + BIRTHDAY_DURATION_MS, reason: 'Birthday role expired after one day'
        };
        saveData();
        scheduleTemporaryRoleExpiry(message.guild.id, target.id, role.id, data.temporaryRoles[expiryKey].expiresAt, 'Birthday role expired after one day');
        const cake = message.guild.emojis.cache.find(e => e.name.toLowerCase() === 'birthday_cake');
        if (cake) await message.react(cake).catch(() => {});
        return sendTemp(message.channel, `🎂 ${target} has received the birthday role for **1 day**! Happy birthday!`, 6000);
      } catch (error) {
        console.error('Birthday role error:', error);
        return sendTemp(message.channel, '❌ I could not assign the birthday role. Check Manage Roles and role hierarchy.', 6000);
      }
    }

    if (cmd === 'endbirthday') {
      if (!isStaffMember(message.member)) return sendTemp(message.channel, '❌ Only staff can use this command.', 5000);
      if (!target) return sendTemp(message.channel, '❌ Mention the member: !endbirthday @user', 5000);
      const role = message.guild.roles.cache.get(BIRTHDAY_ROLE_ID);
      const expiryKey = `${message.guild.id}:${target.id}:${BIRTHDAY_ROLE_ID}`;
      const timer = temporaryRoleTimers.get(expiryKey);
      if (timer) clearTimeout(timer);
      temporaryRoleTimers.delete(expiryKey);
      delete data.temporaryRoles[expiryKey];
      try {
        if (role && target.roles.cache.has(BIRTHDAY_ROLE_ID)) await target.roles.remove(role, `Birthday role ended by ${message.author.tag}`);
        saveData();
        return sendTemp(message.channel, `✅ Ended ${target}'s birthday role.`, 5000);
      } catch (error) {
        console.error('End birthday error:', error);
        return sendTemp(message.channel, '❌ I could not remove the birthday role. Check Manage Roles and role hierarchy.', 6000);
      }
    }

    if (cmd === 'staff') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageRoles)) return sendTemp(message.channel, '❌ You need **Manage Roles** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}staff @user`, 5000);
      const role = message.guild.roles.cache.get(STAFF_ROLE_ID);
      if (!role) return sendTemp(message.channel, '❌ I could not find the Staff role.', 5000);
      const botMember = message.guild.members.me;
      if (role.managed || !botMember || role.position >= botMember.roles.highest.position) return sendTemp(message.channel, '❌ I cannot assign the Staff role. Move my bot role above it.', 5000);
      if (message.author.id !== message.guild.ownerId && (target.roles.highest.position >= message.member.roles.highest.position || role.position >= message.member.roles.highest.position)) {
        return sendTemp(message.channel, '❌ You can only manage members and roles below your highest role.', 5000);
      }
      if (target.roles.cache.has(role.id)) return sendTemp(message.channel, `ℹ️ ${target} already has the Staff role.`, 5000);
      await target.roles.add(role, `Staff role granted by ${message.author.tag}`);
      await auditLog(message.guild, '🛡️ Staff Role Granted', `${message.author} gave the Staff role to ${target}.`, 0x57F287);
      return sendTemp(message.channel, `✅ ${target} has been given the Staff role.`, 5000);
    }

    if (cmd === 'role' || cmd === 'r') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageRoles)) return sendTemp(message.channel, '❌ You need **Manage Roles** permission.', 5000);
      const action = (args.shift() || '').toLowerCase();
      if (!['add','give','remove'].includes(action) || !target) return sendTemp(message.channel, `Usage: ${prefix}role add|give|remove @user <role>`, 5000);
      const roleText = removeMentionArgs(args).join(' ').trim();
      const role = findRole(message.guild, roleText);
      if (!role) return sendTemp(message.channel, '❌ I could not find that role. You can use the role name, role mention, or role ID.', 5000);
      const me = await message.guild.members.fetchMe().catch(() => message.guild.members.me);
      if (!me) return sendTemp(message.channel, '❌ I could not check my bot role hierarchy.', 5000);
      if (role.managed || role.id === message.guild.id || role.position >= me.roles.highest.position) {
        return sendTemp(message.channel, '❌ I cannot manage that role. Move my bot role above it.', 5000);
      }
      if (target.id === message.guild.ownerId) return sendTemp(message.channel, '❌ I cannot change roles on the server owner.', 5000);
      if (target.id !== message.author.id && target.roles.highest.position >= me.roles.highest.position) {
        return sendTemp(message.channel, '❌ I cannot change roles for a member whose highest role is equal to or above my bot role.', 5000);
      }
      try {
        if (action === 'remove') await target.roles.remove(role);
        else await target.roles.add(role);
      } catch (roleErr) {
        console.error('Role assignment error:', roleErr);
        return sendTemp(message.channel, '❌ I could not change that role. Make sure my bot role is above the role you are trying to give/remove and that I have **Manage Roles**.', 6000);
      }
      return sendTemp(message.channel, `✅ ${action === 'remove' ? 'Removed' : 'Added'} **${role.name}** ${action === 'remove' ? 'from' : 'to'} ${target}.`, 6000);
    }

    // PREFIX
    if (cmd === 'prefix') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageGuild)) return sendTemp(message.channel, '❌ You need **Manage Server** permission.', 5000);
      if (!args[0]) return sendTemp(message.channel, `Current prefix: \`${prefix}\``, 5000);
      if (args[0].length > 5 || /\s/.test(args[0])) return sendTemp(message.channel, '❌ Prefix must be 1–5 characters with no spaces.', 5000);
      data.prefixes[message.guild.id] = args[0]; saveData();
      return sendTemp(message.channel, `✅ Prefix changed to \`${args[0]}\`.`, 6000);
    }

    // SLOWMODE
    if (cmd === 'slowmode') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageChannels)) return sendTemp(message.channel, '❌ You need **Manage Channels** permission.', 5000);
      const input = (args[0] || '').toLowerCase();
      if (input === 'off') {
        await message.channel.setRateLimitPerUser(0);
        return sendTemp(message.channel, `🐌 Slowmode **disabled** in ${message.channel}.`, 6000);
      }
      const ms = parseTime(args[0]);
      if (ms == null || ms < 0 || ms > 21600 * 1000) return sendTemp(message.channel, '❌ Slowmode must be 0–6h, e.g. `10s`, `2m`, `1h`, or `off`.', 5000);
      await message.channel.setRateLimitPerUser(Math.floor(ms / 1000));
      return sendTemp(message.channel, `🐌 Slowmode set to **${prettyDuration(ms)}** in ${message.channel}.`, 6000);
    }

    // LOCK / UNLOCK CHANNEL
    if (cmd === 'lock' || cmd === 'unlock') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageChannels)) return sendTemp(message.channel, '❌ You need **Manage Channels** permission.', 5000);
      if (!message.guild.members.me.permissionsIn(message.channel).has(PermissionsBitField.Flags.ManageChannels)) return sendTemp(message.channel, '❌ I need **Manage Channels** permission in this channel.', 5000);

      const everyone = message.guild.roles.everyone;
      if (cmd === 'lock') {
        await message.channel.permissionOverwrites.edit(everyone, { SendMessages: false });
        return sendTemp(message.channel, '🔒 Channel **locked**. @\u200beveryone can no longer send messages.', 6000);
      }

      await message.channel.permissionOverwrites.edit(everyone, { SendMessages: null });
      return sendTemp(message.channel, '🔓 Channel **unlocked**. @\u200beveryone can send messages again.', 6000);
    }

    // PURGE
    if (cmd === 'p' || cmd === 'c' || cmd === 'purge') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageMessages)) return sendTemp(message.channel, '❌ You need **Manage Messages** permission.', 5000);
      const amount = Number(args[0]);
      if (!Number.isInteger(amount) || amount < 1 || amount > 99) return sendTemp(message.channel, `Usage: ${prefix}purge <1-99>`, 5000);

      // Delete the requested number of other messages, plus the user's command.
      const fetched = await message.channel.messages.fetch({ limit: Math.min(100, amount + 1) });
      const deleted = await message.channel.bulkDelete(fetched, true);
      const deletedOtherMessages = Math.max(0, deleted.size - (deleted.has(message.id) ? 1 : 0));

      if (deletedOtherMessages > 10) {
        await auditLog(message.guild, '🧹 Messages Purged', `${message.author} purged **${deletedOtherMessages}** messages in ${message.channel}.`, 0x5865F2, [
          { name: 'Moderator', value: `${message.author.tag} (${message.author.id})` },
          { name: 'Channel', value: `${message.channel} (${message.channel.id})` },
          { name: 'Messages Deleted', value: String(deletedOtherMessages), inline: true },
        ]);
      }

      return sendTemp(message.channel, `🧹 Deleted **${deletedOtherMessages}** messages + the command.`, 5000);
    }

    // SNIPE
    if (cmd === 's' || cmd === 'snipe') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageMessages)) return sendTemp(message.channel, '❌ You need **Manage Messages** permission.', 5000);
      const history = deletedSnipes.get(message.channel.id) || [];
      const requested = Number(args[0]);
      const index = Number.isInteger(requested) && requested > 0 ? requested - 1 : 0;
      const s = history[index];
      if (!s) return sendTemp(message.channel, `Nothing to snipe at #${requested || 1} in this channel.`, 5000);
      const e = new EmbedBuilder().setColor(0xED4245).setTitle('🗑️ Deleted message')
        .setAuthor({ name: s.authorTag })
        .setDescription(truncate(s.content, 4000))
        .setTimestamp(s.time);
      if (s.attachments?.length) e.addFields({ name: 'Attachments', value: s.attachments.map(x => `[attachment](${x})`).join('\n').slice(0, 1024) });
      return message.channel.send({ embeds: [e] });
    }
    if (cmd === 'cs') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageMessages)) return sendTemp(message.channel, '❌ You need **Manage Messages** permission.', 5000);
      deletedSnipes.delete(message.channel.id);
      await message.react('✅').catch(() => {});
      return;
    }
    if (cmd === 'es') {
      const s = editedSnipes.get(message.channel.id);
      if (!s) return sendTemp(message.channel, 'Nothing to snipe from edits in this channel.', 5000);
      const e = new EmbedBuilder().setColor(0xFEE75C).setTitle('✏️ Edited message').setAuthor({ name: s.authorTag })
        .addFields({ name: 'Before', value: truncate(s.oldContent, 1024) }, { name: 'After', value: truncate(s.newContent, 1024) }).setTimestamp(s.time);
      return message.channel.send({ embeds: [e] });
    }
    if (cmd === 'ces') {
      editedSnipes.delete(message.channel.id);
      await message.react('✅').catch(() => {});
      return;
    }

    // TICKET PANEL CREATOR — ?ticket posts a setup button; the button opens the modal.
    if (cmd === 'ticket') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageGuild)) return sendTemp(message.channel, '❌ You need **Manage Server** permission.', 5000);
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
      data.tickets[id] = { guildId: message.guild.id, createdBy: message.author.id, panelChannelId: message.channel.id, panelMessageId: null, categoryId: null, name: 'ticket', color: 0x5865F2, title: 'Create Ticket', embedColor: 0x5865F2, tagId: null, tagType: null, tagIds: [], tagTypes: [] };
      saveData();
      const b = new ButtonBuilder().setCustomId(`ticket:setupopen:${id}`).setLabel('Set Up Ticket Panel').setEmoji('🎟️').setStyle(ButtonStyle.Primary);
      await safeDelete(message);
      const setupMessage = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🎟️ Ticket Panel Setup').setDescription('Click the button below to open the ticket setup form.')], components: [new ActionRowBuilder().addComponents(b)] });
      data.tickets[id].setupMessageId = setupMessage.id;
      saveData();
      return setupMessage;
    }
    // MULTI-TICKET PANEL — up to six independently configured ticket types on one public panel.
    if (cmd === 'multipleticket') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageGuild)) return sendTemp(message.channel, '❌ You need **Manage Server** permission.', 5000);
      const groupId = `multi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
      data.ticketPanels[groupId] = { guildId: message.guild.id, createdBy: message.author.id, panelChannelId: message.channel.id, panelMessageId: null, ticketIds: [], panelTitle: 'General Support 📬', panelDescription: 'Choose a ticket type below and our team will help you.', footerText: '3C Bot ~ Built for Rivals. United by 3C.', embedColor: 0x232428 };
      const id = `mt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
      data.tickets[id] = { guildId: message.guild.id, createdBy: message.author.id, panelChannelId: message.channel.id, panelMessageId: null, categoryId: null, name: 'ticket', color: 0x5865F2, title: 'Create Ticket', embedColor: 0x5865F2, tagId: null, tagType: null, tagIds: [], tagTypes: [], panelGroupId: groupId };
      data.ticketPanels[groupId].ticketIds.push(id);
      saveData();
      const b = new ButtonBuilder().setCustomId(`ticket:setupopen:${id}`).setLabel('Set Up First Ticket Type').setEmoji('🎟️').setStyle(ButtonStyle.Primary);
      await safeDelete(message);
      const setupMessage = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🎟️ Multi-Ticket Panel Setup').setDescription('Configure the first ticket type. You can add more buttons after it is created (up to 6 types per panel).')], components: [new ActionRowBuilder().addComponents(b)] });
      data.tickets[id].setupMessageId = setupMessage.id;
      saveData();
      return setupMessage;
    }
    // CLOSE TICKET — message command accepts a reason; button opens the reason modal.
    if (cmd === 'closeticket' || cmd === 'ct') {
      const topic = message.channel.topic || '';
      if (!topic.startsWith('3C-TICKET:')) return sendTemp(message.channel, '❌ This is not a 3C ticket channel.', 5000);
      const topicParts = topic.split(':');
      const ownerId = topicParts[1];
      const ticketConfig = data.tickets[topicParts[2]];
      const tagIds = ticketConfig?.tagIds || (ticketConfig?.tagId ? [ticketConfig.tagId] : []);
      const tagTypes = ticketConfig?.tagTypes || (ticketConfig?.tagType ? [ticketConfig.tagType] : []);
      const isSelectedUser = tagIds.some((id, i) => tagTypes[i] === 'user' && id === message.author.id);
      const isSelectedRole = tagIds.some((id, i) => tagTypes[i] === 'role' && message.member.roles.cache.has(id));
      const isStaff = hasPerm(message.member, PermissionsBitField.Flags.ManageChannels);
      if (message.author.id !== ownerId && !isSelectedUser && !isSelectedRole && !isStaff) return sendTemp(message.channel, '❌ Only the ticket creator, selected ticket staff, or staff with Manage Channels can close this ticket.', 5000);
      const reason = args.join(' ').trim();
      if (!reason) return sendTemp(message.channel, `Usage: ${prefix}closeticket <reason> — or click the **Close Ticket** button to enter a reason in a form.`, 7000);
      const ticket = message.channel, category = ticket.parent;
      if (isStaff) {
        const stats = staffStatsFor(message.guild.id, message.author.id);
        stats.ticketsClosed = (stats.ticketsClosed || 0) + 1;
        stats.lastSeen = Date.now();
        saveData();
      }
      await auditLog(message.guild, '🔒 Ticket Closed', `${ticket} was closed by ${message.author}.`, 0xED4245, [
        { name: 'Closed By', value: `${message.author.tag} (${message.author.id})` },
        { name: 'Ticket Creator', value: `<@${ownerId}> (${ownerId})` },
        { name: 'Channel', value: `#${ticket.name} (${ticket.id})` },
        { name: 'Category', value: category ? `${category.name} (${category.id})` : 'Unknown' },
        { name: 'Close Reason', value: truncate(reason, 1000) }
      ]);
      await safeDelete(message);
      await ticket.send(`🔒 Ticket closed by ${message.author}. **Reason:** ${reason}`);
      setTimeout(() => ticket.delete(`Ticket closed by ${message.author.tag}: ${reason}`.slice(0, 512)).catch(() => {}), 1500);
      return;
    }
    // SAY — use raw message content so spacing, newlines, #, @ and Discord formatting survive.
    if (cmd === 'say') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageGuild)) return sendTemp(message.channel, '❌ You need **Manage Server** permission.', 5000);
      const rawSay = message.content.slice(prefix.length + cmd.length).trimStart();
      const files = [...message.attachments.values()].map(a => a.url);
      if (!rawSay && files.length === 0) return sendTemp(message.channel, `Usage: ${prefix}say <message> (you can also attach a photo)`, 5000);
      await safeDelete(message);
      return message.channel.send({ content: rawSay || undefined, files, allowedMentions: { parse: [] } });
    }

    // REPLY — reply/select a message first, then use !reply <message>; attachments are forwarded too.
    if (cmd === 'reply') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageGuild)) return sendTemp(message.channel, '❌ You need **Manage Server** permission.', 5000);
      const rawReply = message.content.slice(prefix.length + cmd.length).trimStart();
      const files = [...message.attachments.values()].map(a => a.url);
      const referenceId = message.reference?.messageId;
      if (!referenceId) return sendTemp(message.channel, `❌ First reply to the message you want to target, then use ${prefix}reply <message>.`, 6000);
      if (!rawReply && files.length === 0) return sendTemp(message.channel, `Usage: ${prefix}reply <message> (you can also attach a photo)`, 5000);
      const referenced = await message.channel.messages.fetch(referenceId).catch(() => null);
      if (!referenced) return sendTemp(message.channel, '❌ I could not find the selected message.', 5000);
      await safeDelete(message);
      return message.channel.send({
        content: rawReply || undefined,
        files,
        reply: { messageReference: referenced.id, failIfNotExists: false },
        allowedMentions: { parse: [] },
      });
    }
    // KICK
    if (cmd === 'kick') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.KickMembers)) return sendTemp(message.channel, '❌ You need **Kick Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}kick @user [reason]`, 5000);
      if (!canAct(message.member, target)) return sendTemp(message.channel, '❌ You cannot kick that member because of role hierarchy.', 5000);
      const reason = cleanReason(args.filter(x => !x.startsWith('<@')));
      await dmModeration(target.user, message.guild, 'kick', message.author, reason);
      await target.kick(reason || undefined);
      recordStaffAction(message.guild.id, message.author.id, 'kick', target.id, reason, '3c');
      await auditLog(message.guild, '👢 Member Kicked', `${target.user} was kicked by ${message.author}.`, 0xE67E22, [
        { name: 'Reason', value: reason || 'No reason' },
      ]);
      const kickEmbed = new EmbedBuilder()
        .setColor(0xE67E22)
        .setTitle('👢 OUT YOU GO!')
        .setDescription(`**${target.user.tag}** has been kicked from the server.`)
        .addFields({ name: 'Reason', value: reason || 'No reason provided.' }, { name: 'Moderator', value: `${message.author}`, inline: true })
        .setFooter({ text: '3C Bot • Moderation action' })
        .setTimestamp();
      return message.channel.send({ embeds: [kickEmbed] }).catch(() => {});
    }

    // BAN
    if (cmd === 'ban' || cmd === 'execute') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.BanMembers)) return sendTemp(message.channel, '❌ You need **Ban Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, '❌ Mention a current server member to ban.', 5000);
      if (!canAct(message.member, target)) return sendTemp(message.channel, '❌ You cannot ban that member because of role hierarchy.', 5000);
      const reason = cleanReason(args.filter(x => !x.startsWith('<@')));
      await dmModeration(target.user, message.guild, 'ban', message.author, reason);
      await target.ban({ reason: reason || undefined });
      recordStaffAction(message.guild.id, message.author.id, 'ban', target.id, reason, '3c');
      await auditLog(message.guild, '🔨 Member Banned', `${target.user} was banned by ${message.author}.`, 0xE74C3C, [
        { name: 'Reason', value: reason || 'No reason' },
      ]);
      return message.channel.send(
        `## **🪓 OFF TO CHOP THEIR HEAD 🪓**\n${target.user} has been executed! They have been **Banned**. *Justice Has Been Served!*${reason ? `\n**Reason:** ${reason}` : ''}`
      ).catch(() => {});
    }

    // UNBAN — accepts resolved mentions, raw mention syntax, and plain user IDs.
    if (cmd === 'unban') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.BanMembers)) return sendTemp(message.channel, '❌ You need **Ban Members** permission.', 5000);
      const rawId = args.map(x => {
        const mention = x.match(/^<@!?(\d{15,25})>$/);
        return mention ? mention[1] : x;
      }).find(x => /^\d{15,25}$/.test(x));
      const id = message.mentions.users.first()?.id || rawId;
      if (!/^\d{15,25}$/.test(id || '')) return sendTemp(message.channel, `Usage: ${prefix}unban @user or ${prefix}unban USER_ID`, 6000);
      let ban;
      try {
        ban = await message.guild.bans.fetch(id);
      } catch (error) {
        console.error('Unban lookup failed:', error);
        return sendTemp(message.channel, '❌ I could not check that ban. Check my **Ban Members** permission and try again.', 6000);
      }
      if (!ban) return sendTemp(message.channel, '❌ That user is not currently banned from this server.', 6000);
      try {
        await message.guild.members.unban(id, `Unbanned by ${message.author.tag}`);
      } catch (error) {
        console.error('Unban action failed:', error);
        return sendTemp(message.channel, '❌ I found the ban but could not remove it. Check my **Ban Members** permission.', 6000);
      }
      recordStaffAction(message.guild.id, message.author.id, 'unban', id, `Unbanned by ${message.author.tag}`, '3c');
      return sendTemp(message.channel, `✅ Unbanned **${ban.user.tag}** (${id}).`, 6000);
    }

    // CREATE SERVER INVITE — usage: !invite <10m|1h|1d|7d|never> [max uses]
    if (cmd === 'invite' || cmd === 'createinvite') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.CreateInstantInvite)) return sendTemp(message.channel, '❌ You need **Create Invite** permission.', 5000);
      if (!message.channel || !message.channel.isTextBased() || !message.channel.createInvite) return sendTemp(message.channel, '❌ I cannot create an invite from this channel.', 5000);
      const durationText = (args[0] || '1h').toLowerCase();
      const durationMap = { '10m': 600, '1h': 3600, '1d': 86400, '7d': 604800, 'never': 0 };
      if (!Object.prototype.hasOwnProperty.call(durationMap, durationText)) {
        return sendTemp(message.channel, `Usage: ${prefix}invite <10m|1h|1d|7d|never> [max uses]`, 7000);
      }
      const maxUses = args[1] === undefined ? 0 : Number(args[1]);
      if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > 100) return sendTemp(message.channel, `❌ Max uses must be 0 (unlimited) or a number from 1 to 100. Example: ${prefix}invite 1d 10`, 7000);
      try {
        const invite = await message.channel.createInvite({
          maxAge: durationMap[durationText],
          maxUses,
          unique: true,
          reason: `Invite created by ${message.author.tag} using 3C Bot`
        });
        const expiryLabel = durationText === 'never' ? 'Never (no expiry)' : durationText;
        const usesLabel = maxUses === 0 ? 'Unlimited' : String(maxUses);
        return message.channel.send({
          content: `🔗 **Server invite created!**\n${invite.url}\n**Expires:** ${expiryLabel}\n**Max uses:** ${usesLabel}\n**Created by:** ${message.author}`,
          allowedMentions: { users: [message.author.id] }
        });
      } catch (error) {
        console.error('Invite creation failed:', error);
        return sendTemp(message.channel, '❌ I could not create the invite. Check my **Create Invite** permission in this channel.', 6000);
      }
    }

    // PURGE USER
    if (cmd === 'pus') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageMessages)) return sendTemp(message.channel, '❌ You need **Manage Messages** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}pus @user <amount>`, 5000);
      const amount = Number(removeMentionArgs(args)[0]);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) return sendTemp(message.channel, `Usage: ${prefix}pus @user <1-100>`, 5000);
      const fetched = await message.channel.messages.fetch({ limit: 100 });
      const matches = fetched.filter(m => m.author.id === target.id).first(amount);
      let deleted = 0;
      const recent = matches.filter(m => Date.now() - m.createdTimestamp < 14 * 86400000);
      if (recent.size) deleted += (await message.channel.bulkDelete(recent, true)).size;
      for (const m of matches.filter(m => !recent.has(m.id)).values()) { await m.delete().then(() => deleted++).catch(() => {}); }
      return sendTemp(message.channel, `🧹 Deleted **${deleted}** messages from **${target.user.tag}**.`, 6000);
    }

    // USER REPORTS
    if (cmd === 'report') {
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}report @user <reason>`, 5000);
      if (target.id === message.author.id || target.user.bot) {
        return sendTemp(message.channel, '❌ You cannot report yourself or a bot.', 5000);
      }

      const reason = cleanReason(removeMentionArgs(args));
      if (!reason) return sendTemp(message.channel, `Usage: ${prefix}report @user <reason>`, 5000);
      if (reason.length > 1000) return sendTemp(message.channel, '❌ Your report reason is too long.', 5000);

      const cooldownKey = key(message.guild.id, message.author.id);
      const now = Date.now();
      const savedUntil = Number(data.reportCooldowns?.[cooldownKey] || 0);
      const memoryUntil = reportCooldowns.get(cooldownKey) || 0;
      const cooldownUntil = Math.max(savedUntil, memoryUntil);
      if (cooldownUntil > now) {
        return sendTemp(message.channel, `⏳ You can submit another report in **${prettyDuration(cooldownUntil - now)}**.`, 6000);
      }

      const reportChannelId = data.reportLogs?.[message.guild.id];
      const reportChannel = reportChannelId ? message.guild.channels.cache.get(reportChannelId) : null;
      if (!reportChannel || !reportChannel.isTextBased()) {
        return sendTemp(message.channel, `❌ Report logging is not set up. An admin should run ${prefix}setupreport #channel.`, 7000);
      }

      const reportEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🚨 3C User Report')
        .addFields(
          { name: 'Reported By', value: `${message.author} (${message.author.tag})`, inline: true },
          { name: 'Reported Member', value: `${target} (${target.user.tag})`, inline: true },
          { name: 'Reason', value: truncate(reason, 1000), inline: false },
          { name: 'Channel', value: `${message.channel} (${message.channel.id})`, inline: false },
        )
        .setTimestamp();

      try {
        await reportChannel.send({ embeds: [reportEmbed] });
      } catch (err) {
        console.error('Report log error:', err);
        return sendTemp(message.channel, '❌ I could not submit the report right now.', 6000);
      }

      const until = now + (7 * 60 * 1000);
      if (!data.reportsReceived) data.reportsReceived = {};
      const reportedKey = key(message.guild.id, target.id);
      data.reportsReceived[reportedKey] = Number(data.reportsReceived[reportedKey] || 0) + 1;
      reportCooldowns.set(cooldownKey, until);
      data.reportCooldowns[cooldownKey] = until;
      saveData();
      await safeDelete(message);
      return message.channel.send('report successfully submitted').catch(() => {});
    }

    // REPORT LOG SETUP — connect to an existing channel only; never create a channel.
    if (cmd === 'setupreportlog' || cmd === 'setupreport') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.Administrator)) {
        return sendTemp(message.channel, `❌ Only members with **Administrator** permission can use ${prefix}setupreport or ${prefix}setupreportlog.`, 5000);
      }

      const mentionedChannel = message.mentions.channels.first();
      const requestedId = args.find(x => /^\d{15,25}$/.test(x));
      const reportChannel = mentionedChannel ||
        (requestedId ? message.guild.channels.cache.get(requestedId) : null) ||
        (message.channel.type === ChannelType.GuildText ? message.channel : null);

      if (!reportChannel || !reportChannel.isTextBased() || reportChannel.guildId !== message.guild.id) {
        return sendTemp(message.channel, `❌ Use ${prefix}setupreport #existing-channel (or run it inside the report channel). No channel will be created.`, 7000);
      }

      const me = message.guild.members.me;
      const canWrite = me && reportChannel.permissionsFor(me).has([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks,
      ]);
      if (!canWrite) return sendTemp(message.channel, '❌ I cannot write in that report channel. Give the bot View Channel, Send Messages and Embed Links.', 7000);

      data.reportLogs[message.guild.id] = reportChannel.id;
      saveData();
      await reportChannel.send({
        embeds: [new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('🚨 3C User Report Log Connected')
          .setDescription('User reports will be logged here with the reporter, reported member and reason.')
          .addFields({ name: 'Channel', value: String(reportChannel) })
          .setTimestamp()]
      }).catch(() => {});
      return sendTemp(message.channel, `✅ 3C User Reports are now connected to ${reportChannel}.`, 6000);
    }

    // AUDIT LOG SETUP — connect to an EXISTING channel; never create one.
    if (cmd === 'setupaudit') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.Administrator)) {
        return sendTemp(message.channel, `❌ Only members with **Administrator** permission can use ${prefix}setupaudit.`, 5000);
      }

      const mentionedChannel = message.mentions.channels.first();
      const requestedId = args.find(x => /^\d{15,25}$/.test(x));
      const auditChannel = mentionedChannel ||
        (requestedId ? message.guild.channels.cache.get(requestedId) : null) ||
        (message.channel.type === ChannelType.GuildText ? message.channel : null);

      if (!auditChannel || !auditChannel.isTextBased() || auditChannel.guildId !== message.guild.id) {
        return sendTemp(message.channel, `❌ Use ${prefix}setupaudit #existing-audit-channel (or run ${prefix}setupaudit inside that channel).`, 7000);
      }

      const me = message.guild.members.me;
      const canWrite = me && auditChannel.permissionsFor(me).has([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks,
      ]);
      if (!canWrite) return sendTemp(message.channel, '❌ I cannot write in that audit channel. Give the bot View Channel, Send Messages and Embed Links.', 7000);

      data.auditChannels[message.guild.id] = auditChannel.id;
      saveData();
      await auditChannel.send({
        embeds: [new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle('🛡️ 3C Audit Log Connected')
          .setDescription('This existing channel is now the 3C bot audit-log destination.')
          .addFields({ name: 'Channel', value: String(auditChannel) })
          .setTimestamp()]
      }).catch(() => {});
      return sendTemp(message.channel, `✅ 3C audit logs are now connected to ${auditChannel}.`, 6000);
    }
    // HELP / COMMANDS
    if (cmd === 'commands') {
      const pages = [
        ['🛡️ 3C Moderation', ['warn/shout','unwarn','warnings','mute/timeout/jail','unmute/untimeout','kick','ban/execute','unban']],
        ['🧹 3C Management', ['p/ c/ purge','pus','s/ snipe','cs','es','ces','nick/ n','clearnick/ cn','role/ r add|give|remove','roleinfo','staff','slowmode','lock','unlock']],
        ['🎟️ 3C Tickets & Server', ['ticket','multipleticket','closeticket/ ct','setupaudit','serverinfo','prefix','say','reply']],
        ['😛 3C Fun & Other', ['hug','kiss','slap','blehhh','unblehhh','poop','afk','help']]
      ];
      const [title, keys] = pages[0];
      const lines = keys.map(k => {
        const f = commandList(prefix).find(([a]) => a.includes(k));
        return f ? `**${f[0]}** — ${f[1]}` : `**${prefix}${k}**`;
      });
      const e = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(title)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Page 1/${pages.length} • Prefix: ${prefix}` });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('commands:prev:0').setEmoji('◀️').setLabel('Back').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('commands:home:0').setEmoji('🏠').setLabel('Home').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('commands:next:0').setEmoji('▶️').setLabel('Next').setStyle(ButtonStyle.Secondary)
      );

      return message.channel.send({ embeds: [e], components: [row] });
    }
    if (cmd === 'embed') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return sendTemp(message.channel, 'You need Manage Messages to create embeds.', 6000);
      }
      const raw = message.content.slice(prefix.length + cmd.length).trimStart();
      if (!raw) return sendTemp(message.channel, `Usage: ${prefix}embed #HEX <message text> (Markdown, new lines, mentions and attached photos supported).`, 8000);
      const legacyParts = raw.split('|').map(part => part.trim());
      const isLegacy = legacyParts.length >= 3 && /^#?[0-9a-fA-F]{6}$/.test(legacyParts[0]);
      let colorText, embedText;
      if (isLegacy) {
        colorText = legacyParts[0];
        embedText = `**${legacyParts[1]}**\n\n${legacyParts.slice(2, 4).filter(Boolean).join('\n\n')}`;
      } else {
        const match = raw.match(/^(#?[0-9a-fA-F]{6})(?:\s+([\s\S]*))?$/);
        if (!match) return sendTemp(message.channel, `Usage: ${prefix}embed #0000FF <message text>`, 7000);
        colorText = match[1];
        embedText = (match[2] || '').trim();
      }
      const color = colorText.replace(/^#/, '');
      if (!/^[0-9a-fA-F]{6}$/.test(color)) return sendTemp(message.channel, 'Color must be a 6-digit hex code, like #0000FF.', 7000);
      const attachment = message.attachments.find(a => a.contentType?.startsWith('image/'));
      if (!embedText && !attachment) return sendTemp(message.channel, `Usage: ${prefix}embed #0000FF <message text> (or attach an image)`, 7000);
      const embed = new EmbedBuilder().setColor(parseInt(color, 16));
      if (embedText) embed.setDescription(embedText.slice(0, 4096));
      if (attachment) embed.setImage(attachment.url);
      await message.channel.send({ embeds: [embed], allowedMentions: { parse: ['users', 'roles'] } });
      return;
    }

    if (cmd === 'panelbutton') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return sendTemp(message.channel, 'You need Manage Messages to add panel buttons.', 6000);
      }
      const raw = body.slice(cmd.length).trim();
      const parts = raw.split('|').map(part => part.trim());
      if (parts.length < 3 || !/^\d{15,22}$/.test(parts[0]) || !parts[1] || !parts[2]) {
        return sendTemp(message.channel, 'Usage: !panelbutton MESSAGE_ID | Button label | #channel or https://link', 9000);
      }
      const [messageId, label, destination] = parts;
      let url = null;
      const channelMention = destination.match(/^<#(\d{15,22})>$/);
      const channelId = channelMention?.[1] || (/^\d{15,22}$/.test(destination) ? destination : null);
      if (channelId) {
        const channel = await message.guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased() || !channel.guild) {
          return sendTemp(message.channel, 'I could not find that text channel in this server.', 7000);
        }
        url = `https://discord.com/channels/${message.guild.id}/${channel.id}`;
      } else if (/^https:\/\/\S+$/i.test(destination)) {
        url = destination;
      } else {
        return sendTemp(message.channel, 'Use a channel mention/ID or a full https:// URL.', 7000);
      }

      const targetMessage = await message.channel.messages.fetch(messageId).catch(() => null);
      if (!targetMessage || targetMessage.author.id !== client.user.id) {
        return sendTemp(message.channel, 'I can only add buttons to a message sent by this bot in the same channel.', 8000);
      }
      const rows = targetMessage.components.map(row => ActionRowBuilder.from(row));
      let row = rows[rows.length - 1];
      if (!row || row.components.length >= 5) {
        if (rows.length >= 5) return sendTemp(message.channel, 'Discord allows up to 25 buttons per message.', 7000);
        row = new ActionRowBuilder();
        rows.push(row);
      }
      row.addComponents(new ButtonBuilder()
        .setLabel(label.slice(0, 80))
        .setStyle(ButtonStyle.Link)
        .setURL(url));
      await targetMessage.edit({ components: rows });
      return sendTemp(message.channel, `Added button: ${label.slice(0, 80)}`, 5000);
    }

    if (cmd === 'help') {
      const wanted = (args[0] || '').toLowerCase().replace(prefix, '');
      const found = commandList(prefix).find(([a]) => a.toLowerCase().replaceAll(prefix, '').split(/[ /]/)[0] === wanted);
      if (!found) return sendTemp(message.channel, `Use ${prefix}commands to see every command.`, 6000);
      const e = new EmbedBuilder().setColor(0x5865F2).setTitle(`Help: ${wanted}`).setDescription(found[1]).addFields({ name: 'Usage', value: found[0] });
      return message.channel.send({ embeds: [e] });
    }
  } catch (err) {
    console.error(`[${message.guild?.name}] ${cmd}`, err);
    return sendTemp(message.channel, `❌ Something went wrong while running \`${cmd}\`. Check my permissions and role position.`, 7000);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.customId?.startsWith('whpanel:')) { const handled = await handleWebhookInteraction(interaction, { data, saveData, client }); if (handled) return; }
    if (interaction.isChatInputCommand() && interaction.commandName === 'commands') {
      return interaction.reply({ content: '**3C Bot Commands**\n`!warn` `!unwarn` `!warnings` `!jail` `!mute` `!unmute` `!kick` `!execute` `!unban` `!invite` `!Birthday` `!endbirthday` `!poop` `!ticket` `!multipleticket` `!closeticket` `!serverinfo` `!prefix` `!help`', ephemeral: true });
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'roleinfo:select') {
      const role = interaction.guild?.roles.cache.get(interaction.values[0]);
      if (!role) return interaction.reply({ content: '❌ That role could not be found.', ephemeral: true });
      const orderedRoles = [...interaction.guild.roles.cache.values()].filter(r => r.id !== interaction.guild.id).sort((a, b) => b.position - a.position);
      const positionFromTop = orderedRoles.findIndex(r => r.id === role.id) + 1;
      const permissionNames = role.permissions.toArray().map(p => p.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '));
      const leftPermissions = permissionNames.filter((_, i) => i % 2 === 0);
      const rightPermissions = permissionNames.filter((_, i) => i % 2 === 1);
      const permissionText = list => truncate(list.join('\\n') || 'No permissions', 1024);
      const embed = new EmbedBuilder().setColor(role.color || 0x5865F2).setTitle('🎭 Role Information')
        .setDescription(`**Role:** ${role}\\n**Role ID:** \`${role.id}\`\\n**Hoisted:** ${role.hoist ? 'Yes' : 'No'}\\n**Mentionable:** ${role.mentionable ? 'Yes' : 'No'}\\n**Position from top:** ${positionFromTop} of ${orderedRoles.length}\\n**Created:** <t:${Math.floor(role.createdTimestamp / 1000)}:F>`)
        .addFields(
          { name: 'Permissions · 1', value: permissionText(leftPermissions), inline: true },
          { name: 'Permissions · 2', value: permissionText(rightPermissions), inline: true }
        ).setFooter({ text: `Role ID: ${role.id}` });
      return interaction.update({ content: null, embeds: [embed], components: [] });
    }

    if (interaction.isButton() && interaction.customId.startsWith('commands:')) {
      const [, action, currentRaw] = interaction.customId.split(':');
      const current = Number(currentRaw) || 0;
      const pages = [
        ['🛡️ 3C Moderation', ['warn/shout','unwarn','warnings','mute/timeout/jail','unmute/untimeout','kick','ban/execute','unban']],
        ['🧹 3C Management', ['p/ c/ purge','pus','s/ snipe','cs','es','ces','nick/ n','clearnick/ cn','role/ r add|give|remove','roleinfo','staff','slowmode','lock','unlock']],
        ['🎟️ 3C Tickets & Server', ['ticket','multipleticket','closeticket/ ct','setupaudit','serverinfo','prefix','say','reply']],
        ['😛 3C Fun & Other', ['hug','kiss','slap','blehhh','unblehhh','poop','afk','help']]
      ];

      let next = current;
      if (action === 'next') next = Math.min(pages.length - 1, current + 1);
      if (action === 'prev') next = Math.max(0, current - 1);
      if (action === 'home') next = 0;

      const prefix = getPrefix(interaction.guildId);
      const [title, keys] = pages[next];
      const lines = keys.map(k => {
        const f = commandList(prefix).find(([a]) => a.includes(k));
        return f ? `**${f[0]}** — ${f[1]}` : `**${prefix}${k}**`;
      });

      const e = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(title)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Page ${next + 1}/${pages.length} • Prefix: ${prefix}` });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`commands:prev:${next}`).setEmoji('◀️').setLabel('Back').setStyle(ButtonStyle.Secondary).setDisabled(next === 0),
        new ButtonBuilder().setCustomId(`commands:home:${next}`).setEmoji('🏠').setLabel('Home').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`commands:next:${next}`).setEmoji('▶️').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(next === pages.length - 1)
      );

      return interaction.update({ embeds: [e], components: [row] });
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket:setupopen:')) {
      const id=interaction.customId.split(':')[2], config=data.tickets[id];
      if(!config||config.guildId!==interaction.guildId) return interaction.reply({content:'❌ This ticket setup no longer exists.',ephemeral:true});
      if(interaction.user.id!==config.createdBy&&!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({content:'❌ Only the panel creator or Manage Server can configure this.',ephemeral:true});
      const modal=new ModalBuilder().setCustomId(`ticket:setupmodal:${id}`).setTitle('Create Ticket Panel');
      const f=(id,label,placeholder,style=TextInputStyle.Short,required=true,max=256)=>new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(required).setMaxLength(max);
      modal.addComponents(
        new ActionRowBuilder().addComponents(f('ticket:name','Ticket name','Tryout Ticket',TextInputStyle.Short,true,80)),
        new ActionRowBuilder().addComponents(f('ticket:color','Ticket color','#5865F2',TextInputStyle.Short,true,7)),
        new ActionRowBuilder().addComponents(f('ticket:embedname','Embed name','Create Tryout Ticket',TextInputStyle.Short,true,256)),
        new ActionRowBuilder().addComponents(f('ticket:embedcolor','Embed color','#5865F2',TextInputStyle.Short,true,7)),
        new ActionRowBuilder().addComponents(f('ticket:description','Ticket description','Explain what this ticket is for...',TextInputStyle.Paragraph,true,1000))
      );
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:setupmodal:')) {
      const id=interaction.customId.split(':')[2], config=data.tickets[id];
      if(!config||config.guildId!==interaction.guildId) return interaction.reply({content:'❌ This ticket setup no longer exists.',ephemeral:true});
      const hex=v=>{v=String(v||'').trim().replace(/^#/,'');return /^[0-9a-fA-F]{6}$/.test(v)?parseInt(v,16):null;};
      const name=interaction.fields.getTextInputValue('ticket:name').trim(), color=hex(interaction.fields.getTextInputValue('ticket:color'));
      const title=interaction.fields.getTextInputValue('ticket:embedname').trim(), embedColor=hex(interaction.fields.getTextInputValue('ticket:embedcolor'));
      const description=interaction.fields.getTextInputValue('ticket:description').trim();
      if(!name||color===null||!title||embedColor===null||!description) return interaction.reply({content:'❌ Use 6-digit hex colors like `#5865F2`.',ephemeral:true});
      config.name=name; config.color=color; config.title=title; config.description=description; config.embedColor=embedColor; config.categoryId=null; config.tagId=null; config.tagType=null;
      saveData();
      const tagSelect=new MentionableSelectMenuBuilder().setCustomId(`ticket:settag:${id}`).setPlaceholder('Select Roles/Users to Tag').setMinValues(1).setMaxValues(25);
      const select=new ChannelSelectMenuBuilder().setCustomId(`ticket:setupcategory:${id}`).setPlaceholder('Select Ticket Category').setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1);
      const fmt=n=>`#${n.toString(16).padStart(6,'0').toUpperCase()}`;
      return interaction.reply({embeds:[new EmbedBuilder().setColor(embedColor).setTitle('🎟️ Ticket Panel Setup').setDescription(`**Ticket name:** ${name}\n**Ticket color:** ${fmt(color)}\n**Embed name:** ${title}\n**Embed color:** ${fmt(embedColor)}\n**Ticket description:** ${description}\n\nSelect the role/user to tag, then select the existing category where tickets should be created.`)],components:[new ActionRowBuilder().addComponents(tagSelect),new ActionRowBuilder().addComponents(select)],ephemeral:true});
    }

    if (interaction.isMentionableSelectMenu() && interaction.customId.startsWith('ticket:settag:')) {
      const id=interaction.customId.split(':')[2], config=data.tickets[id];
      if(!config||config.guildId!==interaction.guildId) return interaction.reply({content:'❌ This ticket panel no longer exists.',ephemeral:true});
      if(interaction.user.id!==config.createdBy&&!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({content:'❌ Only the panel creator or Manage Server can configure this.',ephemeral:true});
      const selectedIds=[...new Set(interaction.values)];
      const tags=[];
      for(const selectedId of selectedIds){
        const role=interaction.guild.roles.cache.get(selectedId);
        if(role) tags.push({id:role.id,type:'role'});
        else {
          const user=await client.users.fetch(selectedId).catch(()=>null);
          if(user) tags.push({id:user.id,type:'user'});
        }
      }
      if(!tags.length) return interaction.reply({content:'❌ I could not find any valid users or roles.',ephemeral:true});
      config.tagIds=tags.map(t=>t.id);
      config.tagTypes=tags.map(t=>t.type);
      config.tagId=tags[0].id;
      config.tagType=tags[0].type;
      saveData();
      if(config.categoryId){
        const customize = new ButtonBuilder().setCustomId(`ticket:buttonsetup:${id}`).setLabel('Customize Public Button').setEmoji('🎨').setStyle(ButtonStyle.Secondary);
        return interaction.update({content:`✅ Selected **${tags.length}** role/user${tags.length===1?'':'s'}. Now customize the public button label, emoji, and color.`,embeds:[],components:[new ActionRowBuilder().addComponents(customize)]});
      }
      return interaction.update({content:`✅ Selected **${tags.length}** role/user${tags.length===1?'':'s'}. Now select the Ticket Category.`,embeds:[],components:interaction.message.components});
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('ticket:setupcategory:')) {
      const id=interaction.customId.split(':')[2], config=data.tickets[id];
      if(!config||config.guildId!==interaction.guildId) return interaction.reply({content:'❌ This ticket panel no longer exists.',ephemeral:true});
      if(interaction.user.id!==config.createdBy&&!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({content:'❌ Only the panel creator or Manage Server can configure this.',ephemeral:true});
      const category=interaction.guild.channels.cache.get(interaction.values[0]);
      if(!category||category.type!==ChannelType.GuildCategory) return interaction.reply({content:'❌ Select an existing Discord category.',ephemeral:true});
      config.categoryId=category.id; saveData();
      if(!config.tagId||!config.tagType) return interaction.update({content:'✅ Category saved! Now select the Role/User to Tag.',embeds:[],components:interaction.message.components});
      const customize = new ButtonBuilder().setCustomId(`ticket:buttonsetup:${id}`).setLabel('Customize Public Button').setEmoji('🎨').setStyle(ButtonStyle.Secondary);
      return interaction.update({content:'✅ Ticket category saved! Now customize the public button label, emoji, and color.',embeds:[],components:[new ActionRowBuilder().addComponents(customize)]});
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket:buttonsetup:')) {
      const id=interaction.customId.split(':')[2], config=data.tickets[id];
      if(!config||config.guildId!==interaction.guildId) return interaction.reply({content:'❌ This ticket setup no longer exists.',ephemeral:true});
      if(interaction.user.id!==config.createdBy&&!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({content:'❌ Only the panel creator or Manage Server can configure this.',ephemeral:true});
      const modal=new ModalBuilder().setCustomId(`ticket:buttonmodal:${id}`).setTitle('Customize Ticket Button');
      const f=(field,label,placeholder,required,max)=>new TextInputBuilder().setCustomId(field).setLabel(label).setPlaceholder(placeholder).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max);
      modal.addComponents(
        new ActionRowBuilder().addComponents(f('ticket:buttonlabel','Button label','Open Ticket',true,80)),
        new ActionRowBuilder().addComponents(f('ticket:buttonemoji','Button emoji','🎟️',false,100)),
        new ActionRowBuilder().addComponents(f('ticket:buttoncolor','Button color','Blue, Grey, Green, or Red',true,10))
      );
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:buttonmodal:')) {
      const id=interaction.customId.split(':')[2], config=data.tickets[id];
      if(!config||config.guildId!==interaction.guildId) return interaction.reply({content:'❌ This ticket setup no longer exists.',ephemeral:true});
      if(interaction.user.id!==config.createdBy&&!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({content:'❌ Only the panel creator or Manage Server can configure this.',ephemeral:true});
      const label=interaction.fields.getTextInputValue('ticket:buttonlabel').trim();
      const emoji=interaction.fields.getTextInputValue('ticket:buttonemoji').trim();
      const colorText=interaction.fields.getTextInputValue('ticket:buttoncolor').trim().toLowerCase();
      const styles={blue:ButtonStyle.Primary,grey:ButtonStyle.Secondary,gray:ButtonStyle.Secondary,green:ButtonStyle.Success,red:ButtonStyle.Danger};
      if(!label||!styles[colorText]) return interaction.reply({content:'❌ Enter a button label and choose Blue, Grey, Green, or Red.',ephemeral:true});
      config.buttonLabel=label;
      config.buttonEmoji=emoji||null;
      config.buttonStyleName=colorText==='gray'?'grey':colorText;
      config.buttonStyle=styles[colorText];
      saveData();
      const buildTicketButton = ticketId => {
        const ticketConfig = data.tickets[ticketId];
        const button = new ButtonBuilder().setCustomId(`ticket:create:${ticketId}`).setLabel(ticketConfig.buttonLabel || 'Open Ticket').setStyle(ticketConfig.buttonStyle || ButtonStyle.Primary);
        if(ticketConfig.buttonEmoji) button.setEmoji(ticketConfig.buttonEmoji);
        return button;
      };
      const buildTicketEmbed = ticketId => {
        const ticketConfig = data.tickets[ticketId];
        const parentGroup = ticketConfig.panelGroupId ? data.ticketPanels[ticketConfig.panelGroupId] : null;
        const embed = new EmbedBuilder().setColor(ticketConfig.embedColor ?? 0x5865F2).setTitle(ticketConfig.title || ticketConfig.name || 'Create Ticket').setDescription(ticketConfig.description || 'Open a ticket using the button below.');
        embed.setFooter({ text: ticketConfig.footerText || parentGroup?.footerText || '3C Bot ~ Built for Rivals. United by 3C.', iconURL: client.user.displayAvatarURL() });
        return embed;
      };
      config.panelChannelId=interaction.channel.id;
      const group = config.panelGroupId ? data.ticketPanels[config.panelGroupId] : null;
      let panelMessage;
      if(group) {
        if(!group.ticketIds.includes(id)) group.ticketIds.push(id);
        const configuredIds = group.ticketIds.filter(ticketId => data.tickets[ticketId]?.buttonLabel && data.tickets[ticketId]?.categoryId).slice(0,6);
        const panelEmbed = new EmbedBuilder()
          .setColor(group.embedColor ?? 0x232428)
          .setTitle(group.panelTitle || 'General Support 📬')
          .setDescription(group.panelDescription || 'Choose a ticket type below and our team will help you.')
          .setFooter({ text: group.footerText || '3C Bot ~ Built for Rivals. United by 3C.', iconURL: client.user.displayAvatarURL() });
        const panelButtons = configuredIds.map(buildTicketButton);
        const panelRows = [];
        for (let i = 0; i < panelButtons.length; i += 5) panelRows.push(new ActionRowBuilder().addComponents(...panelButtons.slice(i, i + 5)));
        if(!panelButtons.length) return interaction.reply({content:'❌ No configured ticket types found.',ephemeral:true});
        if(group.panelMessageId) {
          const panelChannel = await client.channels.fetch(group.panelChannelId).catch(()=>null);
          panelMessage = panelChannel?.messages ? await panelChannel.messages.fetch(group.panelMessageId).catch(()=>null) : null;
        }
        if(panelMessage) await panelMessage.edit({embeds:[panelEmbed],components:panelRows});
        else {
          const panelChannel = await client.channels.fetch(group.panelChannelId).catch(()=>null);
          if(!panelChannel?.isTextBased()) return interaction.reply({content:'❌ I could not find the channel where this multi-ticket panel should be posted.',ephemeral:true});
          panelMessage = await panelChannel.send({embeds:[panelEmbed],components:panelRows});
          group.panelMessageId = panelMessage.id;
        }
        group.panelChannelId = panelMessage.channelId;
        for(const ticketId of configuredIds) { data.tickets[ticketId].panelMessageId = panelMessage.id; data.tickets[ticketId].panelChannelId = panelMessage.channelId; }
        saveData();
      } else {
        const open=buildTicketButton(id);
        const embed=buildTicketEmbed(id);
        panelMessage=await interaction.channel.send({embeds:[embed],components:[new ActionRowBuilder().addComponents(open)]});
        config.panelMessageId=panelMessage.id;
        saveData();
      }
      const configuredCount = group ? group.ticketIds.filter(ticketId => data.tickets[ticketId]?.buttonLabel && data.tickets[ticketId]?.categoryId).length : 5;
      const editPanel = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(group ? `ticket:panelsetup:${config.panelGroupId}` : `ticket:panelsetup:${id}`).setLabel('Edit Panel Title, Description & Footer').setEmoji('📝').setStyle(ButtonStyle.Secondary));
      const addMore = group && configuredCount < 6 ? new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ticket:addtype:${config.panelGroupId}`).setLabel('Add Another Ticket Type').setEmoji('➕').setStyle(ButtonStyle.Secondary)) : null;
      await interaction.reply({content:`✅ Ticket panel created/updated! Button: **${label}** · Color: **${config.buttonStyleName}**.${group?' You can edit the shared embed or add another ticket type below.':' You can edit the embed footer below.'}`,components:addMore?[editPanel,addMore]:[editPanel],ephemeral:true});
      return auditLog(interaction.guild,'🎟️ Ticket Panel Configured',`${interaction.user} configured **${config.name}** with a private ticket category and a ${config.buttonStyleName} button.`,0x5865F2);
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket:panelsetup:')) {
      const panelId = interaction.customId.split(':')[2];
      const group = data.ticketPanels[panelId];
      const config = data.tickets[panelId];
      const ownerId = group?.createdBy || config?.createdBy;
      const guildId = group?.guildId || config?.guildId;
      if (!ownerId || guildId !== interaction.guildId) return interaction.reply({ content: '❌ This panel setup no longer exists.', ephemeral: true });
      if (interaction.user.id !== ownerId && !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ Only the panel creator or Manage Server can edit this.', ephemeral: true });
      const currentTitle = group?.panelTitle || config?.title || 'General Support 📬';
      const currentDescription = group?.panelDescription || config?.description || 'Choose a ticket type below and our team will help you.';
      const currentFooter = group?.footerText || config?.footerText || '3C Bot ~ Built for Rivals. United by 3C.';
      const modal = new ModalBuilder().setCustomId(`ticket:panelmodal:${panelId}`).setTitle('Edit Ticket Panel Embed');
      const f = (field, label, value, style, max) => new TextInputBuilder().setCustomId(field).setLabel(label).setValue(String(value).slice(0,max)).setStyle(style).setRequired(true).setMaxLength(max);
      modal.addComponents(
        new ActionRowBuilder().addComponents(f('panel:title', 'Panel title', currentTitle, TextInputStyle.Short, 256)),
        new ActionRowBuilder().addComponents(f('panel:description', 'Panel description', currentDescription, TextInputStyle.Paragraph, 1000)),
        new ActionRowBuilder().addComponents(f('panel:footer', 'Footer text', currentFooter, TextInputStyle.Short, 200))
      );
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:panelmodal:')) {
      const panelId = interaction.customId.split(':')[2];
      const group = data.ticketPanels[panelId];
      const config = data.tickets[panelId];
      const ownerId = group?.createdBy || config?.createdBy;
      const guildId = group?.guildId || config?.guildId;
      if (!ownerId || guildId !== interaction.guildId) return interaction.reply({ content: '❌ This panel setup no longer exists.', ephemeral: true });
      if (interaction.user.id !== ownerId && !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: '❌ Only the panel creator or Manage Server can edit this.', ephemeral: true });
      const title = interaction.fields.getTextInputValue('panel:title').trim();
      const description = interaction.fields.getTextInputValue('panel:description').trim();
      const footerText = interaction.fields.getTextInputValue('panel:footer').trim();
      if (!title || !description || !footerText) return interaction.reply({ content: '❌ Title, description, and footer text cannot be blank.', ephemeral: true });
      if (group) {
        group.panelTitle = title;
        group.panelDescription = description;
        group.footerText = footerText;
      } else {
        config.title = title;
        config.description = description;
        config.footerText = footerText;
      }
      saveData();
      let panelMessage = null;
      const channelId = group?.panelChannelId || config.panelChannelId;
      const messageId = group?.panelMessageId || config.panelMessageId;
      const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
      if (channel?.messages && messageId) panelMessage = await channel.messages.fetch(messageId).catch(() => null);
      if (panelMessage) {
        const embed = new EmbedBuilder().setColor(group?.embedColor ?? config?.embedColor ?? 0x232428)
          .setTitle(title).setDescription(description)
          .setFooter({ text: footerText, iconURL: client.user.displayAvatarURL() });
        await panelMessage.edit({ embeds: [embed] });
      }
      return interaction.reply({ content: '✅ Panel title, description, and footer saved. The bot profile picture is automatically shown beside the footer.', ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket:addtype:')) {
      const groupId=interaction.customId.split(':')[2], group=data.ticketPanels[groupId];
      if(!group||group.guildId!==interaction.guildId) return interaction.reply({content:'❌ This multi-ticket panel setup no longer exists.',ephemeral:true});
      if(interaction.user.id!==group.createdBy&&!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({content:'❌ Only the panel creator or Manage Server can add ticket types.',ephemeral:true});
      const configuredCount=group.ticketIds.filter(ticketId=>data.tickets[ticketId]?.buttonLabel&&data.tickets[ticketId]?.categoryId).length;
      if(configuredCount>=6) return interaction.reply({content:'❌ This panel already has 6 ticket types, the current limit.',ephemeral:true});
      const id=`mt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
      data.tickets[id]={guildId:group.guildId,createdBy:group.createdBy,panelChannelId:group.panelChannelId,panelMessageId:group.panelMessageId,categoryId:null,name:'ticket',color:0x5865F2,title:'Create Ticket',embedColor:0x5865F2,tagId:null,tagType:null,tagIds:[],tagTypes:[],panelGroupId:groupId};
      group.ticketIds.push(id);
      saveData();
      const setupButton=new ButtonBuilder().setCustomId(`ticket:setupopen:${id}`).setLabel('Configure New Ticket Type').setEmoji('🎟️').setStyle(ButtonStyle.Primary);
      return interaction.reply({content:'Configure the next ticket type. It will be added to the same public panel with its own embed, category, tags, button label, emoji, and color.',components:[new ActionRowBuilder().addComponents(setupButton)],ephemeral:true});
    }
    if (interaction.isButton() && interaction.customId.startsWith('ticket:create:')) {
      const id=interaction.customId.split(':')[2], config=data.tickets[id];
      if(!config||config.guildId!==interaction.guildId) return interaction.reply({content:'❌ This ticket panel no longer exists.',ephemeral:true});
      const existing=interaction.guild.channels.cache.find(c=>{ if(c.type!==ChannelType.GuildText||!c.topic?.startsWith('3C-TICKET:')) return false; const parts=c.topic.split(':'); return parts[1]===interaction.user.id && (!parts[2] || parts[2]===id); });
      if(existing) return interaction.reply({content:`You already have a ticket: ${existing}`,ephemeral:true});
      const category=interaction.guild.channels.cache.get(config.categoryId);
      if (!config.tagIds) config.tagIds = config.tagId ? [config.tagId] : [];
      if (!config.tagTypes) config.tagTypes = config.tagType ? [config.tagType] : [];
      if(!category||category.type!==ChannelType.GuildCategory) return interaction.reply({content:'❌ This panel has no valid ticket category.',ephemeral:true});
      const safeBase=String(config.name||'ticket').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'ticket';
      const safeUser=String(interaction.user.username||interaction.user.id).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,25)||interaction.user.id;
      const safeName=`${safeBase}-ticket-${safeUser}`.slice(0,95);
      let channel;
      try{ channel=await interaction.guild.channels.create({name:safeName,type:ChannelType.GuildText,parent:category.id,topic:`3C-TICKET:${interaction.user.id}:${id}`,permissionOverwrites:[
        {id:interaction.guild.roles.everyone.id,deny:[PermissionsBitField.Flags.ViewChannel]},
        {id:interaction.user.id,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory,PermissionsBitField.Flags.AttachFiles]},
        ...((config.tagIds || (config.tagId ? [config.tagId] : [])).filter(tagId => tagId && tagId !== interaction.user.id && tagId !== client.user.id && tagId !== interaction.guild.roles.everyone.id).map((tagId, i) => {
          const savedType = config.tagTypes?.[i] || (config.tagIds?.length === 1 ? config.tagType : null);
          const isRole = savedType ? savedType === 'role' : interaction.guild.roles.cache.has(tagId);
          return { id: tagId, type: isRole ? OverwriteType.Role : OverwriteType.Member, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] };
        })),
        {id:client.user.id,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory,PermissionsBitField.Flags.ManageChannels,PermissionsBitField.Flags.ManageMessages]}
      ]}); }catch(err){console.error('Ticket channel creation error:',err);return interaction.reply({content:'❌ I could not create the ticket. Check Manage Channels and the selected category.',ephemeral:true});}
      const close=new ButtonBuilder().setCustomId('ticket:close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger);
      const emb=new EmbedBuilder().setColor(config.color).setTitle(config.name).setDescription(config.description + `\n\nWelcome ${interaction.user}! A staff member will help you here.\n\nClick **Close Ticket** when you are finished.`).setFooter({text:config.footerText || (config.panelGroupId ? data.ticketPanels[config.panelGroupId]?.footerText : null) || '3C Bot ~ Built for Rivals. United by 3C.', iconURL:client.user.displayAvatarURL()});
      const tagIds=config.tagIds || (config.tagId?[config.tagId]:[]);
      const tagTypes=config.tagTypes || (config.tagType?[config.tagType]:[]);
      const tagMentions=tagIds.map((tagId,i)=>tagTypes[i]==='role'?`<@&${tagId}>`:`<@${tagId}>`);
      const taggedUsers=tagIds.filter((tagId,i)=>tagTypes[i]==='user');
      const taggedRoles=tagIds.filter((tagId,i)=>tagTypes[i]==='role');
      await channel.send({content:[interaction.user.toString(),...tagMentions].join(' '),embeds:[emb],components:[new ActionRowBuilder().addComponents(close)],allowedMentions:{users:[interaction.user.id,...taggedUsers],roles:taggedRoles}});
      await auditLog(interaction.guild,'🎟️ Ticket Created',`${channel} was created by ${interaction.user}.`,0x57F287,[{name:'Ticket Name',value:config.name},{name:'Ticket Creator',value:`${interaction.user.tag} (${interaction.user.id})`},{name:'Channel',value:`${channel} (${channel.id})`},{name:'Category',value:`${category.name} (${category.id})`}]);
      return interaction.reply({content:`🎟️ ${config.name} created: ${channel}`,ephemeral:true});
    }

    if (interaction.isButton() && interaction.customId==='ticket:close') {
      const topic=interaction.channel?.topic||''; if(!topic.startsWith('3C-TICKET:')) return interaction.reply({content:'❌ This is not a ticket.',ephemeral:true});
      const topicParts=topic.split(':');
      const ownerId=topicParts[1], ticketConfig=data.tickets[topicParts[2]];
      const tagIds=ticketConfig?.tagIds || (ticketConfig?.tagId ? [ticketConfig.tagId] : []);
      const tagTypes=ticketConfig?.tagTypes || (ticketConfig?.tagType ? [ticketConfig.tagType] : []);
      const isSelectedUser=tagIds.some((id,i)=>tagTypes[i]==='user'&&id===interaction.user.id);
      const isSelectedRole=tagIds.some((id,i)=>tagTypes[i]==='role'&&interaction.member?.roles?.cache?.has(id));
      const staff=interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels);
      if(interaction.user.id!==ownerId&&!isSelectedUser&&!isSelectedRole&&!staff) return interaction.reply({content:'❌ Only the ticket creator, selected ticket staff, or Manage Channels staff can close this ticket.',ephemeral:true});
      const modal=new ModalBuilder().setCustomId('ticket:closemodal').setTitle('Close Ticket');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket:closereason').setLabel('Close reason').setStyle(TextInputStyle.Paragraph).setPlaceholder('Why is this ticket being closed?').setRequired(true).setMaxLength(1000)));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId==='ticket:closemodal') {
      const topic=interaction.channel?.topic||''; if(!topic.startsWith('3C-TICKET:')) return interaction.reply({content:'❌ This is not a ticket.',ephemeral:true});
      const topicParts=topic.split(':');
      const ownerId=topicParts[1], ticketConfig=data.tickets[topicParts[2]];
      const tagIds=ticketConfig?.tagIds || (ticketConfig?.tagId ? [ticketConfig.tagId] : []);
      const tagTypes=ticketConfig?.tagTypes || (ticketConfig?.tagType ? [ticketConfig.tagType] : []);
      const isSelectedUser=tagIds.some((id,i)=>tagTypes[i]==='user'&&id===interaction.user.id);
      const isSelectedRole=tagIds.some((id,i)=>tagTypes[i]==='role'&&interaction.member?.roles?.cache?.has(id));
      const staff=interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels);
      if(interaction.user.id!==ownerId&&!isSelectedUser&&!isSelectedRole&&!staff) return interaction.reply({content:'❌ Only the ticket creator, selected ticket staff, or Manage Channels staff can close this ticket.',ephemeral:true});
      const reason=interaction.fields.getTextInputValue('ticket:closereason').trim();
      if(!reason) return interaction.reply({content:'❌ Please enter a close reason.',ephemeral:true});
      const ticket=interaction.channel, category=ticket.parent;
      if (staff) {
        const closerStats = staffStatsFor(interaction.guild.id, interaction.user.id);
        closerStats.ticketsClosed = (closerStats.ticketsClosed || 0) + 1;
        closerStats.lastSeen = Date.now();
        saveData();
      }
      await auditLog(interaction.guild,'🔒 Ticket Closed',`${ticket} was closed by ${interaction.user}.`,0xED4245,[{name:'Closed By',value:`${interaction.user.tag} (${interaction.user.id})`},{name:'Ticket Creator',value:`<@${ownerId}> (${ownerId})`},{name:'Channel',value:`#${ticket.name} (${ticket.id})`},{name:'Category',value:category?`${category.name} (${category.id})`:'Unknown'},{name:'Close Reason',value:truncate(reason||'No reason provided')}]);
      await interaction.reply({content:`🔒 Ticket closed. Reason: **${reason}**`});
      setTimeout(()=>ticket.delete(`Ticket closed by ${interaction.user.tag}: ${reason}`.slice(0,512)).catch(()=>{}),1200);
    }
  } catch(err) {
    console.error('Ticket interaction error:',err);
    if(!interaction.replied&&!interaction.deferred) await interaction.reply({content:'❌ Something went wrong with the ticket.',ephemeral:true}).catch(()=>{});
  }
});

client.login(TOKEN);
