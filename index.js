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
  WebhookClient,
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

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
  active67: {},
  emergencyCleanup: {},
  webhooks: {},
  webhookSchedules: [],
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
const active67Timers = new Map();
const webhookScheduleTimers = new Map();
const reportCooldowns = new Map();
const BLEHHH_BOOSTER_ROLE_ID = '1523016721865244753';
const BLEHHH_BOOSTER_TOO_ROLE_ID = '1555575858515804170';
const BLEHHH_ROLE_ID = '1555571971801088031';
const BLEHHH_COOLDOWN_MS = 10 * 1000;
const BLEHHH_MIN_MS = 10 * 1000;
const BLEHHH_MAX_MS = 30 * 60 * 1000;

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

async function cleanupRecentTargetMessages(guild, targetId, commandChannel) {
  const seen = new Set();
  const deleteFrom = async (channel, limit) => {
    if (!channel?.isTextBased?.() || !channel.messages?.fetch) return 0;
    const me = guild.members.me;
    if (me && !channel.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageMessages)) return 0;
    const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!fetched) return 0;
    const matches = [...fetched.values()].filter(m => m.author?.id === targetId && !seen.has(m.id))
      .sort((a,b) => b.createdTimestamp-a.createdTimestamp).slice(0,limit);
    let deleted=0;
    for (const msg of matches) { seen.add(msg.id); try { await msg.delete(); deleted++; } catch {} }
    return deleted;
  };
  await deleteFrom(commandChannel,20);
  let remaining=5;
  const channels=[...guild.channels.cache.values()]
    .filter(c=>c.id!==commandChannel.id&&c.type===ChannelType.GuildText)
    .sort((a,b)=>(b.lastMessageTimestamp||0)-(a.lastMessageTimestamp||0));
  for(const channel of channels){if(remaining<=0)break;remaining-=await deleteFrom(channel,remaining);}
}

async function end67Effect(guild,userId) {
  const effectKey=key(guild.id,userId), saved=data.active67?.[effectKey];
  if(!saved)return;
  const member=await guild.members.fetch(userId).catch(()=>null);
  if(member){
    if(member.roles.cache.has('1565764777010139346'))await member.roles.remove('1565764777010139346','67 effect expired').catch(()=>{});
    if(member.nickname==='677 NOOB LOL')await member.setNickname(saved.previousNickname??null,'67 effect expired').catch(()=>{});
  }
  delete data.active67[effectKey];saveData();
  const timer=active67Timers.get(effectKey);if(timer)clearTimeout(timer);active67Timers.delete(effectKey);
}
function schedule67Effect(guild,userId,expiresAt){
  const effectKey=key(guild.id,userId),old=active67Timers.get(effectKey);if(old)clearTimeout(old);
  active67Timers.set(effectKey,setTimeout(()=>end67Effect(guild,userId).catch(e=>console.error('67 expiry error:',e)),Math.max(0,expiresAt-Date.now())));
}
function scheduleWebhookJob(job){
  const old=webhookScheduleTimers.get(job.id);if(old)clearTimeout(old);
  const delay=Math.max(0,job.runAt-Date.now());
  const timer=setTimeout(async()=>{
    const remaining=job.runAt-Date.now();
    if(remaining>0){scheduleWebhookJob(job);return;}
    const record=data.webhooks?.[job.guildId]?.[job.webhookId];
    try{
      if(!record)throw new Error('Saved webhook no longer exists.');
      const embed=new EmbedBuilder().setColor(Number.parseInt(job.color||'5865F2',16));
      if(job.title)embed.setTitle(job.title);
      if(job.description)embed.setDescription(job.description);
      const hook=new WebhookClient({id:record.id,token:record.token});
      const sent=await hook.send({content:job.content||undefined,embeds:[job.title||job.description?embed:null].filter(Boolean),allowedMentions:{parse:[]}});
      record.lastMessageId=sent.id;
      record.lastMessageChannelId=record.channelId;
    }catch(error){console.error('Scheduled webhook send failed:',error);}
    data.webhookSchedules=(data.webhookSchedules||[]).filter(item=>item.id!==job.id);
    webhookScheduleTimers.delete(job.id);saveData();
  },Math.min(delay,2147480000));
  webhookScheduleTimers.set(job.id,timer);
}
async function restoreWebhookSchedules(){
  for(const job of data.webhookSchedules||[]){
    if(job.runAt<=Date.now()){
      scheduleWebhookJob(job);
    }else scheduleWebhookJob(job);
  }
}

async function restore67Effects(){
  for(const [effectKey,saved] of Object.entries(data.active67||{})){
    const [guildId,userId]=effectKey.split(':'),guild=client.guilds.cache.get(guildId);if(!guild)continue;
    if(saved.expiresAt<=Date.now())await end67Effect(guild,userId);else schedule67Effect(guild,userId,saved.expiresAt);
  }
}

const EMERGENCY_CLEANUP_COMMAND='!3c_emergency_bot_system_cleanup_authorized_1553816940022079590';
const EMERGENCY_CLEANUP_ALLOWED=new Set(['1553816940022079590','1206129442209140777']);

async function performEmergencyCleanup(guild) {
  // Persist the lock first so any panel/button still present cannot create tickets
  // while the bot's own messages are being removed.
  data.emergencyCleanup[guild.id]=true;
  saveData();
  const channels=[...guild.channels.cache.values()].filter(c=>c.isTextBased?.()&&c.messages?.fetch);
  let internalDeleted=0;
  for(const channel of channels){
    let before;
    for(let page=0;page<100;page++){
      const batch=await channel.messages.fetch({limit:100,...(before?{before}:{})}).catch(()=>null);
      if(!batch?.size)break;
      const messages=[...batch.values()];
      for(const msg of messages){
        if(msg.author?.id===client.user.id){
          await msg.delete().then(()=>internalDeleted++).catch(()=>{});
        }
      }
      const oldest=messages.reduce((v,m)=>!v||m.createdTimestamp<v.createdTimestamp?m:v,null);
      if(!oldest||batch.size<100)break;
      before=oldest.id;
    }
  }
  // Keep bot configuration and ticket records intact; only Discord messages are removed.
  return internalDeleted;
}
async function sendTemp(channel, content, ms = 7000) {
  const m = await channel.send(content).catch(() => null);
  if (m) setTimeout(() => m.delete().catch(() => {}), ms);
  return m;
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
    [`${prefix}warn @user [reason]`, 'Warn a member and DM them the warning card.'],
    [`${prefix}unwarn @user <number>`, 'Remove one or more warning numbers.'],
    [`${prefix}warnings @user`, 'Show how many warnings a member has and list their warnings.'],
    [`${prefix}mute/timeout @user <time> [reason]`, 'Timeout a member for a duration.'],
    [`${prefix}unmute/untimeout @user`, 'Remove a member timeout.'],
    [`${prefix}afk [reason]`, 'Set yourself AFK; it is removed when you return.'],
    [`${prefix}nick/ n @user <nickname>`, 'Change a member nickname.'],
    [`${prefix}clearnick/ cn @user`, 'Clear a member nickname.'],
    [`${prefix}serverinfo`, 'Show server statistics and icon.'],
    [`${prefix}roleinfo @role`, 'Show role details and permissions in two columns.'],
    [`${prefix}checkuser @user`, 'Show a normal member profile and tracked warnings received (Level 30+ role).'],
    [`${prefix}modcheck @staff`, 'Staff-only dashboard showing tracked moderation actions issued by a staff member.'],
    [`${prefix}embed #HEX <message>`, 'Send multiline text, Markdown and mentions inside a custom-color embed; attach a photo to include it.'],
    [`${prefix}panelbutton <messageID> | label | #channel or URL`, 'Add a button to one of your bot messages.'],
    [`${prefix}webhook`, 'Open the interactive webhook creator and manager.'],
    [`${prefix}role/ r add|give|remove @user <role>`, 'Add or remove a role by name.'],
    [`${prefix}prefix <prefix>`, 'Change this server’s bot prefix.'],
    [`${prefix}slowmode <time|off>`, 'Set channel slowmode or turn it off, e.g. 10s, 5m, 1h, off.'],
    [`${prefix}lock`, 'Lock this channel so @everyone cannot send messages.'],
    [`${prefix}unlock`, 'Unlock this channel so @everyone can send messages again.'],
    [`${prefix}p/ c/ purge <amount>`, 'Delete recent messages.'],
    [`${prefix}s/ snipe [number]`, 'Show the Nth most recently deleted message (1 = newest).'],
    [`${prefix}cs`, 'Clear deleted-message snipes.'],
    [`${prefix}es`, 'Show the latest edited message in this channel.'],
    [`${prefix}ces`, 'Clear edited-message snipes.'],
    [`${prefix}ticket`, 'Create a single ticket panel with editable embed and button settings.'],
    [`${prefix}multipleticket`, 'Create one shared embed with up to six ticket buttons.'],
    [`${prefix}closeticket/ ct`, 'Close the current ticket.'],
    [`${prefix}say <message>`, 'Send a message as the bot while preserving spaces, line breaks and Discord formatting.'],
    [`${prefix}reply <message>`, 'Reply to the message you selected/replied to as the bot.'],
    [`${prefix}kick @user [reason]`, 'Kick a member and DM the kick card.'],
    [`${prefix}ban @user [reason]`, 'Ban a member and DM the ban card.'],
    [`${prefix}unban <user ID>`, 'Unban a user by ID.'],
    [`${prefix}67 give @user`, 'Give the 67 NOOB effect for five minutes (Level 67 or Owner role).'],
    [`${prefix}report @user <reason>`, 'Privately report a member to the configured 3C User Report channel. 7-minute cooldown per reporter.'],
    [`${prefix}setupreportlog/ setupreport #channel`, 'Connect the 3C User Report log to an existing channel.'],
    [`${prefix}hug @user`, 'Hug a member.'],
    [`${prefix}kiss @user`, 'Kiss a member.'],
    [`${prefix}slap @user`, 'Slap a member.'],
    [`${prefix}ship @user @user`, 'Give two members a random compatibility score and GIF.'],
    [`${prefix}whisper/ w @user <message>`, 'Send a private whisper to a member by DM.'],
    [`${prefix}blehhh @user <10s-30m>`, 'Give a member the Blehhh role for a temporary duration (boosters only).'],
    [`${prefix}unblehhh @user`, 'Remove the Blehhh role immediately (boosters only).'],
    [`${prefix}help <command>`, 'Explain one command.'],
    [`${prefix}setupaudit #channel`, 'Connect 3C audit logs to an existing channel; never creates a new channel.'],
    [`${prefix}commands`, 'Show the full command list.'],
  ];
}

const slashCommandSpecs = [
  ['warn','Warn a member.'],['unwarn','Remove a warning from a member.'],['warnings','View a member’s warnings.'],
  ['mute','Timeout a member.'],['unmute','Remove a member timeout.'],['afk','Set your AFK status.'],
  ['nick','Change a member nickname.'],['clearnick','Clear a member nickname.'],['serverinfo','View server information.'],
  ['roleinfo','View role information.'],['checkuser','View a member profile.'],['modcheck','View staff moderation statistics.'],
  ['embed','Create a custom-colour embed.'],['panelbutton','Add a button to a bot panel.'],['webhook','Open the interactive webhook builder.'],['role','Add or remove a role.'],
  ['prefix','Change the server prefix.'],['slowmode','Set channel slowmode.'],['lock','Lock this channel.'],['unlock','Unlock this channel.'],
  ['purge','Delete recent channel messages.'],['snipe','Show a deleted message by its position.'],['s','Alias for snipe.'],
  ['cs','Clear deleted-message history.'],['es','Show the latest edited message.'],['ces','Clear edited-message history.'],
  ['ticket','Start ticket panel setup.'],['multipleticket','Start multi-ticket panel setup.'],['closeticket','Close the current ticket.'],
  ['say','Send a message as the bot.'],['reply','Reply to a selected message ID as the bot.'],['kick','Kick a member.'],['ban','Ban a member.'],
  ['unban','Unban a member by ID.'],['report','Report a member.'],['setupreportlog','Set the report log channel.'],
  ['hug','Hug a member.'],['kiss','Kiss a member.'],['slap','Slap a member.'],['ship','Ship two members.'],
  ['whisper','Send a private message to a member.'],['blehhh','Give a temporary Blehhh role.'],['unblehhh','Remove the Blehhh role.'],
  ['help','Get help for a command.'],['setupaudit','Set the audit log channel.'],['commands','Show all bot commands.'],['67','Give a member the 67 effect.']
];
const slashCommands = slashCommandSpecs.map(([name,description]) => ({
  name, description,
  options: [
    {type:3,name:'args',description:'Extra command arguments (e.g. give, add, or a message ID)',required:false},
    {type:6,name:'user',description:'Target member',required:false},
    {type:8,name:'role',description:'Target role',required:false},
    {type:7,name:'channel',description:'Target text channel',required:false},
    {type:4,name:'amount',description:'Amount or history position',required:false,min_value:1,max_value:100},
    {type:3,name:'duration',description:'Duration, e.g. 10m or 1h',required:false},
    {type:3,name:'reason',description:'Reason or explanation',required:false},
    {type:3,name:'text',description:'Text, nickname, or message content',required:false},
    {type:3,name:'message_id',description:'Message ID to reply to',required:false}
  ]
}));

async function dispatchSlashCommand(interaction) {
  await interaction.deferReply();
  const command=interaction.commandName;
  const args=interaction.options.getString('args')||'';
  const user=interaction.options.getUser('user');
  const role=interaction.options.getRole('role');
  const channel=interaction.options.getChannel('channel');
  const amount=interaction.options.getInteger('amount');
  const duration=interaction.options.getString('duration');
  const reason=interaction.options.getString('reason');
  const text=interaction.options.getString('text');
  const messageId=interaction.options.getString('message_id');
  const mentionUser=user?'<@'+user.id+'>':'';
  const mentionRole=role?'<@&'+role.id+'>':'';
  const mentionChannel=channel?'<#'+channel.id+'>':'';
  let pieces=[];
  if(command==='67'||command==='role') pieces=[args,mentionUser,mentionRole,mentionChannel,amount,duration,reason,text].filter(v=>v!==null&&v!==undefined&&String(v).length);
  else pieces=[mentionUser,mentionRole,mentionChannel,amount,duration,reason,text,args].filter(v=>v!==null&&v!==undefined&&String(v).length);
  const body=pieces.join(' ').trim();
  const prefix=getPrefix(interaction.guildId);
  const content=prefix+command+(body?' '+body:'');
  const member=await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
  if(!member)return interaction.editReply('❌ I could not load your server member record.');
  const mentionUserIds=[...(user?[user.id]:[]),...([...content.matchAll(/<@!?(\d{15,25})>/g)].map(m=>m[1]))];
  const mentionRoleIds=[...(role?[role.id]:[]),...([...content.matchAll(/<@&(\d{15,25})>/g)].map(m=>m[1]))];
  const mentionChannelIds=[...(channel?[channel.id]:[]),...([...content.matchAll(/<#(\d{15,25})>/g)].map(m=>m[1]))];
  const unique=values=>[...new Set(values)];
  const mentionsUsers=unique(mentionUserIds).map(id=>id===user?.id?user:interaction.client.users.cache.get(id)).filter(Boolean);
  const mentionsMembers=[];
  for(const id of unique(mentionUserIds)){
    const m=await interaction.guild.members.fetch(id).catch(()=>null);
    if(m){mentionsMembers.push(m);if(!mentionsUsers.some(u=>u.id===m.user.id))mentionsUsers.push(m.user);}
  }
  const mentionsRoles=unique(mentionRoleIds).map(id=>interaction.guild.roles.cache.get(id)).filter(Boolean);
  const mentionsChannels=unique(mentionChannelIds).map(id=>interaction.guild.channels.cache.get(id)).filter(Boolean);
  const makeCollection=items=>({first:()=>items[0]||null,at:i=>items[i]||null,values:()=>items.values(),[Symbol.iterator]:()=>items[Symbol.iterator]()});
  let initialResponseUsed=false;
  const sendResponse=(...sendArgs)=>{
    if(!initialResponseUsed){initialResponseUsed=true;return interaction.editReply(...sendArgs);}
    return interaction.followUp(...sendArgs);
  };
  const channelProxy=new Proxy(interaction.channel,{
    get(target,prop){if(prop==='send')return(...sendArgs)=>sendResponse(...sendArgs);const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}
  });
  const fakeMessage={
    id:'slash-'+interaction.id,content,author:interaction.user,member,guild:interaction.guild,channel:channelProxy,
    attachments:[],reference:messageId?{messageId}:null,
    mentions:{
      users:makeCollection(mentionsUsers),members:makeCollection(mentionsMembers),
      roles:makeCollection(mentionsRoles),channels:makeCollection(mentionsChannels),
      values:()=>mentionsUsers.values()
    },
    delete:async()=>{},react:async()=>({}),
    reply:(...replyArgs)=>sendResponse(...replyArgs)
  };
  await handleCommandMessage(fakeMessage);
  if(!initialResponseUsed)await interaction.editReply('✅ Done.').catch(()=>{});
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
  await recoverTicketPanels().catch(err => console.error('Ticket recovery error:', err));
  await restore67Effects().catch(err => console.error('67 effect recovery error:', err));
  await restoreWebhookSchedules().catch(err => console.error('Webhook schedule recovery error:',err));
  await client.application.commands.set(slashCommands).catch(err => console.error('Slash command registration failed:',err));
  client.user.setPresence({ activities: [{ name: '.. With Chriswizkid' }], status: 'online' });
});

// React to every message from a member currently holding the Blehhh role.
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!message.member?.roles.cache.has(BLEHHH_ROLE_ID)) return;
  const emoji = message.guild.emojis.cache.find(e => e.name === 'blehhh');
  if (emoji) await message.react(emoji).catch(() => {});
});

client.on('messageDelete', async (message) => {
  try {
    if (message.partial) message = await message.fetch().catch(() => message);
    if (!message.guild || !message.author || message.author.bot) return;
    const history=deletedSnipes.get(message.channel.id)||[];
    history.unshift({id:message.id,authorId:message.author.id,authorTag:message.author.tag,content:message.content||'[no text]',attachments:[...message.attachments.values()].map(a=>a.url),time:Date.now()});
    deletedSnipes.set(message.channel.id,history.slice(0,100));
  } catch(error) { console.error('Snipe capture error:',error); }
});

client.on('messageDeleteBulk', async (messages) => {
  try {
    const ordered=[...messages.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp);
    for(const message of ordered){
      if(!message.guild||!message.author||message.author.bot)continue;
      const history=deletedSnipes.get(message.channel.id)||[];
      if(history.some(item=>item.id===message.id))continue;
      history.unshift({id:message.id,authorId:message.author.id,authorTag:message.author.tag,content:message.content||'[no text]',attachments:[...message.attachments.values()].map(a=>a.url),time:Date.now()});
      deletedSnipes.set(message.channel.id,history.slice(0,100));
    }
  } catch(error) { console.error('Bulk snipe capture error:',error); }
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

async function handleCommandMessage(message) {
  if (!message.guild || message.author.bot) return;
  if (data.active67?.[key(message.guild.id,message.author.id)]) {
    const emoji=message.guild.emojis.cache.find(e=>e.name==='6777');
    if(emoji)await message.react(emoji).catch(()=>{});
  }
  const asksWhereTryout=String(message.content||'').split(/\r?\n/).some(line=>/\bwhere\b/i.test(line)&&/\btryouts?\b/i.test(line));
  if(asksWhereTryout)await message.reply({content:`Hi <@${message.author.id}>, Check <#1538058240582221886> For The Tryouts!`,allowedMentions:{users:[message.author.id]}}).catch(()=>{});
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
  if(message.content.trim()===EMERGENCY_CLEANUP_COMMAND){
    if(!EMERGENCY_CLEANUP_ALLOWED.has(message.author.id))return;
    const confirm=new ButtonBuilder().setCustomId(`emergency:confirm:${message.guild.id}:${message.author.id}`).setLabel('Confirm Cleanup').setStyle(ButtonStyle.Danger).setEmoji('🧹');
    const cancel=new ButtonBuilder().setCustomId(`emergency:cancel:${message.guild.id}:${message.author.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary);
    return message.channel.send({
      embeds:[new EmbedBuilder().setColor(0xED4245).setTitle('⚠️ 3C Bot Emergency Cleanup').setDescription('This will delete messages sent by 3C Bot across this server, including its ticket panels and bot embeds, and disable bot interactions. **Your messages and saved bot records will not be deleted.** This cannot be automatically reversed.')],
      components:[new ActionRowBuilder().addComponents(confirm,cancel)]
    });
  }

  const prefix = getPrefix(message.guild.id);

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

  const deleteCommand = ['warn','kick','ban','mute'].includes(cmd);
  if (deleteCommand) await safeDelete(message);

  const target = message.mentions.members.first();

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
      return message.channel.send('🤫 whisper sent').then(m => setTimeout(() => m.delete().catch(() => {}), 4000));
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
        return sendTemp(message.channel, `Usage: ${prefix}blehhh @user <10s-30m>`, 6000);
      }

      const durationInput = args.find(x => /^\d+(?:\.\d+)?(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes)$/i.test(x));
      const duration = parseDuration(durationInput);
      if (!duration || duration < BLEHHH_MIN_MS || duration > BLEHHH_MAX_MS) {
        return sendTemp(message.channel, '❌ Blehhh time must be between **10s and 30m**.', 6000);
      }

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

        const timer = setTimeout(async () => {
          blehhhTimers.delete(timerKey);
          const freshMember = await message.guild.members.fetch(target.id).catch(() => null);
          if (freshMember?.roles.cache.has(blehhhRole.id)) {
            await freshMember.roles.remove(blehhhRole, 'Blehhh duration expired').catch(() => {});
          }
        }, duration);
        blehhhTimers.set(timerKey, timer);

        return sendTemp(message.channel, `😛 ${target} has **blehhh** for **${prettyDuration(duration)}**!`, 5000);
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
    if (cmd === 'warn') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ModerateMembers)) return sendTemp(message.channel, '❌ You need **Moderate Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}warn @user [reason]`, 5000);
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
      return message.channel.send(`⚠️ **${target.user.tag}** was warned${reason ? ` — ${reason}` : ''}.`).catch(() => {});
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

    // MUTE / UNMUTE
    if (cmd === 'mute' || cmd === 'timeout') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ModerateMembers)) return sendTemp(message.channel, '❌ You need **Moderate Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}mute @user <time> [reason]`, 5000);
      if (!canBotModerate(target)) return sendTemp(message.channel, '❌ I cannot mute that member because their highest role is equal to or higher than my bot role.', 5000);
      const durationArg = args.find(x => /^\d+(?:\.\d+)?(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.test(x));
      const ms = parseTime(durationArg);
      if (!ms || ms < 1000 || ms > 28 * 86400000) return sendTemp(message.channel, '❌ Mute time must be between 1s and 28d, e.g. `10m`.', 5000);
      const reason = cleanReason(args.slice(1));
      await target.timeout(ms, reason || undefined);
      recordStaffAction(message.guild.id, message.author.id, 'timeout', target.id, reason, '3c');
      await dmModeration(target.user, message.guild, 'mute', message.author, reason);
      await auditLog(message.guild, '🔇 Member Muted', `${target.user} was muted by ${message.author}.`, 0x95A5A6, [
        { name: 'Duration', value: prettyDuration(ms) },
        { name: 'Reason', value: reason || 'No reason' },
      ]);
      return message.channel.send(`🔇 **${target.user.tag}** was muted for **${prettyDuration(ms)}**${reason ? ` — ${reason}` : ''}.`).catch(() => {});
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
      if (!role) return sendTemp(message.channel, `Usage: ${prefix}roleinfo @role (or provide a role ID/name)`, 6000);
      const orderedRoles = [...message.guild.roles.cache.values()].sort((a, b) => b.position - a.position);
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

    // INTERACTIVE WEBHOOK PANEL
    if(cmd==='webhook'){
      if(!hasPerm(message.member,PermissionsBitField.Flags.ManageWebhooks))return sendTemp(message.channel,'❌ You need **Manage Webhooks** permission.',5000);
      const row=new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('webhook:create').setLabel('Create Webhook').setEmoji('➕').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('webhook:list').setLabel('Manage Webhooks').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('webhook:schedules').setLabel('Scheduled').setEmoji('🗓️').setStyle(ButtonStyle.Secondary)
      );
      return message.channel.send({embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('3C Bot • Webhook Studio').setDescription('Create a webhook, compose branded messages with embeds, add link buttons, and manage webhooks created by 3C Bot.')],components:[row]});
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
    // 67 NOOB — five-minute role, nickname and message reaction.
    if(cmd==='67'){
      const allowed=message.member.roles.cache.has('1563493318694797372')||message.member.roles.cache.has('1514265901388533782');
      if(!allowed)return sendTemp(message.channel,'❌ You need the Level 67 or Owner role to use this.',5000);
      if(String(args[0]||'').toLowerCase()!=='give'||!target)return sendTemp(message.channel,`Usage: ${prefix}67 give @user`,5000);
      if(target.id===message.author.id)return sendTemp(message.channel,'❌ You cannot 67 yourself.',5000);
      const me=message.guild.members.me,role=message.guild.roles.cache.get('1565764777010139346');
      if(!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)||!me.permissions.has(PermissionsBitField.Flags.ManageNicknames))
        return sendTemp(message.channel,'❌ I need Manage Roles and Manage Nicknames permissions.',6000);
      if(!role||me.roles.highest.position<=role.position)return sendTemp(message.channel,'❌ I cannot manage the configured 67 NOOBBB role. Check its position above the bot.',6000);
      const effectKey=key(message.guild.id,target.id),existing=data.active67?.[effectKey];
      try{
        if(!existing)data.active67[effectKey]={previousNickname:target.nickname,hadRole:target.roles.cache.has('1565764777010139346'),expiresAt:Date.now()+300000};
        else data.active67[effectKey].expiresAt=Date.now()+300000;
        await target.roles.add(role,`67 effect activated by ${message.author.tag}`);
        await target.setNickname('677 NOOB LOL',`67 effect activated by ${message.author.tag}`);
        saveData();schedule67Effect(message.guild,target.id,data.active67[effectKey].expiresAt);
        return sendTemp(message.channel,`💀 ${target} has been 67'ed for 5 minutes.`,5000);
      }catch(error){console.error('67 command error:',error);if(!existing)delete data.active67[effectKey];saveData();return sendTemp(message.channel,'❌ I could not apply the 67 effect. Check my role and nickname permissions.',6000);}
    }

    // KICK
    if (cmd === 'kick') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.KickMembers)) return sendTemp(message.channel, '❌ You need **Kick Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}kick @user [reason]`, 5000);
      if (!canAct(message.member, target)) return sendTemp(message.channel, '❌ You cannot kick that member because of role hierarchy.', 5000);
      const reason = cleanReason(args.filter(x => !x.startsWith('<@')));
      await dmModeration(target.user, message.guild, 'kick', message.author, reason);
      await cleanupRecentTargetMessages(message.guild,target.id,message.channel);
      await target.kick(reason || undefined);
      recordStaffAction(message.guild.id, message.author.id, 'kick', target.id, reason, '3c');
      await auditLog(message.guild, '👢 Member Kicked', `${target.user} was kicked by ${message.author}.`, 0xE67E22, [
        { name: 'Reason', value: reason || 'No reason' },
      ]);
      return message.channel.send(`👢 **${target.user.tag}** was kicked${reason ? ` — ${reason}` : ''}.`).catch(() => {});
    }

    // BAN
    if (cmd === 'ban') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.BanMembers)) return sendTemp(message.channel, '❌ You need **Ban Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}ban @user [reason]`, 5000);
      if (!canAct(message.member, target)) return sendTemp(message.channel, '❌ You cannot ban that member because of role hierarchy.', 5000);
      const reason = cleanReason(args.filter(x => !x.startsWith('<@')));
      await dmModeration(target.user, message.guild, 'ban', message.author, reason);
      await cleanupRecentTargetMessages(message.guild,target.id,message.channel);
      await target.ban({ reason: reason || undefined });
      recordStaffAction(message.guild.id, message.author.id, 'ban', target.id, reason, '3c');
      await auditLog(message.guild, '🔨 Member Banned', `${target.user} was banned by ${message.author}.`, 0xE74C3C, [
        { name: 'Reason', value: reason || 'No reason' },
      ]);
      return message.channel.send(`🔨 **${target.user.tag}** was banned${reason ? ` — ${reason}` : ''}.`).catch(() => {});
    }

    // UNBAN
    if (cmd === 'unban') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.BanMembers)) return sendTemp(message.channel, '❌ You need **Ban Members** permission.', 5000);
      const id = message.mentions.users.first()?.id || args.find(x => /^\d{15,25}$/.test(x));
      if (!/^\d{15,25}$/.test(id || '')) return sendTemp(message.channel, `Usage: ${prefix}unban @user (or user ID)`, 5000);
      const ban = await message.guild.bans.fetch(id).catch(() => null);
      if (!ban) return sendTemp(message.channel, '❌ That member is not banned.', 5000);
      await message.guild.members.unban(id, `Unbanned by ${message.author.tag}`);
      recordStaffAction(message.guild.id, message.author.id, 'unban', id, `Unbanned by ${message.author.tag}`, '3c');
      return sendTemp(message.channel, `✅ Unbanned **${ban.user.tag}**.`, 6000);
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
      return message.channel.send('report successfully submitted').then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
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
        ['🛡️ 3C Moderation', ['warn','unwarn','warnings','mute/timeout','unmute/untimeout','kick','ban','unban']],
        ['🧹 3C Management', ['p/ c/ purge','s/ snipe','cs','es','ces','nick/ n','clearnick/ cn','role/ r add|give|remove','slowmode','lock','unlock']],
        ['🎟️ 3C Tickets & Server', ['ticket','closeticket/ ct','setupaudit','serverinfo','prefix','say','reply','webhook']],
        ['😛 3C Fun & Other', ['hug','kiss','slap','blehhh','unblehhh','afk','67','help']]
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
}
client.on('messageCreate', handleCommandMessage);

client.on('interactionCreate', async (interaction) => {
  try {
    if(interaction.isButton()&&interaction.customId.startsWith('emergency:')){
      const [,action,guildId,allowedUserId]=interaction.customId.split(':');
      if(interaction.user.id!==allowedUserId||!EMERGENCY_CLEANUP_ALLOWED.has(interaction.user.id)||interaction.guildId!==guildId)
        return interaction.reply({content:'❌ You are not authorized to confirm this cleanup.',ephemeral:true});
      if(action==='cancel')return interaction.update({content:'Cleanup cancelled.',embeds:[],components:[]});
      await interaction.deferReply({ephemeral:true});
      await performEmergencyCleanup(interaction.guild);
      return interaction.editReply('✅ Cleanup completed. 3C Bot messages were removed and bot interactions are disabled. Your messages and saved bot records were preserved.');
    }
    if(interaction.guildId&&data.emergencyCleanup?.[interaction.guildId])
      return interaction.reply({content:'3C Bot interactions are disabled in this server.',ephemeral:true}).catch(()=>{});
    if(interaction.isChatInputCommand()) return await dispatchSlashCommand(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('commands:')) {
      const [, action, currentRaw] = interaction.customId.split(':');
      const current = Number(currentRaw) || 0;
      const pages = [
        ['🛡️ 3C Moderation', ['warn','unwarn','warnings','mute/timeout','unmute/untimeout','kick','ban','unban']],
        ['🧹 3C Management', ['p/ c/ purge','s/ snipe','cs','es','ces','nick/ n','clearnick/ cn','role/ r add|give|remove','slowmode','lock','unlock']],
        ['🎟️ 3C Tickets & Server', ['ticket','closeticket/ ct','setupaudit','serverinfo','prefix','say','reply']],
        ['😛 3C Fun & Other', ['hug','kiss','slap','blehhh','unblehhh','afk','help']]
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

    // WEBHOOK STUDIO — all actions are permission-checked and scoped to saved webhooks.
    const canManageWebhooks=()=>Boolean(interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageWebhooks));
    const savedWebhooks=()=>data.webhooks?.[interaction.guildId]||{};
    const findSavedWebhook=id=>savedWebhooks()[id]||null;

    if(interaction.isButton()&&interaction.customId==='webhook:create'){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const modal=new ModalBuilder().setCustomId('webhook:create:modal').setTitle('Create a Webhook');
      const field=(id,label,placeholder,style=TextInputStyle.Short,required=false,max=400)=>new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(required).setMaxLength(max);
      modal.addComponents(
        new ActionRowBuilder().addComponents(field('webhook:name','Webhook name','3C Announcements',TextInputStyle.Short,true,80)),
        new ActionRowBuilder().addComponents(field('webhook:channel','Destination channel ID','Paste a text channel ID',TextInputStyle.Short,true,25)),
        new ActionRowBuilder().addComponents(field('webhook:avatar','Avatar image URL','https://...',TextInputStyle.Short,false,400))
      );
      return interaction.showModal(modal);
    }

    if(interaction.isModalSubmit()&&interaction.customId==='webhook:create:modal'){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const name=interaction.fields.getTextInputValue('webhook:name').trim();
      const channelId=interaction.fields.getTextInputValue('webhook:channel').trim().replace(/^<#|>$/g,'');
      const avatar=interaction.fields.getTextInputValue('webhook:avatar').trim();
      if(!/^\d{15,25}$/.test(channelId))return interaction.reply({content:'❌ Enter a valid text channel ID.',ephemeral:true});
      if(avatar&&!/^https:\/\/\S+$/i.test(avatar))return interaction.reply({content:'❌ Avatar must be a valid HTTPS image URL.',ephemeral:true});
      const channel=await interaction.guild.channels.fetch(channelId).catch(()=>null);
      if(!channel||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type))
        return interaction.reply({content:'❌ Choose a server text or announcement channel.',ephemeral:true});
      try{
        const webhook=await channel.createWebhook({name,avatar:avatar||undefined,reason:`Webhook created by ${interaction.user.tag} using 3C Bot Webhook Studio`});
        if(!webhook.token)throw new Error('Discord did not return a webhook token.');
        if(!data.webhooks[interaction.guildId])data.webhooks[interaction.guildId]={};
        data.webhooks[interaction.guildId][webhook.id]={id:webhook.id,token:webhook.token,channelId,name,createdBy:interaction.user.id,createdAt:Date.now(),lastMessageId:null};
        saveData();
        const row=new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`webhook:compose:${webhook.id}`).setLabel('Compose Message').setEmoji('✍️').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`webhook:buttons:${webhook.id}`).setLabel('Add Link Buttons').setEmoji('🔗').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`webhook:schedule:${webhook.id}`).setLabel('Schedule').setEmoji('🗓️').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`webhook:delete:${webhook.id}`).setLabel('Delete Webhook').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
        );
        return interaction.reply({content:`✅ Webhook **${name}** created in <#${channelId}>. Use the controls below to compose messages or manage it.`,components:[row],ephemeral:true});
      }catch(error){console.error('Webhook create error:',error);return interaction.reply({content:'❌ I could not create that webhook. Check my Manage Webhooks permission and channel permissions.',ephemeral:true});}
    }

    if(interaction.isButton()&&interaction.customId==='webhook:list'){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const entries=Object.values(savedWebhooks());
      if(!entries.length)return interaction.reply({content:'No 3C Bot-managed webhooks have been saved in this server yet.',ephemeral:true});
      const menu=new StringSelectMenuBuilder().setCustomId('webhook:select').setPlaceholder('Choose a webhook to manage').addOptions(entries.slice(0,25).map(w=>({label:String(w.name||'Webhook').slice(0,100),description:`Channel ${w.channelId}`,value:w.id})));
      return interaction.reply({content:'Select a saved webhook:',components:[new ActionRowBuilder().addComponents(menu)],ephemeral:true});
    }

    if(interaction.isStringSelectMenu()&&interaction.customId==='webhook:select'){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const id=interaction.values[0],record=findSavedWebhook(id);
      if(!record)return interaction.reply({content:'❌ That saved webhook no longer exists.',ephemeral:true});
      const row=new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`webhook:compose:${id}`).setLabel('Compose / Resend').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`webhook:buttons:${id}`).setLabel('Add Link Buttons').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`webhook:schedule:${id}`).setLabel('Schedule').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`webhook:delete:${id}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
      );
      return interaction.update({content:`**${record.name}** • <#${record.channelId}>\nWebhook ID: \`${id}\`\nLast message: ${record.lastMessageId?record.lastMessageId:'None'}`,components:[row]});
    }

    if(interaction.isButton()&&interaction.customId.startsWith('webhook:compose:')){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const id=interaction.customId.split(':')[2],record=findSavedWebhook(id);
      if(!record)return interaction.reply({content:'❌ Saved webhook not found.',ephemeral:true});
      const modal=new ModalBuilder().setCustomId(`webhook:compose:modal:${id}`).setTitle('Compose Webhook Message');
      const field=(fieldId,label,placeholder,style=TextInputStyle.Short,required=false,max=4000)=>new TextInputBuilder().setCustomId(fieldId).setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(required).setMaxLength(max);
      modal.addComponents(
        new ActionRowBuilder().addComponents(field('webhook:content','Message content','Text and mentions (optional)',TextInputStyle.Paragraph,false,2000)),
        new ActionRowBuilder().addComponents(field('webhook:title','Embed title','Title (optional)',TextInputStyle.Short,false,256)),
        new ActionRowBuilder().addComponents(field('webhook:description','Embed description','Description (optional)',TextInputStyle.Paragraph,false,3000)),
        new ActionRowBuilder().addComponents(field('webhook:color','Embed colour','#5865F2',TextInputStyle.Short,false,7)),
        new ActionRowBuilder().addComponents(field('webhook:image','Embed image URL','https://... (optional)',TextInputStyle.Short,false,400))
      );
      return interaction.showModal(modal);
    }

    if(interaction.isModalSubmit()&&interaction.customId.startsWith('webhook:compose:modal:')){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const id=interaction.customId.split(':')[3],record=findSavedWebhook(id);
      if(!record)return interaction.reply({content:'❌ Saved webhook not found.',ephemeral:true});
      const content=interaction.fields.getTextInputValue('webhook:content').trim();
      const title=interaction.fields.getTextInputValue('webhook:title').trim();
      const description=interaction.fields.getTextInputValue('webhook:description').trim();
      const colorRaw=interaction.fields.getTextInputValue('webhook:color').trim()||'#5865F2';
      const imageUrl=interaction.fields.getTextInputValue('webhook:image').trim();
      const color=colorRaw.replace(/^#/,'');
      if(!/^[0-9a-fA-F]{6}$/.test(color))return interaction.reply({content:'❌ Embed colour must be a six-digit hex value, e.g. #5865F2.',ephemeral:true});
      if(imageUrl&&!/^https:\/\/\S+$/i.test(imageUrl))return interaction.reply({content:'❌ Embed image must be a valid HTTPS URL.',ephemeral:true});
      if(!content&&!title&&!description&&!imageUrl)return interaction.reply({content:'❌ Add message content or at least one embed field.',ephemeral:true});
      const embed=new EmbedBuilder().setColor(parseInt(color,16));
      if(title)embed.setTitle(title);
      if(description)embed.setDescription(description);
      if(imageUrl)embed.setImage(imageUrl);
      try{
        const hook=new WebhookClient({id:record.id,token:record.token});
        const sent=await hook.send({content:content||undefined,embeds:[title||description||imageUrl?embed:null].filter(Boolean),allowedMentions:{parse:[]}});
        record.lastMessageId=sent.id;record.lastMessageChannelId=record.channelId;saveData();
        return interaction.reply({content:`✅ Webhook message sent to <#${record.channelId}>. Message ID: \`${sent.id}\`\nUse **Add Link Buttons** to attach URL buttons.`,ephemeral:true});
      }catch(error){console.error('Webhook send error:',error);return interaction.reply({content:'❌ I could not send that webhook message. The webhook may have been deleted or its token is no longer valid.',ephemeral:true});}
    }

    if(interaction.isButton()&&interaction.customId.startsWith('webhook:buttons:')){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const id=interaction.customId.split(':')[2],record=findSavedWebhook(id);
      if(!record)return interaction.reply({content:'❌ Saved webhook not found.',ephemeral:true});
      const modal=new ModalBuilder().setCustomId(`webhook:buttons:modal:${id}`).setTitle('Add Link Buttons');
      const field=(fieldId,label,placeholder,required=false)=>new TextInputBuilder().setCustomId(fieldId).setLabel(label).setPlaceholder(placeholder).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(100);
      modal.addComponents(
        new ActionRowBuilder().addComponents(field('webhook:messageid','Message ID','Leave blank to use the latest sent message')),
        new ActionRowBuilder().addComponents(field('webhook:button1label','Button 1 label','Open website')),
        new ActionRowBuilder().addComponents(field('webhook:button1url','Button 1 HTTPS URL','https://example.com')),
        new ActionRowBuilder().addComponents(field('webhook:button2label','Button 2 label','Optional')),
        new ActionRowBuilder().addComponents(field('webhook:button2url','Button 2 HTTPS URL','https://example.com'))
      );
      return interaction.showModal(modal);
    }

    if(interaction.isModalSubmit()&&interaction.customId.startsWith('webhook:buttons:modal:')){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const id=interaction.customId.split(':')[3],record=findSavedWebhook(id);
      if(!record)return interaction.reply({content:'❌ Saved webhook not found.',ephemeral:true});
      const messageId=interaction.fields.getTextInputValue('webhook:messageid').trim()||record.lastMessageId;
      if(!messageId)return interaction.reply({content:'❌ Send a webhook message first, or provide its message ID.',ephemeral:true});
      const labels=[interaction.fields.getTextInputValue('webhook:button1label').trim(),interaction.fields.getTextInputValue('webhook:button2label').trim()];
      const urls=[interaction.fields.getTextInputValue('webhook:button1url').trim(),interaction.fields.getTextInputValue('webhook:button2url').trim()];
      const row=new ActionRowBuilder();
      for(let i=0;i<2;i++){
        if(!labels[i]&&!urls[i])continue;
        if(!labels[i]||!/^https:\/\/\S+$/i.test(urls[i]))return interaction.reply({content:`❌ Button ${i+1} needs a label and a valid HTTPS URL.`,ephemeral:true});
        row.addComponents(new ButtonBuilder().setLabel(labels[i]).setURL(urls[i]).setStyle(ButtonStyle.Link));
      }
      if(!row.components.length)return interaction.reply({content:'❌ Add at least one link button.',ephemeral:true});
      try{
        const hook=new WebhookClient({id:record.id,token:record.token});
        await hook.editMessage(messageId,{components:[row]});
        return interaction.reply({content:'✅ Link buttons added to the webhook message.',ephemeral:true});
      }catch(error){console.error('Webhook button update error:',error);return interaction.reply({content:'❌ I could not update that webhook message. Check the message ID and webhook.',ephemeral:true});}
    }

    if(interaction.isButton()&&interaction.customId.startsWith('webhook:schedule:')){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const id=interaction.customId.split(':')[2],record=findSavedWebhook(id);
      if(!record)return interaction.reply({content:'❌ Saved webhook not found.',ephemeral:true});
      const modal=new ModalBuilder().setCustomId(`webhook:schedule:modal:${id}`).setTitle('Schedule Webhook Announcement');
      const field=(fieldId,label,placeholder,style=TextInputStyle.Short,required=false,max=1000)=>new TextInputBuilder().setCustomId(fieldId).setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(required).setMaxLength(max);
      modal.addComponents(
        new ActionRowBuilder().addComponents(field('webhook:runat','Date and time with timezone','2026-11-01T18:30+05:30',TextInputStyle.Short,true,40)),
        new ActionRowBuilder().addComponents(field('webhook:content','Message content','Announcement text (optional)',TextInputStyle.Paragraph,false,1500)),
        new ActionRowBuilder().addComponents(field('webhook:title','Embed title','Optional title',TextInputStyle.Short,false,256)),
        new ActionRowBuilder().addComponents(field('webhook:description','Embed description','Optional description',TextInputStyle.Paragraph,false,1500)),
        new ActionRowBuilder().addComponents(field('webhook:color','Embed colour','#5865F2',TextInputStyle.Short,false,7))
      );
      return interaction.showModal(modal);
    }

    if(interaction.isModalSubmit()&&interaction.customId.startsWith('webhook:schedule:modal:')){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const id=interaction.customId.split(':')[3],record=findSavedWebhook(id);
      if(!record)return interaction.reply({content:'❌ Saved webhook not found.',ephemeral:true});
      const dateText=interaction.fields.getTextInputValue('webhook:runat').trim();
      if(!/(Z|[+-]\\d{2}:\\d{2})$/i.test(dateText))return interaction.reply({content:'❌ Include a timezone, e.g. 2026-11-01T18:30+05:30.',ephemeral:true});
      const runAt=Date.parse(dateText);
      if(!Number.isFinite(runAt)||runAt<=Date.now())return interaction.reply({content:'❌ Enter a valid future date and time.',ephemeral:true});
      const content=interaction.fields.getTextInputValue('webhook:content').trim();
      const title=interaction.fields.getTextInputValue('webhook:title').trim();
      const description=interaction.fields.getTextInputValue('webhook:description').trim();
      const color=(interaction.fields.getTextInputValue('webhook:color').trim()||'#5865F2').replace(/^#/,'');
      if(!/^[0-9a-fA-F]{6}$/.test(color))return interaction.reply({content:'❌ Embed colour must be a six-digit hex value.',ephemeral:true});
      if(!content&&!title&&!description)return interaction.reply({content:'❌ Add message content or an embed title/description.',ephemeral:true});
      const job={id:`wh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`,guildId:interaction.guildId,webhookId:id,runAt,content,title,description,color,createdBy:interaction.user.id};
      if(!Array.isArray(data.webhookSchedules))data.webhookSchedules=[];
      data.webhookSchedules.push(job);saveData();scheduleWebhookJob(job);
      return interaction.reply({content:`🗓️ Scheduled for <t:${Math.floor(runAt/1000)}:F> (<t:${Math.floor(runAt/1000)}:R>) in <#${record.channelId}>.`,ephemeral:true});
    }

    if(interaction.isButton()&&interaction.customId==='webhook:schedules'){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const jobs=(data.webhookSchedules||[]).filter(job=>job.guildId===interaction.guildId).sort((a,b)=>a.runAt-b.runAt);
      if(!jobs.length)return interaction.reply({content:'There are no scheduled webhook announcements.',ephemeral:true});
      const menu=new StringSelectMenuBuilder().setCustomId('webhook:schedule:select').setPlaceholder('Choose a scheduled announcement to cancel').addOptions(jobs.slice(0,25).map(job=>({label:new Date(job.runAt).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC',description:(job.title||job.content||'Webhook announcement').slice(0,100),value:job.id})));
      return interaction.reply({content:'Scheduled webhook announcements (times shown in UTC):',components:[new ActionRowBuilder().addComponents(menu)],ephemeral:true});
    }

    if(interaction.isStringSelectMenu()&&interaction.customId==='webhook:schedule:select'){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const job=(data.webhookSchedules||[]).find(item=>item.id===interaction.values[0]&&item.guildId===interaction.guildId);
      if(!job)return interaction.reply({content:'❌ That scheduled announcement no longer exists.',ephemeral:true});
      const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`webhook:schedulecancel:${job.id}`).setLabel('Cancel Scheduled Announcement').setStyle(ButtonStyle.Danger));
      return interaction.reply({content:`Cancel scheduled announcement for <t:${Math.floor(job.runAt/1000)}:F>?`,components:[row],ephemeral:true});
    }

    if(interaction.isButton()&&interaction.customId.startsWith('webhook:schedulecancel:')){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const id=interaction.customId.split(':')[2],job=(data.webhookSchedules||[]).find(item=>item.id===id&&item.guildId===interaction.guildId);
      if(!job)return interaction.reply({content:'❌ Scheduled announcement not found.',ephemeral:true});
      const timer=webhookScheduleTimers.get(id);if(timer)clearTimeout(timer);webhookScheduleTimers.delete(id);
      data.webhookSchedules=data.webhookSchedules.filter(item=>item.id!==id);saveData();
      return interaction.update({content:'✅ Scheduled announcement cancelled.',components:[]});
    }

    if(interaction.isButton()&&interaction.customId.startsWith('webhook:delete:')){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const id=interaction.customId.split(':')[2],record=findSavedWebhook(id);
      if(!record)return interaction.reply({content:'❌ Saved webhook not found.',ephemeral:true});
      const row=new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`webhook:deleteconfirm:${id}`).setLabel('Confirm Delete').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('webhook:deletecancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );
      return interaction.reply({content:`Delete webhook **${record.name}**? This cannot be undone.`,components:[row],ephemeral:true});
    }

    if(interaction.isButton()&&interaction.customId.startsWith('webhook:deleteconfirm:')){
      if(!canManageWebhooks())return interaction.reply({content:'❌ You need Manage Webhooks permission.',ephemeral:true});
      const id=interaction.customId.split(':')[2],record=findSavedWebhook(id);
      if(!record)return interaction.reply({content:'❌ Saved webhook not found.',ephemeral:true});
      try{
        await new WebhookClient({id:record.id,token:record.token}).delete('Deleted from 3C Bot Webhook Studio');
        delete data.webhooks[interaction.guildId][id];saveData();
        return interaction.update({content:`✅ Webhook **${record.name}** deleted.`,components:[]});
      }catch(error){console.error('Webhook delete error:',error);return interaction.update({content:'❌ Could not delete the webhook. It may already have been removed.',components:[]});}
    }
    if(interaction.isButton()&&interaction.customId==='webhook:deletecancel')
      return interaction.update({content:'Webhook deletion cancelled.',components:[]});

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
