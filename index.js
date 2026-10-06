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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  OverwriteType,
} = require('discord.js');

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error('Missing DISCORD_TOKEN environment variable.');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// Small JSON database. Good for testing. For a Render production bot,
// move this to MongoDB/Postgres or a persistent Render disk so it survives restarts.
const DATA_FILE = path.join(__dirname, 'data.json');
const defaultData = {
  prefixes: {},
  warnings: {},
  tickets: {},
  auditChannels: {},
};
let data = loadData();
function loadData() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { ...defaultData, ...saved };
  } catch { return structuredClone(defaultData); }
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const afk = new Map(); // guildId:userId -> { reason, since }
const deletedSnipes = new Map(); // channelId -> message data
const editedSnipes = new Map(); // channelId -> message data
const tempMuteTimers = new Map();
const blehhhCooldowns = new Map();
const blehhhTimers = new Map();
const BLEHHH_BOOSTER_ROLE_ID = '1523016721865244753';
const BLEHHH_BOOSTER_TOO_ROLE_ID = '1555575858514170';
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
  const wanted = normalizeRoleName(rawWanted);
  if (!wanted) return null;

  // First try the exact role name, then the normalized name. This means
  // users can type either the real emoji/decorated role name OR just its text.
  return guild.roles.cache.find(r => r.name.trim().toLowerCase() === rawWanted.toLowerCase()) ||
         guild.roles.cache.find(r => normalizeRoleName(r.name) === wanted) ||
         guild.roles.cache.find(r => normalizeRoleName(r.name).includes(wanted));
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
    [`${prefix}ticket`, 'Create a ticket panel, then select the existing Discord category for that panel.'],
    [`${prefix}closeticket/ ct`, 'Close the current ticket.'],
    [`${prefix}say <message>`, 'Send a message as the bot while preserving spaces, line breaks and Discord formatting.'],
    [`${prefix}reply <message>`, 'Reply to the message you selected/replied to as the bot.'],
    [`${prefix}kick @user [reason]`, 'Kick a member and DM the kick card.'],
    [`${prefix}ban @user [reason]`, 'Ban a member and DM the ban card.'],
    [`${prefix}unban <user ID>`, 'Unban a user by ID.'],
    [`${prefix}pus @user <amount>`, 'Delete recent messages from one member.'],
    [`${prefix}hug @user`, 'Hug a member.'],
    [`${prefix}kiss @user`, 'Kiss a member.'],
    [`${prefix}slap @user`, 'Slap a member.'],
    [`${prefix}blehhh @user <10s-30m>`, 'Give a member the Blehhh role for a temporary duration (boosters only).'],
    [`${prefix}unblehhh @user`, 'Remove the Blehhh role immediately (boosters only).'],
    [`${prefix}help <command>`, 'Explain one command.'],
    [`${prefix}setupaudit #channel`, 'Connect 3C audit logs to an existing channel; never creates a new channel.'],
    [`${prefix}commands`, 'Show the full command list.'],
  ];
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: '3C moderation' }], status: 'online' });
});

// React to every message from a member currently holding the Blehhh role.
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!message.member?.roles.cache.has(BLEHHH_ROLE_ID)) return;
  const emoji = message.guild.emojis.cache.find(e => e.name === 'blehhh');
  if (emoji) await message.react(emoji).catch(() => {});
});

client.on('messageDelete', async (message) => {
  if (!message.guild || !message.author || message.author.bot) return;
  deletedSnipes.set(message.channel.id, {
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || '[no text]',
    attachments: [...message.attachments.values()].map(a => a.url),
    time: Date.now(),
  });
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
    // BLEHHH
    if (cmd === 'blehhh') {
      if (message.member.roles.cache.has(BLEHHH_ROLE_ID)) {
        return sendTemp(message.channel, '❌ Members with the **Blehhh** role cannot use this command.', 6000);
      }

      const hasBoosterRole =
        message.member.roles.cache.has(BLEHHH_BOOSTER_ROLE_ID) ||
        message.member.roles.cache.has(BLEHHH_BOOSTER_TOO_ROLE_ID);

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
      const allowed = message.member.roles.cache.has(BLEHHH_BOOSTER_ROLE_ID) || message.member.roles.cache.has(BLEHHH_BOOSTER_TOO_ROLE_ID);
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
    // WARN
    if (cmd === 'warn') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ModerateMembers)) return sendTemp(message.channel, '❌ You need **Moderate Members** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}warn @user [reason]`, 5000);
      if (!canAct(message.member, target)) return sendTemp(message.channel, '❌ You cannot warn that member because of role hierarchy.', 5000);
      const reason = cleanReason(args.filter(x => !x.startsWith('<@')));
      const list = warningsFor(message.guild.id, target.id);
      list.push({ reason, moderatorId: message.author.id, at: Date.now() });
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
      const ms = parseTime(args[0]);
      if (!ms || ms < 1000 || ms > 28 * 86400000) return sendTemp(message.channel, '❌ Mute time must be between 1s and 28d, e.g. `10m`.', 5000);
      const reason = cleanReason(args.slice(1));
      await target.timeout(ms, reason || undefined);
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
          { name: 'Humans', value: String(message.guild.members.cache.filter(m => !m.user.bot).size), inline: true },
          { name: 'Bots', value: String(message.guild.members.cache.filter(m => m.user.bot).size), inline: true },
          { name: 'Channels', value: String(message.guild.channels.cache.size), inline: true },
          { name: 'Roles', value: String(message.guild.roles.cache.size), inline: true },
          { name: 'Boosts', value: String(message.guild.premiumSubscriptionCount || 0), inline: true },
          { name: 'Created', value: `<t:${Math.floor(message.guild.createdTimestamp / 1000)}:F>`, inline: false },
        ).setFooter({ text: `Server ID: ${message.guild.id}` });
      return message.channel.send({ embeds: [e] });
    }

    // ROLE
    if (cmd === 'role' || cmd === 'r') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageRoles)) return sendTemp(message.channel, '❌ You need **Manage Roles** permission.', 5000);
      const action = (args.shift() || '').toLowerCase();
      if (!['add','give','remove'].includes(action) || !target) return sendTemp(message.channel, `Usage: ${prefix}role add|give|remove @user <role>`, 5000);
      const role = findRole(message.guild, removeMentionArgs(args).join(' '));
      if (!role) return sendTemp(message.channel, '❌ I could not find that role. Type the role name normally; no special formatting is needed.', 5000);
      if (role.managed || role.position >= message.guild.members.me.roles.highest.position) return sendTemp(message.channel, '❌ I cannot manage that role. Move my bot role above it.', 5000);
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
      const s = deletedSnipes.get(message.channel.id);
      if (!s) return sendTemp(message.channel, 'Nothing to snipe in this channel.', 5000);
      const e = new EmbedBuilder().setColor(0xED4245).setTitle('🗑️ Deleted message')
        .setAuthor({ name: s.authorTag })
        .setDescription(truncate(s.content, 4000))
        .setTimestamp(s.time);
      if (s.attachments?.length) e.addFields({ name: 'Attachments', value: s.attachments.map(x => `[attachment](${x})`).join('\n').slice(0, 1024) });
      return message.channel.send({ embeds: [e] });
    }
    if (cmd === 'cs') {
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
      data.tickets[id] = { guildId: message.guild.id, createdBy: message.author.id, categoryId: null, name: 'ticket', color: 0x5865F2, title: 'Create Ticket', embedColor: 0x5865F2, tagId: null, tagType: null };
      saveData();
      const b = new ButtonBuilder().setCustomId(`ticket:setupopen:${id}`).setLabel('Set Up Ticket Panel').setEmoji('🎟️').setStyle(ButtonStyle.Primary);
      await safeDelete(message);
      return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🎟️ Ticket Panel Setup').setDescription('Click the button below to open the ticket setup form.')], components: [new ActionRowBuilder().addComponents(b)] });
    }
    // CLOSE TICKET
    if (cmd === 'closeticket' || cmd === 'ct') {
      const topic = message.channel.topic || '';
      if (!topic.startsWith('3C-TICKET:')) return sendTemp(message.channel, '❌ This is not a 3C ticket channel.', 5000);
      const ownerId = topic.slice('3C-TICKET:'.length);
      const isStaff = hasPerm(message.member, PermissionsBitField.Flags.ManageChannels);
      if (message.author.id !== ownerId && !isStaff) return sendTemp(message.channel, '❌ Only the ticket creator or staff with Manage Channels can close this ticket.', 5000);
      const modal = new ModalBuilder().setCustomId('ticket:closemodal').setTitle('Close Ticket');
      const reason = new TextInputBuilder().setCustomId('ticket:closereason').setLabel('Close reason').setStyle(TextInputStyle.Paragraph).setPlaceholder('Why is this ticket being closed?').setRequired(true).setMaxLength(1000);
      modal.addComponents(new ActionRowBuilder().addComponents(reason));
      await message.delete().catch(()=>{});
      return message.channel.send('🔒 Use the **Close Ticket** button to enter the close reason.').then(m=>setTimeout(()=>m.delete().catch(()=>{}),5000));
    }
    // SAY — use raw message content so spacing, newlines, #, @ and Discord formatting survive.
    if (cmd === 'say') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageGuild)) return sendTemp(message.channel, '❌ You need **Manage Server** permission.', 5000);
      const rawSay = message.content.slice(prefix.length + cmd.length).trimStart();
      if (!rawSay) return sendTemp(message.channel, `Usage: ${prefix}say <message>`, 5000);
      await safeDelete(message);
      return message.channel.send({ content: rawSay, allowedMentions: { parse: [] } });
    }

    // REPLY — reply/select a message first, then use !reply <message>.
    if (cmd === 'reply') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageGuild)) return sendTemp(message.channel, '❌ You need **Manage Server** permission.', 5000);
      const rawReply = message.content.slice(prefix.length + cmd.length).trimStart();
      const referenceId = message.reference?.messageId;
      if (!referenceId) return sendTemp(message.channel, `❌ First reply to the message you want to target, then use ${prefix}reply <message>.`, 6000);
      if (!rawReply) return sendTemp(message.channel, `Usage: ${prefix}reply <message>`, 5000);
      const referenced = await message.channel.messages.fetch(referenceId).catch(() => null);
      if (!referenced) return sendTemp(message.channel, '❌ I could not find the selected message.', 5000);
      await safeDelete(message);
      return message.channel.send({
        content: rawReply,
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
      await target.ban({ reason: reason || undefined });
      await auditLog(message.guild, '🔨 Member Banned', `${target.user} was banned by ${message.author}.`, 0xE74C3C, [
        { name: 'Reason', value: reason || 'No reason' },
      ]);
      return message.channel.send(`🔨 **${target.user.tag}** was banned${reason ? ` — ${reason}` : ''}.`).catch(() => {});
    }

    // UNBAN
    if (cmd === 'unban') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.BanMembers)) return sendTemp(message.channel, '❌ You need **Ban Members** permission.', 5000);
      const id = args[0]?.replace(/[<@!>]/g, '');
      if (!/^\d{15,25}$/.test(id || '')) return sendTemp(message.channel, `Usage: ${prefix}unban <user ID>`, 5000);
      const user = await client.users.fetch(id).catch(() => null);
      if (!user) return sendTemp(message.channel, '❌ I could not find that Discord user ID.', 5000);
      await message.guild.members.unban(id);
      return sendTemp(message.channel, `✅ Unbanned **${user.tag}**.`, 6000);
    }

    // PURGE USER
    if (cmd === 'pus') {
      if (!hasPerm(message.member, PermissionsBitField.Flags.ManageMessages)) return sendTemp(message.channel, '❌ You need **Manage Messages** permission.', 5000);
      if (!target) return sendTemp(message.channel, `Usage: ${prefix}pus @user <amount>`, 5000);
      const amount = Number(removeMentionArgs(args)[0]);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) return sendTemp(message.channel, `Usage: ${prefix}pus @user <1-100>`, 5000);
      const fetched = await message.channel.messages.fetch({ limit: Math.min(100, amount + 10) });
      const matches = fetched.filter(m => m.author.id === target.id).first(amount);
      let deleted = 0;
      const recent = matches.filter(m => Date.now() - m.createdTimestamp < 14 * 86400000);
      if (recent.size) deleted += (await message.channel.bulkDelete(recent, true)).size;
      for (const m of matches.filter(m => !recent.has(m.id)).values()) { await m.delete().then(() => deleted++).catch(() => {}); }
      return sendTemp(message.channel, `🧹 Deleted **${deleted}** messages from **${target.user.tag}**.`, 6000);
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
      const lines = commandList(prefix).map(([a,b]) => `**${a}** — ${b}`);
      const e = new EmbedBuilder().setColor(0x5865F2).setTitle('3C Commands').setDescription(lines.join('\n')).setFooter({ text: `Prefix: ${prefix}` });
      return message.channel.send({ embeds: [e] });
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
        new ActionRowBuilder().addComponents(f('ticket:description','Ticket description','Explain what this ticket is for...',TextInputStyle.Paragraph,true,1000)),
        new ActionRowBuilder().addComponents(f('ticket:tag','Role/user to tag','@Tryout Staff or @username',TextInputStyle.Short,false,100))
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
      const rawTag=interaction.fields.getTextInputValue('ticket:tag').trim();
      if(!name||color===null||!title||embedColor===null||!description) return interaction.reply({content:'❌ Use 6-digit hex colors like `#5865F2`.',ephemeral:true});
      config.name=name; config.color=color; config.title=title; config.description=description; config.embedColor=embedColor; config.categoryId=null; config.tagId=null; config.tagType=null;
      if(rawTag){
        const um=rawTag.match(/^<@!?(\d{15,25})>$/), rm=rawTag.match(/^<@&(\d{15,25})>$/);
        if(um){ if(!await client.users.fetch(um[1]).catch(()=>null)) return interaction.reply({content:'❌ I could not find that user.',ephemeral:true}); config.tagId=um[1]; config.tagType='user'; }
        else if(rm){ if(!interaction.guild.roles.cache.has(rm[1])) return interaction.reply({content:'❌ I could not find that role.',ephemeral:true}); config.tagId=rm[1]; config.tagType='role'; }
        else return interaction.reply({content:'❌ Mention a user or role in the tag field.',ephemeral:true});
      }
      saveData();
      const select=new ChannelSelectMenuBuilder().setCustomId(`ticket:setupcategory:${id}`).setPlaceholder('Select Ticket Category').setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1);
      const fmt=n=>`#${n.toString(16).padStart(6,'0').toUpperCase()}`;
      return interaction.reply({embeds:[new EmbedBuilder().setColor(embedColor).setTitle('🎟️ Ticket Panel Setup').setDescription(`**Ticket name:** ${name}\n**Ticket color:** ${fmt(color)}\n**Embed name:** ${title}\n**Embed color:** ${fmt(embedColor)}\n**Ticket description:** ${description}\n**Role/user to tag:** ${config.tagId?(config.tagType==='role'?`<@&${config.tagId}>`:`<@${config.tagId}>`):'None'}\n\nSelect the **existing Discord category** where tickets should be created.`)],components:[new ActionRowBuilder().addComponents(select)],ephemeral:true});
    }

    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('ticket:setupcategory:')) {
      const id=interaction.customId.split(':')[2], config=data.tickets[id];
      if(!config||config.guildId!==interaction.guildId) return interaction.reply({content:'❌ This ticket panel no longer exists.',ephemeral:true});
      if(interaction.user.id!==config.createdBy&&!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({content:'❌ Only the panel creator or Manage Server can configure this.',ephemeral:true});
      const category=interaction.guild.channels.cache.get(interaction.values[0]);
      if(!category||category.type!==ChannelType.GuildCategory) return interaction.reply({content:'❌ Select an existing Discord category.',ephemeral:true});
      config.categoryId=category.id; saveData();
      const open=new ButtonBuilder().setCustomId(`ticket:create:${id}`).setLabel('Open Ticket').setEmoji('🎟️').setStyle(ButtonStyle.Primary);
      const embed=new EmbedBuilder().setColor(config.embedColor).setTitle(config.title).setDescription(config.description).setFooter({text:`Tickets will be created in: ${category.name}`});
      await interaction.channel.send({embeds:[embed],components:[new ActionRowBuilder().addComponents(open)]});
      await interaction.update({content:'✅ Ticket panel created! The panel is now visible to everyone in this channel.',embeds:[],components:[]});
      return auditLog(interaction.guild,'🎟️ Ticket Panel Configured',`${interaction.user} configured **${config.name}** in **${category.name}**.`,0x5865F2);
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket:create:')) {
      const id=interaction.customId.split(':')[2], config=data.tickets[id];
      if(!config||config.guildId!==interaction.guildId) return interaction.reply({content:'❌ This ticket panel no longer exists.',ephemeral:true});
      const existing=interaction.guild.channels.cache.find(c=>c.topic===`3C-TICKET:${interaction.user.id}`);
      if(existing) return interaction.reply({content:`You already have a ticket: ${existing}`,ephemeral:true});
      const category=interaction.guild.channels.cache.get(config.categoryId);
      if(!category||category.type!==ChannelType.GuildCategory) return interaction.reply({content:'❌ This panel has no valid ticket category.',ephemeral:true});
      const safeName=`${config.name}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,90)||'ticket';
      let channel;
      try{ channel=await interaction.guild.channels.create({name:safeName,type:ChannelType.GuildText,parent:category.id,topic:`3C-TICKET:${interaction.user.id}`,permissionOverwrites:[
        {id:interaction.guild.roles.everyone.id,deny:[PermissionsBitField.Flags.ViewChannel]},
        {id:interaction.user.id,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory,PermissionsBitField.Flags.AttachFiles]},
        {id:client.user.id,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory,PermissionsBitField.Flags.ManageChannels,PermissionsBitField.Flags.ManageMessages]}
      ]}); }catch(err){console.error('Ticket channel creation error:',err);return interaction.reply({content:'❌ I could not create the ticket. Check Manage Channels and the selected category.',ephemeral:true});}
      const close=new ButtonBuilder().setCustomId('ticket:close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger);
      const emb=new EmbedBuilder().setColor(config.color).setTitle(config.name).setDescription(config.description + `\n\nWelcome ${interaction.user}! A staff member will help you here.\n\nClick **Close Ticket** when you are finished.`);
      const tag=config.tagId?(config.tagType==='role'?`<@&${config.tagId}>`:`<@${config.tagId}>`):'';
      await channel.send({content:[interaction.user.toString(),tag].filter(Boolean).join(' '),embeds:[emb],components:[new ActionRowBuilder().addComponents(close)],allowedMentions:{users:config.tagType==='user'?[config.tagId,interaction.user.id]:[interaction.user.id],roles:config.tagType==='role'?[config.tagId]:[]}});
      await auditLog(interaction.guild,'🎟️ Ticket Created',`${channel} was created by ${interaction.user}.`,0x57F287,[{name:'Ticket Name',value:config.name},{name:'Ticket Creator',value:`${interaction.user.tag} (${interaction.user.id})`},{name:'Channel',value:`${channel} (${channel.id})`},{name:'Category',value:`${category.name} (${category.id})`}]);
      return interaction.reply({content:`🎟️ ${config.name} created: ${channel}`,ephemeral:true});
    }

    if (interaction.isButton() && interaction.customId==='ticket:close') {
      const topic=interaction.channel?.topic||''; if(!topic.startsWith('3C-TICKET:')) return interaction.reply({content:'❌ This is not a ticket.',ephemeral:true});
      const ownerId=topic.slice('3C-TICKET:'.length), staff=interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels);
      if(interaction.user.id!==ownerId&&!staff) return interaction.reply({content:'❌ Only the ticket creator or Manage Channels staff can close this ticket.',ephemeral:true});
      const modal=new ModalBuilder().setCustomId('ticket:closemodal').setTitle('Close Ticket');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket:closereason').setLabel('Close reason').setStyle(TextInputStyle.Paragraph).setPlaceholder('Why is this ticket being closed?').setRequired(true).setMaxLength(1000)));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId==='ticket:closemodal') {
      const topic=interaction.channel?.topic||''; if(!topic.startsWith('3C-TICKET:')) return interaction.reply({content:'❌ This is not a ticket.',ephemeral:true});
      const ownerId=topic.slice('3C-TICKET:'.length), staff=interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels);
      if(interaction.user.id!==ownerId&&!staff) return interaction.reply({content:'❌ You cannot close this ticket.',ephemeral:true});
      const reason=interaction.fields.getTextInputValue('ticket:closereason').trim(), ticket=interaction.channel, category=ticket.parent;
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
