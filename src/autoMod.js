'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { whenAccountStoreReady } = require('./genshin/accountStore');

const DATA_CHANNEL_NAME = 'neverless-data';
const CONFIG_PREFIX = 'NLAUTOMOD1|config|';
const WARNING_PREFIX = 'NLAUTOMOD1|warn|';
const MUTE_MS = 5 * 60 * 1000;
const SPAM_WINDOW_MS = 60 * 1000;
const SPAM_MESSAGE_COUNT = 5;
const MAX_SCAN_MESSAGES = 5000;

const forbiddenWords = new Map();
const warningCounts = new Map();
const configMessageIds = new Map();
const warningMessageIds = new Map();
const offenseQueues = new Map();
const spamSequences = new Map();
let installed = false;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '')
    .replace(/\u0640/gu, '')
    .replace(/[إأآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

function singleWord(value) {
  const tokens = tokenize(value);
  if (tokens.length !== 1 || tokens[0].length < 2) return null;
  return tokens[0];
}

function nextSpamSequence(previous, value, now = Date.now(), options = {}) {
  const word = singleWord(value);
  if (!word) return { triggered: false, word: null, count: 0, sequence: null };

  const requiredCount = Number.isInteger(options.requiredCount) && options.requiredCount > 1
    ? options.requiredCount
    : SPAM_MESSAGE_COUNT;
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : SPAM_WINDOW_MS;

  let timestamps = [];
  if (previous?.word === word && Array.isArray(previous.timestamps)) {
    timestamps = previous.timestamps.filter((timestamp) =>
      Number.isFinite(timestamp)
      && timestamp <= now
      && now - timestamp <= windowMs,
    );
  }
  timestamps.push(now);

  if (timestamps.length >= requiredCount) {
    return { triggered: true, word, count: timestamps.length, sequence: null };
  }

  return {
    triggered: false,
    word,
    count: timestamps.length,
    sequence: { word, timestamps },
  };
}

function findForbiddenPhrase(value, entries) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const padded = ` ${normalized} `;
  for (const entry of entries || []) {
    const phrase = normalizeText(entry.normalized || entry.original || entry);
    if (!phrase) continue;
    if (padded.includes(` ${phrase} `)) return entry.original || String(entry);
  }
  return null;
}

function offenseAction(previousCount) {
  const count = Number(previousCount) || 0;
  if (count <= 0) return { action: 'warning1', nextCount: 1 };
  if (count === 1) return { action: 'warning2', nextCount: 2 };
  return { action: 'mute', nextCount: 0 };
}

function configKey(guildId) {
  return String(guildId);
}

function warningKey(guildId, userId, type) {
  return `${guildId}:${userId}:${type}`;
}

function warningRemovalTypes(type) {
  if (type === 'all') return ['spam', 'language'];
  if (type === 'spam' || type === 'language') return [type];
  return [];
}

function spamSequenceKey(message) {
  return `${message.guildId}:${message.channelId}:${message.author.id}`;
}

function encodeWords(entries) {
  const list = [...entries.values()].map((entry) => entry.original);
  return Buffer.from(JSON.stringify(list), 'utf8').toString('base64url');
}

function decodeWords(encoded) {
  try {
    const parsed = JSON.parse(Buffer.from(String(encoded || ''), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 250);
  } catch {
    return [];
  }
}

function configContent(guildId, entries) {
  return `${CONFIG_PREFIX}${guildId}|${encodeWords(entries)}`;
}

function parseConfig(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(CONFIG_PREFIX)) return null;
  const rest = value.slice(CONFIG_PREFIX.length);
  const split = rest.indexOf('|');
  if (split < 0) return null;
  const guildId = rest.slice(0, split);
  if (!/^\d{15,22}$/.test(guildId)) return null;
  return { guildId, words: decodeWords(rest.slice(split + 1)) };
}

function warningContent(guildId, userId, type, count) {
  return `${WARNING_PREFIX}${guildId}|${userId}|${type}|${count}`;
}

function parseWarning(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(WARNING_PREFIX)) return null;
  const [guildId, userId, type, rawCount] = value.slice(WARNING_PREFIX.length).split('|');
  const count = Number(rawCount);
  if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(userId || '')) return null;
  if (!['spam', 'language'].includes(type)) return null;
  if (!Number.isInteger(count) || count < 0 || count > 2) return null;
  return { guildId, userId, type, count };
}

function dataChannel(guild) {
  return guild?.channels?.cache?.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name === DATA_CHANNEL_NAME,
  ) || null;
}

async function fetchAllDataMessages(channel, limit = MAX_SCAN_MESSAGES) {
  const out = [];
  let before;
  while (out.length < limit) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return out;
}

function entriesForGuild(guildId) {
  let entries = forbiddenWords.get(guildId);
  if (!entries) {
    entries = new Map();
    forbiddenWords.set(guildId, entries);
  }
  return entries;
}

async function persistConfig(guild) {
  const channel = dataChannel(guild);
  if (!channel) return false;
  const entries = entriesForGuild(guild.id);
  const content = configContent(guild.id, entries);
  const key = configKey(guild.id);
  const knownId = configMessageIds.get(key);
  let message = knownId ? await channel.messages.fetch(knownId).catch(() => null) : null;
  if (message) {
    await message.edit(content);
  } else {
    message = await channel.send(content);
    configMessageIds.set(key, message.id);
  }
  return true;
}

async function persistWarning(guild, userId, type, count) {
  const channel = dataChannel(guild);
  if (!channel) return false;
  const key = warningKey(guild.id, userId, type);
  const content = warningContent(guild.id, userId, type, count);
  const knownId = warningMessageIds.get(key);
  let message = knownId ? await channel.messages.fetch(knownId).catch(() => null) : null;
  if (message) {
    await message.edit(content);
  } else {
    message = await channel.send(content);
    warningMessageIds.set(key, message.id);
  }
  return true;
}

async function clearWarnings(guild, userId, type) {
  const types = warningRemovalTypes(type);
  const removed = [];

  for (const warningType of types) {
    const key = warningKey(guild.id, userId, warningType);
    const pending = offenseQueues.get(key);
    if (pending) await pending.catch(() => {});

    const previousCount = warningCounts.get(key) || 0;
    warningCounts.delete(key);
    await persistWarning(guild, userId, warningType, 0).catch(() => false);
    removed.push({ type: warningType, count: previousCount });
  }

  if (types.includes('spam')) {
    const prefix = `${guild.id}:`;
    const suffix = `:${userId}`;
    for (const key of [...spamSequences.keys()]) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) spamSequences.delete(key);
    }
  }

  return removed;
}

async function loadGuildState(guild) {
  await whenAccountStoreReady().catch(() => {});
  const channel = dataChannel(guild);
  if (!channel) return;
  const messages = await fetchAllDataMessages(channel);

  let latestConfig = null;
  const latestWarnings = new Map();
  for (const message of messages) {
    if (message.author?.id !== guild.members.me?.id) continue;

    const config = parseConfig(message.content);
    if (config?.guildId === guild.id && (!latestConfig || message.createdTimestamp > latestConfig.createdTimestamp)) {
      latestConfig = { ...config, messageId: message.id, createdTimestamp: message.createdTimestamp };
    }

    const warning = parseWarning(message.content);
    if (warning?.guildId === guild.id) {
      const key = warningKey(warning.guildId, warning.userId, warning.type);
      const previous = latestWarnings.get(key);
      if (!previous || message.createdTimestamp > previous.createdTimestamp) {
        latestWarnings.set(key, { ...warning, messageId: message.id, createdTimestamp: message.createdTimestamp });
      }
    }
  }

  const entries = new Map();
  for (const original of latestConfig?.words || []) {
    const normalized = normalizeText(original);
    if (normalized) entries.set(normalized, { normalized, original });
  }
  forbiddenWords.set(guild.id, entries);
  if (latestConfig) configMessageIds.set(configKey(guild.id), latestConfig.messageId);

  for (const warning of latestWarnings.values()) {
    const key = warningKey(warning.guildId, warning.userId, warning.type);
    warningMessageIds.set(key, warning.messageId);
    if (warning.count > 0) warningCounts.set(key, warning.count);
    else warningCounts.delete(key);
  }
}

function isExempt(message, member) {
  if (!message?.guild || !member) return true;
  if (member.id === message.guild.ownerId) return true;
  return member.permissions?.has(PermissionFlagsBits.Administrator) || false;
}

async function sendNotice(channel, userId, text) {
  if (!channel?.isSendable?.()) return;
  await channel.send({
    content: `<@${userId}> ${text}`,
    allowedMentions: { users: [userId] },
  }).catch(() => {});
}

async function applyOffense(message, member, type) {
  const key = warningKey(message.guild.id, member.id, type);
  const previousCount = warningCounts.get(key) || 0;
  const next = offenseAction(previousCount);

  if (next.action === 'warning1' || next.action === 'warning2') {
    warningCounts.set(key, next.nextCount);
    await persistWarning(message.guild, member.id, type, next.nextCount).catch(() => false);
    await sendNotice(
      message.channel,
      member.id,
      next.action === 'warning1' ? 'إنذار أول' : 'إنذار ثاني',
    );
    return;
  }

  const reason = type === 'spam' ? 'سبام' : 'يرجى انتقاء الألفاظ🤍';
  if (!member.moderatable) {
    warningCounts.set(key, 2);
    await persistWarning(message.guild, member.id, type, 2).catch(() => false);
    console.warn(`[automod] Cannot timeout ${member.user?.tag || member.id}; check role hierarchy.`);
    return;
  }

  try {
    await member.timeout(MUTE_MS, `Neverless AutoMod: ${reason}`);
    warningCounts.delete(key);
    await persistWarning(message.guild, member.id, type, 0).catch(() => false);
    await sendNotice(message.channel, member.id, `mute 5min reason:${reason}`);
  } catch (error) {
    warningCounts.set(key, 2);
    await persistWarning(message.guild, member.id, type, 2).catch(() => false);
    console.warn(`[automod] Timeout failed for ${member.user?.tag || member.id}: ${error.message}`);
  }
}

function queueOffense(message, member, type) {
  const key = warningKey(message.guild.id, member.id, type);
  const previous = offenseQueues.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => applyOffense(message, member, type));
  const queued = task.finally(() => {
    if (offenseQueues.get(key) === queued) offenseQueues.delete(key);
  });
  offenseQueues.set(key, queued);
  return task;
}

async function handleMessage(message) {
  if (!message?.guildId || message.author?.bot || !message.content) return;
  if (message.channel?.name === DATA_CHANNEL_NAME) return;

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member || isExempt(message, member)) return;

  const sequenceKey = spamSequenceKey(message);
  const entries = entriesForGuild(message.guildId);
  const forbidden = findForbiddenPhrase(message.content, entries.values());
  if (forbidden) {
    spamSequences.delete(sequenceKey);
    await message.delete().catch(() => {});
    await queueOffense(message, member, 'language');
    return;
  }

  const spam = nextSpamSequence(
    spamSequences.get(sequenceKey),
    message.content,
    Number.isFinite(message.createdTimestamp) ? message.createdTimestamp : Date.now(),
  );
  if (spam.sequence) spamSequences.set(sequenceKey, spam.sequence);
  else spamSequences.delete(sequenceKey);
  if (!spam.triggered) return;

  await message.delete().catch(() => {});
  await queueOffense(message, member, 'spam');
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'automod' || !interaction.guild) return false;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'هذا الأمر للـAdministrator فقط.', ephemeral: true });
    return true;
  }

  const subcommand = interaction.options.getSubcommand();
  const entries = entriesForGuild(interaction.guildId);

  if (subcommand === 'addword') {
    const original = interaction.options.getString('word', true).trim();
    const normalized = normalizeText(original);
    if (!normalized) {
      await interaction.reply({ content: 'الكلمة أو العبارة غير صالحة.', ephemeral: true });
      return true;
    }
    if (entries.has(normalized)) {
      await interaction.reply({ content: 'هذه الكلمة/العبارة موجودة بالفعل في AutoMod.', ephemeral: true });
      return true;
    }
    if (entries.size >= 250) {
      await interaction.reply({ content: 'وصلت قائمة AutoMod للحد الأقصى (250 كلمة/عبارة).', ephemeral: true });
      return true;
    }
    entries.set(normalized, { normalized, original });
    await persistConfig(interaction.guild);
    await interaction.reply({ content: `تمت إضافة **${original}** إلى الكلمات الممنوعة.`, ephemeral: true });
    return true;
  }

  if (subcommand === 'removeword') {
    const original = interaction.options.getString('word', true).trim();
    const normalized = normalizeText(original);
    if (!entries.delete(normalized)) {
      await interaction.reply({ content: 'الكلمة/العبارة غير موجودة في القائمة.', ephemeral: true });
      return true;
    }
    await persistConfig(interaction.guild);
    await interaction.reply({ content: `تم حذف **${original}** من الكلمات الممنوعة.`, ephemeral: true });
    return true;
  }

  if (subcommand === 'removewarn') {
    const target = interaction.options.getUser('member', true);
    const type = interaction.options.getString('type', true);
    const removed = await clearWarnings(interaction.guild, target.id, type);
    const active = removed.filter((row) => row.count > 0);

    if (!active.length) {
      await interaction.reply({
        content: `ما فيه إنذار نشط من النوع المحدد على <@${target.id}>.`,
        ephemeral: true,
        allowedMentions: { users: [] },
      });
      return true;
    }

    const labels = active.map((row) => `${row.type === 'spam' ? 'Spam' : 'Language'}: ${row.count}`).join(' • ');
    await interaction.reply({
      content: `تمت إزالة إنذارات <@${target.id}> — ${labels}.`,
      ephemeral: true,
      allowedMentions: { users: [] },
    });
    return true;
  }

  const list = [...entries.values()].map((entry) => entry.original);
  const text = list.length ? list.map((word, index) => `${index + 1}. ${word}`).join('\n') : 'لا توجد كلمات ممنوعة مضافة حاليًا.';
  await interaction.reply({ content: text.slice(0, 1900), ephemeral: true });
  return true;
}

function installAutoMod(client) {
  if (installed) return;
  installed = true;

  client.once('ready', async () => {
    for (const guild of client.guilds.cache.values()) {
      await loadGuildState(guild).catch((error) => {
        console.warn(`[automod] Persistence load failed in ${guild.name}: ${error.message}`);
      });
    }
  });

  client.on('guildCreate', (guild) => loadGuildState(guild).catch(() => {}));
  client.on('messageCreate', (message) => {
    handleMessage(message).catch((error) => console.error('[automod] message error:', error));
  });
  client.on('interactionCreate', (interaction) => {
    Promise.resolve(handleInteraction(interaction)).catch((error) => {
      console.error('[automod] interaction error:', error);
      if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
        interaction.reply({ content: 'صار خطأ أثناء تنفيذ أمر AutoMod.', ephemeral: true }).catch(() => {});
      }
    });
  });
}

module.exports = {
  installAutoMod,
  normalizeText,
  singleWord,
  nextSpamSequence,
  findForbiddenPhrase,
  offenseAction,
  warningRemovalTypes,
  parseConfig,
  parseWarning,
};
