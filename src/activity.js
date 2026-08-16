'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { DATA_DIR } = require('./store');
const { whenAccountStoreReady } = require('./genshin/accountStore');

const COMMAND_CHANNEL_ID = process.env.ACTIVITY_CHANNEL_ID || '1538570405617598505';
const DATA_CHANNEL_NAME = 'neverless-data';
const RECORD_PREFIX = 'NLACT1|';
const LOCAL_FILE = path.join(DATA_DIR, 'activity.json');
const MAX_SCAN_MESSAGES = 5000;
const XP_PER_MESSAGE = 10;
const XP_COOLDOWN_MS = 45_000;
const DUPLICATE_COOLDOWN_MS = 5 * 60_000;
const FLUSH_DELAY_MS = 10_000;
const KUWAIT_OFFSET_MS = 3 * 60 * 60 * 1000;

let state = { guilds: {} };
let dataChannel = null;
let targetGuildId = null;
let readyPromise = Promise.resolve();
let flushTimer = null;
let flushQueue = Promise.resolve();
const dirty = new Set();
const recordMessageIds = new Map();
const activityCooldowns = new Map();
const inviteCache = new Map();
const inviteQueues = new Map();
const recentlyDeletedInvites = new Map();

function ensureLoaded() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOCAL_FILE)) {
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(state, null, 2));
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.guilds) state = parsed;
  } catch (error) {
    console.warn('[activity] Failed to load local fallback:', error.message);
  }
}

ensureLoaded();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function guildState(guildId) {
  const id = String(guildId);
  if (!state.guilds[id]) state.guilds[id] = { users: {} };
  if (!state.guilds[id].users) state.guilds[id].users = {};
  return state.guilds[id];
}

function getRecord(guildId, userId) {
  const guild = guildState(guildId);
  const id = String(userId);
  if (!guild.users[id]) {
    guild.users[id] = {
      allXp: 0,
      dayKey: '', dayXp: 0,
      weekKey: '', weekXp: 0,
      monthKey: '', monthXp: 0,
      invites: 0,
      updatedAt: '1970-01-01T00:00:00.000Z',
    };
  }
  return guild.users[id];
}

function isoWeekKey(localDate) {
  const date = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function periodKeys(now = Date.now()) {
  const local = new Date(Number(now) + KUWAIT_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return {
    day: `${year}-${month}-${day}`,
    week: isoWeekKey(local),
    month: `${year}-${month}`,
  };
}

function currentizeRecord(record, now = Date.now()) {
  const keys = periodKeys(now);
  if (record.dayKey !== keys.day) { record.dayKey = keys.day; record.dayXp = 0; }
  if (record.weekKey !== keys.week) { record.weekKey = keys.week; record.weekXp = 0; }
  if (record.monthKey !== keys.month) { record.monthKey = keys.month; record.monthXp = 0; }
  return record;
}

function levelFromXp(xp) {
  const safe = Math.max(0, cleanInt(xp));
  return Math.floor((Math.sqrt(1 + safe * 0.08) - 1) / 2);
}

function xpForNextLevel(level) {
  const next = Math.max(0, cleanInt(level)) + 1;
  return 50 * next * (next + 1);
}

function periodScore(record, period, now = Date.now()) {
  const keys = periodKeys(now);
  if (period === 'daily') return record.dayKey === keys.day ? cleanInt(record.dayXp) : 0;
  if (period === 'weekly') return record.weekKey === keys.week ? cleanInt(record.weekXp) : 0;
  if (period === 'monthly') return record.monthKey === keys.month ? cleanInt(record.monthXp) : 0;
  return cleanInt(record.allXp);
}

function parsePeriod(text) {
  const value = String(text || '').toLowerCase();
  if (/يومي|اليوم|daily|today/.test(value)) return 'daily';
  if (/أسبوعي|اسبوعي|الأسبوع|الاسبوع|weekly|week/.test(value)) return 'weekly';
  if (/شهري|الشهر|monthly|month/.test(value)) return 'monthly';
  return 'all';
}

function language(text) {
  return /[\u0600-\u06ff]/.test(String(text || '')) ? 'ar' : 'en';
}

function isTopCommand(text) {
  const value = String(text || '').trim().replace(/^#\s*/, '');
  return /^(?:توب|top)(?:\s|$)/iu.test(value);
}

function isInviteCommand(text) {
  const value = String(text || '').trim().replace(/^#\s*/, '');
  return /^(?:دعواتي|الدعوات|دعوات|invites|my\s*invites|myinvites)(?:\s|$)/iu.test(value);
}

function recordContent(guildId, userId, record) {
  return [
    'NLACT1', String(guildId), String(userId), cleanInt(record.allXp),
    record.dayKey || '-', cleanInt(record.dayXp),
    record.weekKey || '-', cleanInt(record.weekXp),
    record.monthKey || '-', cleanInt(record.monthXp),
    cleanInt(record.invites), record.updatedAt || new Date().toISOString(),
  ].join('|');
}

function parseRecord(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(RECORD_PREFIX)) return null;
  const parts = value.split('|');
  if (parts.length < 12) return null;
  const [, guildId, userId, allXp, dayKey, dayXp, weekKey, weekXp, monthKey, monthXp, invites, updatedAt] = parts;
  if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(userId || '')) return null;
  return {
    guildId,
    userId,
    record: {
      allXp: cleanInt(allXp),
      dayKey: dayKey === '-' ? '' : dayKey,
      dayXp: cleanInt(dayXp),
      weekKey: weekKey === '-' ? '' : weekKey,
      weekXp: cleanInt(weekXp),
      monthKey: monthKey === '-' ? '' : monthKey,
      monthXp: cleanInt(monthXp),
      invites: cleanInt(invites),
      updatedAt: updatedAt || null,
    },
  };
}

async function fetchAllMessages(channel) {
  const out = [];
  let before;
  while (out.length < MAX_SCAN_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return out;
}

function recordId(guildId, userId) {
  return `${guildId}:${userId}`;
}

function markDirty(guildId, userId) {
  dirty.add(recordId(guildId, userId));
  if (!flushTimer) flushTimer = setTimeout(() => flushDirty().catch(() => {}), FLUSH_DELAY_MS);
}

async function writeLocal() {
  const snapshot = JSON.stringify(state, null, 2);
  await fs.promises.writeFile(LOCAL_FILE, snapshot);
}

async function persistRemote(guildId, userId, record) {
  if (!dataChannel || String(dataChannel.guildId) !== String(guildId)) return;
  const id = recordId(guildId, userId);
  const content = recordContent(guildId, userId, record);
  const messageId = recordMessageIds.get(id);
  let message = messageId ? await dataChannel.messages.fetch(messageId).catch(() => null) : null;
  if (message) await message.edit(content);
  else {
    message = await dataChannel.send(content);
    recordMessageIds.set(id, message.id);
  }
}

async function flushDirty() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const ids = [...dirty];
  dirty.clear();
  if (!ids.length) return;

  flushQueue = flushQueue.then(async () => {
    await writeLocal();
    for (const id of ids) {
      const [guildId, userId] = id.split(':');
      const record = state.guilds[guildId]?.users?.[userId];
      if (!record) continue;
      await persistRemote(guildId, userId, record).catch((error) => {
        console.warn('[activity] Remote persistence failed:', error.message);
      });
    }
  });
  await flushQueue;
}

function snapshotInvite(invite) {
  return {
    code: invite.code,
    uses: invite.uses ?? 0,
    inviterId: invite.inviter?.id || null,
    maxUses: invite.maxUses ?? 0,
  };
}

function snapshotInviteCollection(invites) {
  return new Map([...invites.values()].map((invite) => [invite.code, snapshotInvite(invite)]));
}

function detectUsedInvite(before, currentInvites, deletedCandidates = []) {
  let best = null;
  for (const invite of currentInvites.values()) {
    const previous = before.get(invite.code);
    const delta = (invite.uses ?? 0) - (previous?.uses ?? 0);
    if (delta > 0 && (!best || delta > best.delta)) {
      best = { code: invite.code, inviterId: invite.inviter?.id || previous?.inviterId || null, delta, disappeared: false };
    }
  }
  if (best) return best;

  const now = Date.now();
  for (const item of deletedCandidates) {
    if (now - item.deletedAt > 15_000) continue;
    const previous = item.snapshot;
    if (!previous?.inviterId || !previous.maxUses) continue;
    if (previous.uses + 1 >= previous.maxUses) return { code: previous.code, inviterId: previous.inviterId, delta: 1, disappeared: true };
  }
  for (const previous of before.values()) {
    if (currentInvites.has(previous.code) || !previous.inviterId || !previous.maxUses) continue;
    if (previous.uses + 1 >= previous.maxUses) return { code: previous.code, inviterId: previous.inviterId, delta: 1, disappeared: true };
  }
  return null;
}

async function cacheGuildInvites(guild, bootstrap = false) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, snapshotInviteCollection(invites));
    if (bootstrap) {
      const totals = new Map();
      for (const invite of invites.values()) {
        if (!invite.inviter?.id) continue;
        totals.set(invite.inviter.id, (totals.get(invite.inviter.id) || 0) + cleanInt(invite.uses));
      }
      for (const [userId, count] of totals) {
        const record = getRecord(guild.id, userId);
        if (count > cleanInt(record.invites)) {
          record.invites = count;
          record.updatedAt = new Date().toISOString();
          markDirty(guild.id, userId);
        }
      }
    }
    return invites;
  } catch (error) {
    console.warn(`[activity-invites] Cannot fetch invites in ${guild.name}: ${error.message}`);
    return null;
  }
}

async function resolveInviteJoinUnlocked(member) {
  await readyPromise;
  if (String(member.guild.id) !== String(targetGuildId)) return;
  const before = inviteCache.get(member.guild.id) || new Map();
  const deleted = recentlyDeletedInvites.get(member.guild.id) || [];
  let currentInvites = null;
  let usedInvite = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    currentInvites = await member.guild.invites.fetch().catch(() => null);
    if (!currentInvites) break;
    usedInvite = detectUsedInvite(before, currentInvites, deleted);
    if (usedInvite) break;
    if (attempt < 3) await sleep(700);
  }
  if (!currentInvites) return;

  inviteCache.set(member.guild.id, snapshotInviteCollection(currentInvites));
  recentlyDeletedInvites.set(member.guild.id, deleted.filter((item) => Date.now() - item.deletedAt <= 15_000));
  if (!usedInvite?.inviterId) return;

  const record = getRecord(member.guild.id, usedInvite.inviterId);
  record.invites = cleanInt(record.invites) + Math.max(1, cleanInt(usedInvite.delta));
  record.updatedAt = new Date().toISOString();
  markDirty(member.guild.id, usedInvite.inviterId);
}

function resolveInviteJoin(member) {
  const guildId = member.guild.id;
  const previous = inviteQueues.get(guildId) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => resolveInviteJoinUnlocked(member));
  const queued = task.finally(() => {
    if (inviteQueues.get(guildId) === queued) inviteQueues.delete(guildId);
  });
  inviteQueues.set(guildId, queued);
  return task;
}

function messageFingerprint(message) {
  const text = String(message.content || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 180);
  if (text) return text;
  if (message.attachments?.size) return `attachment:${message.attachments.size}`;
  if (message.stickers?.size) return `sticker:${message.stickers.size}`;
  return '';
}

function qualifiesForXp(message) {
  if (!message?.guildId || message.author?.bot || message.system) return false;
  const text = String(message.content || '').trim();
  return text.length >= 3 || Boolean(message.attachments?.size) || Boolean(message.stickers?.size);
}

function awardMessageXp(message, now = Date.now()) {
  if (!qualifiesForXp(message)) return false;
  const id = recordId(message.guildId, message.author.id);
  const fingerprint = messageFingerprint(message);
  const previous = activityCooldowns.get(id);
  if (previous && now - previous.lastAwardAt < XP_COOLDOWN_MS) return false;
  if (previous && fingerprint && fingerprint === previous.fingerprint && now - previous.fingerprintAt < DUPLICATE_COOLDOWN_MS) return false;

  const record = currentizeRecord(getRecord(message.guildId, message.author.id), now);
  record.allXp = cleanInt(record.allXp) + XP_PER_MESSAGE;
  record.dayXp = cleanInt(record.dayXp) + XP_PER_MESSAGE;
  record.weekXp = cleanInt(record.weekXp) + XP_PER_MESSAGE;
  record.monthXp = cleanInt(record.monthXp) + XP_PER_MESSAGE;
  record.updatedAt = new Date(now).toISOString();
  activityCooldowns.set(id, {
    lastAwardAt: now,
    fingerprint,
    fingerprintAt: fingerprint ? now : (previous?.fingerprintAt || 0),
  });
  markDirty(message.guildId, message.author.id);
  return true;
}

function leaderboardEntries(guildId, period, now = Date.now()) {
  const users = state.guilds[String(guildId)]?.users || {};
  return Object.entries(users)
    .map(([userId, record]) => ({ userId, record, score: periodScore(record, period, now) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || cleanInt(b.record.allXp) - cleanInt(a.record.allXp) || a.userId.localeCompare(b.userId))
    .slice(0, 99);
}

function periodLabel(period, lang) {
  const ar = lang === 'ar';
  if (period === 'daily') return ar ? 'اليوم' : 'Daily';
  if (period === 'weekly') return ar ? 'الأسبوع' : 'Weekly';
  if (period === 'monthly') return ar ? 'الشهر' : 'Monthly';
  return ar ? 'الكل' : 'All Time';
}

function leaderboardComponents(period, page, pageCount, lang) {
  const ar = lang === 'ar';
  const periods = [
    ['daily', ar ? 'اليوم' : 'Daily'],
    ['weekly', ar ? 'الأسبوع' : 'Weekly'],
    ['monthly', ar ? 'الشهر' : 'Monthly'],
    ['all', ar ? 'الكل' : 'All'],
  ];
  const periodRow = new ActionRowBuilder().addComponents(...periods.map(([value, label]) =>
    new ButtonBuilder()
      .setCustomId(`nlact:period:${value}:0:${lang}`)
      .setLabel(label)
      .setStyle(value === period ? ButtonStyle.Primary : ButtonStyle.Secondary),
  ));
  const navigation = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nlact:page:${period}:${Math.max(0, page - 1)}:${lang}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`nlact:noop:${period}:${page}:${lang}`).setLabel(`${page + 1}/${Math.max(1, pageCount)}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`nlact:page:${period}:${Math.min(Math.max(0, pageCount - 1), page + 1)}:${lang}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
  );
  return [periodRow, navigation];
}

function renderLeaderboard(guildId, viewerId, period = 'all', requestedPage = 0, lang = 'ar', now = Date.now()) {
  const entries = leaderboardEntries(guildId, period, now);
  const pageCount = Math.max(1, Math.ceil(entries.length / 10));
  const page = Math.max(0, Math.min(cleanInt(requestedPage), pageCount - 1));
  const start = page * 10;
  const rows = entries.slice(start, start + 10);
  const viewerRank = entries.findIndex((row) => row.userId === String(viewerId));
  const ar = lang === 'ar';
  const lines = [];

  if (viewerRank >= 10) {
    const row = entries[viewerRank];
    lines.push(`${ar ? 'ترتيبك' : 'Your rank'}: **#${viewerRank + 1}** • ${row.score.toLocaleString('en-US')} XP • Lv.${levelFromXp(row.record.allXp)}`);
    lines.push('');
  } else if (viewerRank < 0) {
    lines.push(ar ? 'ما عندك XP بهالفترة إلى الآن.' : 'You do not have XP in this period yet.');
    lines.push('');
  }

  if (!rows.length) lines.push(ar ? 'ما فيه نقاط مسجلة بهالفترة إلى الآن.' : 'No activity points have been recorded for this period yet.');
  rows.forEach((row, index) => {
    const rank = start + index + 1;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
    lines.push(`${medal} <@${row.userId}> — **${row.score.toLocaleString('en-US')} XP** • Lv.${levelFromXp(row.record.allXp)}`);
  });

  const embed = new EmbedBuilder()
    .setColor(0x15233a)
    .setTitle(`🏆 ${ar ? 'توب التفاعل' : 'Activity Top'} — ${periodLabel(period, lang)}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: ar ? `XP: +${XP_PER_MESSAGE} للرسالة المؤهلة • كولداون 45 ثانية` : `XP: +${XP_PER_MESSAGE} per eligible message • 45s cooldown` });

  return { embeds: [embed], components: leaderboardComponents(period, page, pageCount, lang), page, pageCount };
}

async function reconcileInviteCount(guild, userId) {
  const record = getRecord(guild.id, userId);
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return cleanInt(record.invites);
  let live = 0;
  for (const invite of invites.values()) if (invite.inviter?.id === String(userId)) live += cleanInt(invite.uses);
  if (live > cleanInt(record.invites)) {
    record.invites = live;
    record.updatedAt = new Date().toISOString();
    markDirty(guild.id, userId);
  }
  return cleanInt(record.invites);
}

async function handleInviteCommand(message) {
  await readyPromise;
  const lang = language(message.content);
  const target = message.mentions?.users?.first?.() || message.author;
  const count = await reconcileInviteCount(message.guild, target.id);
  const ar = lang === 'ar';
  const self = target.id === message.author.id;
  const content = ar
    ? (self ? `دعواتك: **${count}**` : `دعوات <@${target.id}>: **${count}**`)
    : (self ? `Your invites: **${count}**` : `<@${target.id}>'s invites: **${count}**`);
  await message.reply({ content, allowedMentions: { repliedUser: false, users: [] } });
}

async function handleTopCommand(message) {
  await readyPromise;
  const lang = language(message.content);
  const period = parsePeriod(message.content);
  const payload = renderLeaderboard(message.guildId, message.author.id, period, 0, lang);
  await message.reply({ ...payload, allowedMentions: { repliedUser: false, users: [] } });
}

async function initialize(client) {
  readyPromise = (async () => {
    await whenAccountStoreReady().catch(() => {});
    const commandChannel = client.channels.cache.get(COMMAND_CHANNEL_ID)
      || await client.channels.fetch(COMMAND_CHANNEL_ID).catch(() => null);
    const guild = commandChannel?.guild;
    if (!guild) {
      console.warn(`[activity] Command channel ${COMMAND_CHANNEL_ID} not found.`);
      return;
    }
    targetGuildId = guild.id;
    dataChannel = guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;

    if (dataChannel) {
      const messages = await fetchAllMessages(dataChannel);
      for (const message of messages) {
        if (message.author?.id !== client.user.id) continue;
        const parsed = parseRecord(message.content);
        if (!parsed || parsed.guildId !== guild.id) continue;
        const local = getRecord(parsed.guildId, parsed.userId);
        const remoteTime = Date.parse(parsed.record.updatedAt || '') || Number(message.createdTimestamp) || 0;
        const localTime = Date.parse(local.updatedAt || '') || 0;
        if (remoteTime >= localTime) guildState(parsed.guildId).users[parsed.userId] = parsed.record;
        recordMessageIds.set(recordId(parsed.guildId, parsed.userId), message.id);
      }
      await writeLocal();
    }

    await cacheGuildInvites(guild, true);
    console.log(`[activity] Activity/XP and invite commands ready in ${guild.name}.`);
  })();
  return readyPromise;
}

function installActivity(client) {
  if (client.__neverlessActivityInstalled) return;
  client.__neverlessActivityInstalled = true;

  client.once('ready', () => {
    initialize(client).catch((error) => console.error('[activity] Initialization failed:', error));
  });

  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot) return;
    if (!targetGuildId || message.guildId !== targetGuildId) return;
    awardMessageXp(message);
    if (message.channelId !== COMMAND_CHANNEL_ID) return;
    if (isTopCommand(message.content)) {
      handleTopCommand(message).catch((error) => console.error('[activity] Top command failed:', error));
      return;
    }
    if (isInviteCommand(message.content)) {
      handleInviteCommand(message).catch((error) => console.error('[activity] Invite command failed:', error));
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton?.() || !interaction.customId?.startsWith('nlact:')) return;
    if (interaction.channelId !== COMMAND_CHANNEL_ID) return;
    const [prefix, action, period, pageText, langValue] = interaction.customId.split(':');
    if (prefix !== 'nlact' || action === 'noop') return;
    const lang = langValue === 'en' ? 'en' : 'ar';
    const selectedPeriod = ['daily', 'weekly', 'monthly', 'all'].includes(period) ? period : 'all';
    const page = action === 'period' ? 0 : cleanInt(pageText);
    const payload = renderLeaderboard(interaction.guildId, interaction.user.id, selectedPeriod, page, lang);
    await interaction.update(payload).catch(() => {});
  });

  client.on('inviteCreate', (invite) => {
    if (!targetGuildId || invite.guild?.id !== targetGuildId) return;
    const current = new Map(inviteCache.get(targetGuildId) || []);
    current.set(invite.code, snapshotInvite(invite));
    inviteCache.set(targetGuildId, current);
  });

  client.on('inviteDelete', (invite) => {
    if (!targetGuildId || invite.guild?.id !== targetGuildId) return;
    const cached = inviteCache.get(targetGuildId)?.get(invite.code) || snapshotInvite(invite);
    const list = recentlyDeletedInvites.get(targetGuildId) || [];
    list.push({ snapshot: cached, deletedAt: Date.now() });
    recentlyDeletedInvites.set(targetGuildId, list.slice(-20));
  });

  client.on('guildMemberAdd', (member) => {
    if (!targetGuildId || member.guild.id !== targetGuildId || member.user.bot) return;
    resolveInviteJoin(member).catch((error) => console.warn('[activity-invites] Join attribution failed:', error.message));
  });
}

module.exports = {
  installActivity,
  awardMessageXp,
  levelFromXp,
  xpForNextLevel,
  periodKeys,
  periodScore,
  parsePeriod,
  isTopCommand,
  isInviteCommand,
  renderLeaderboard,
};
