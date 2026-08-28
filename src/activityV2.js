'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder } = require('discord.js');
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
const FLUSH_DELAY_MS = 2_000;
const KUWAIT_OFFSET_MS = 3 * 60 * 60 * 1000;
const INVITE_FETCH_ATTEMPTS = 8;
const INVITE_FETCH_RETRY_MS = 750;

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
    console.warn('[activity-v2] Failed to load local fallback:', error.message);
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

function recordTimestamp(record) {
  return Date.parse(record?.updatedAt || '') || 0;
}

function mergeActivityRecords(records, now = Date.now()) {
  const candidates = (records || []).filter((record) => record && typeof record === 'object');
  const keys = periodKeys(now);
  const maxFor = (field) => candidates.reduce((best, record) => Math.max(best, cleanInt(record[field])), 0);
  const maxForPeriod = (keyField, xpField, currentKey) => candidates.reduce((best, record) => (
    record[keyField] === currentKey ? Math.max(best, cleanInt(record[xpField])) : best
  ), 0);
  const newest = candidates.reduce((best, record) => Math.max(best, recordTimestamp(record)), 0);

  return {
    allXp: maxFor('allXp'),
    dayKey: keys.day,
    dayXp: maxForPeriod('dayKey', 'dayXp', keys.day),
    weekKey: keys.week,
    weekXp: maxForPeriod('weekKey', 'weekXp', keys.week),
    monthKey: keys.month,
    monthXp: maxForPeriod('monthKey', 'monthXp', keys.month),
    invites: maxFor('invites'),
    updatedAt: newest ? new Date(newest).toISOString() : new Date(now).toISOString(),
  };
}

function sameActivityRecord(a, b) {
  if (!a || !b) return false;
  return cleanInt(a.allXp) === cleanInt(b.allXp)
    && String(a.dayKey || '') === String(b.dayKey || '')
    && cleanInt(a.dayXp) === cleanInt(b.dayXp)
    && String(a.weekKey || '') === String(b.weekKey || '')
    && cleanInt(a.weekXp) === cleanInt(b.weekXp)
    && String(a.monthKey || '') === String(b.monthKey || '')
    && cleanInt(a.monthXp) === cleanInt(b.monthXp)
    && cleanInt(a.invites) === cleanInt(b.invites);
}

function levelFromXp(xp) {
  const safe = Math.max(0, cleanInt(xp));
  return Math.floor((Math.sqrt(1 + safe * 0.08) - 1) / 2);
}

function xpForNextLevel(level) {
  const next = Math.max(0, cleanInt(level)) + 1;
  return 50 * next * (next + 1);
}

function xpRemainingForNextLevel(totalXp) {
  const xp = cleanInt(totalXp);
  const level = levelFromXp(xp);
  return Math.max(0, xpForNextLevel(level) - xp);
}

function periodScore(record, period, now = Date.now()) {
  const keys = periodKeys(now);
  if (period === 'daily') return record.dayKey === keys.day ? cleanInt(record.dayXp) : 0;
  if (period === 'weekly') return record.weekKey === keys.week ? cleanInt(record.weekXp) : 0;
  if (period === 'monthly') return record.monthKey === keys.month ? cleanInt(record.monthXp) : 0;
  return cleanInt(record.allXp);
}

function stripHash(text) {
  return String(text || '').trim().replace(/^#\s*/, '').replace(/\s+/g, ' ').trim();
}

function parsePeriod(text) {
  const value = stripHash(text).toLowerCase();
  if (/يومي|اليوم|daily|today/.test(value)) return 'daily';
  if (/أسبوعي|اسبوعي|الأسبوع|الاسبوع|weekly|week/.test(value)) return 'weekly';
  if (/شهري|الشهر|monthly|month/.test(value)) return 'monthly';
  return 'all';
}

function language(text) {
  return /[\u0600-\u06ff]/.test(String(text || '')) ? 'ar' : 'en';
}

function isInviteTopCommand(text) {
  const value = stripHash(text);
  return /^(?:توب\s+(?:دعوات|الدعوات)|top\s+invites)(?:\s|$)/iu.test(value);
}

function isSelfInviteCommand(text) {
  const value = stripHash(text);
  return /^(?:دعواتي|my\s+invites)$/iu.test(value);
}

function isMemberInviteCommand(text) {
  const value = stripHash(text);
  return /^(?:دعوات|الدعوات|invites)(?:\s|$)/iu.test(value);
}

function isActivityTopCommand(text) {
  if (isInviteTopCommand(text)) return false;
  const value = stripHash(text);
  return /^(?:توب|top)(?:\s|$)/iu.test(value);
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
        console.warn('[activity-v2] Remote persistence failed:', error.message);
      });
    }
  });
  await flushQueue;
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
  activityCooldowns.set(id, { lastAwardAt: now, fingerprint, fingerprintAt: now });
  markDirty(message.guildId, message.author.id);
  return true;
}

function leaderboardEntries(guildId, period, now = Date.now()) {
  const users = state.guilds[String(guildId)]?.users || {};
  return Object.entries(users)
    .map(([userId, record]) => ({ userId, record, score: periodScore(record, period, now) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || cleanInt(b.record.allXp) - cleanInt(a.record.allXp) || a.userId.localeCompare(b.userId));
}

function periodLabel(period, lang) {
  const ar = lang === 'ar';
  if (period === 'daily') return ar ? 'اليوم' : 'Daily';
  if (period === 'weekly') return ar ? 'الأسبوع' : 'Weekly';
  if (period === 'monthly') return ar ? 'الشهر' : 'Monthly';
  return ar ? 'الدائم' : 'All Time';
}

function rankPrefix(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

function levelSummary(record, lang) {
  const ar = lang === 'ar';
  const totalXp = cleanInt(record.allXp);
  const level = levelFromXp(totalXp);
  const remaining = xpRemainingForNextLevel(totalXp);
  return ar
    ? `Lv.${level} • باقي ${remaining.toLocaleString('en-US')} XP لـ Lv.${level + 1}`
    : `Lv.${level} • ${remaining.toLocaleString('en-US')} XP to Lv.${level + 1}`;
}

function renderActivityTop(guildId, viewerId, period = 'all', lang = 'ar', now = Date.now()) {
  const entries = leaderboardEntries(guildId, period, now);
  const rows = entries.slice(0, 10);
  const viewerRank = entries.findIndex((row) => row.userId === String(viewerId));
  const viewerRecord = getRecord(guildId, viewerId);
  const ar = lang === 'ar';
  const lines = [];

  if (viewerRank >= 10) {
    const row = entries[viewerRank];
    lines.push(`${ar ? 'ترتيبك' : 'Your rank'}: **#${viewerRank + 1}** • ${row.score.toLocaleString('en-US')} XP • ${levelSummary(row.record, lang)}`);
    if (period !== 'all') lines.push(`${ar ? 'إجمالي XP' : 'Total XP'}: ${cleanInt(row.record.allXp).toLocaleString('en-US')}`);
    lines.push('');
  } else if (viewerRank < 0) {
    lines.push(`${ar ? 'ترتيبك' : 'Your rank'}: **${ar ? 'غير مصنف بهالفترة' : 'Unranked in this period'}** • ${levelSummary(viewerRecord, lang)}`);
    lines.push(`${ar ? 'إجمالي XP' : 'Total XP'}: ${cleanInt(viewerRecord.allXp).toLocaleString('en-US')}`);
    lines.push('');
  }

  if (!rows.length) {
    lines.push(ar ? 'ما فيه XP مسجل بهالفترة إلى الآن.' : 'No XP has been recorded for this period yet.');
  } else {
    rows.forEach((row, index) => {
      const rank = index + 1;
      lines.push(`${rankPrefix(rank)} <@${row.userId}> — **${row.score.toLocaleString('en-US')} XP** • ${levelSummary(row.record, lang)}`);
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x15233a)
    .setTitle(`🏆 ${ar ? 'توب التفاعل' : 'Activity Top'} — ${periodLabel(period, lang)}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: ar ? `+${XP_PER_MESSAGE} XP للرسالة المؤهلة • كولداون 45 ثانية` : `+${XP_PER_MESSAGE} XP per eligible message • 45s cooldown` });

  return { embeds: [embed] };
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

function nextInviteCache(before, currentInvites, usedInvite) {
  const next = new Map();
  for (const invite of currentInvites.values()) {
    const snapshot = snapshotInvite(invite);
    const previous = before.get(invite.code);
    const oldUses = previous?.uses ?? 0;
    const delta = snapshot.uses - oldUses;

    if (usedInvite && delta > 0) {
      if (invite.code === usedInvite.code) snapshot.uses = oldUses + 1;
      else snapshot.uses = oldUses;
    }
    next.set(invite.code, snapshot);
  }
  return next;
}

function detectUsedInvite(before, currentInvites, deletedCandidates = []) {
  let best = null;
  for (const invite of currentInvites.values()) {
    const previous = before.get(invite.code);
    const delta = (invite.uses ?? 0) - (previous?.uses ?? 0);
    if (delta > 0 && (!best || delta > best.delta)) {
      best = { code: invite.code, inviterId: invite.inviter?.id || previous?.inviterId || null, delta };
    }
  }
  if (best) return best;

  const now = Date.now();
  for (const item of deletedCandidates) {
    if (now - item.deletedAt > 15_000) continue;
    const previous = item.snapshot;
    if (!previous?.inviterId || !previous.maxUses) continue;
    if (previous.uses + 1 >= previous.maxUses) return { code: previous.code, inviterId: previous.inviterId, delta: 1 };
  }
  for (const previous of before.values()) {
    if (currentInvites.has(previous.code) || !previous.inviterId || !previous.maxUses) continue;
    if (previous.uses + 1 >= previous.maxUses) return { code: previous.code, inviterId: previous.inviterId, delta: 1 };
  }
  return null;
}

async function refreshInviteTotals(guild, bootstrap = false) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;
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
  inviteCache.set(guild.id, snapshotInviteCollection(invites));
  if (bootstrap) await flushDirty().catch(() => {});
  return invites;
}

async function resolveInviteJoinUnlocked(member) {
  await readyPromise;
  if (String(member.guild.id) !== String(targetGuildId)) return;
  const before = inviteCache.get(member.guild.id) || new Map();
  const deleted = recentlyDeletedInvites.get(member.guild.id) || [];
  let currentInvites = null;
  let usedInvite = null;

  for (let attempt = 0; attempt < INVITE_FETCH_ATTEMPTS; attempt += 1) {
    currentInvites = await member.guild.invites.fetch().catch(() => null);
    if (!currentInvites) break;
    usedInvite = detectUsedInvite(before, currentInvites, deleted);
    if (usedInvite) break;
    if (attempt < INVITE_FETCH_ATTEMPTS - 1) await sleep(INVITE_FETCH_RETRY_MS);
  }
  if (!currentInvites) return;

  inviteCache.set(member.guild.id, nextInviteCache(before, currentInvites, usedInvite));
  recentlyDeletedInvites.set(member.guild.id, deleted.filter((item) => Date.now() - item.deletedAt <= 15_000));
  if (!usedInvite?.inviterId) return;

  const record = getRecord(member.guild.id, usedInvite.inviterId);
  record.invites = cleanInt(record.invites) + 1;
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

async function reconcileInviteCount(guild, userId) {
  const record = getRecord(guild.id, userId);
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return cleanInt(record.invites);
  let live = 0;
  for (const invite of invites.values()) {
    if (invite.inviter?.id === String(userId)) live += cleanInt(invite.uses);
  }
  if (live > cleanInt(record.invites)) {
    record.invites = live;
    record.updatedAt = new Date().toISOString();
    markDirty(guild.id, userId);
  }
  inviteCache.set(guild.id, snapshotInviteCollection(invites));
  return cleanInt(record.invites);
}

async function handleSelfOrMemberInvites(message) {
  await readyPromise;
  const lang = language(message.content);
  const ar = lang === 'ar';
  const mentioned = message.mentions?.users?.first?.() || null;
  const target = mentioned || message.author;
  const count = await reconcileInviteCount(message.guild, target.id);
  const self = target.id === message.author.id;
  const content = ar
    ? (self ? `دعواتك: **${count}**` : `دعوات <@${target.id}>: **${count}**`)
    : (self ? `Your invites: **${count}**` : `<@${target.id}>'s invites: **${count}**`);
  await message.reply({ content, allowedMentions: { repliedUser: false, users: [] } });
}

async function handleInviteTop(message) {
  await readyPromise;
  const lang = language(message.content);
  const ar = lang === 'ar';
  await refreshInviteTotals(message.guild).catch(() => null);
  const users = state.guilds[String(message.guildId)]?.users || {};
  const rows = Object.entries(users)
    .map(([userId, record]) => ({ userId, invites: cleanInt(record.invites) }))
    .filter((row) => row.invites > 0)
    .sort((a, b) => b.invites - a.invites || a.userId.localeCompare(b.userId))
    .slice(0, 10);

  const lines = rows.length
    ? rows.map((row, index) => `${rankPrefix(index + 1)} <@${row.userId}> — **${row.invites}** ${ar ? 'دعوة' : row.invites === 1 ? 'invite' : 'invites'}`)
    : [ar ? 'ما فيه دعوات مسجلة إلى الآن.' : 'No invites have been recorded yet.'];

  const embed = new EmbedBuilder()
    .setColor(0x15233a)
    .setTitle(ar ? '🏆 توب الدعوات' : '🏆 Top Invites')
    .setDescription(lines.join('\n'));

  await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false, users: [] } });
}

async function handleActivityTop(message) {
  await readyPromise;
  const lang = language(message.content);
  const period = parsePeriod(message.content);
  const payload = renderActivityTop(message.guildId, message.author.id, period, lang);
  await message.reply({ ...payload, allowedMentions: { repliedUser: false, users: [] } });
}

async function initialize(client) {
  readyPromise = (async () => {
    await whenAccountStoreReady().catch(() => {});
    const commandChannel = client.channels.cache.get(COMMAND_CHANNEL_ID)
      || await client.channels.fetch(COMMAND_CHANNEL_ID).catch(() => null);
    const guild = commandChannel?.guild;
    if (!guild) {
      console.warn(`[activity-v2] Command channel ${COMMAND_CHANNEL_ID} not found.`);
      return;
    }

    targetGuildId = guild.id;
    dataChannel = guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
    if (!dataChannel) {
      await guild.channels.fetch().catch(() => null);
      dataChannel = guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
    }

    if (dataChannel) {
      const now = Date.now();
      const messages = await fetchAllMessages(dataChannel);
      const remoteByUser = new Map();

      for (const message of messages) {
        if (message.author?.id !== client.user.id) continue;
        const parsed = parseRecord(message.content);
        if (!parsed || parsed.guildId !== guild.id) continue;
        const rows = remoteByUser.get(parsed.userId) || [];
        rows.push({
          record: parsed.record,
          messageId: message.id,
          createdTimestamp: Number(message.createdTimestamp) || 0,
        });
        remoteByUser.set(parsed.userId, rows);
      }

      for (const [userId, rows] of remoteByUser) {
        const local = getRecord(guild.id, userId);
        const merged = mergeActivityRecords([local, ...rows.map((row) => row.record)], now);
        const canonical = rows.slice().sort((a, b) => {
          const aTime = recordTimestamp(a.record) || a.createdTimestamp;
          const bTime = recordTimestamp(b.record) || b.createdTimestamp;
          return bTime - aTime || b.createdTimestamp - a.createdTimestamp;
        })[0];

        guildState(guild.id).users[userId] = merged;
        if (canonical) recordMessageIds.set(recordId(guild.id, userId), canonical.messageId);

        if (!canonical || !sameActivityRecord(merged, canonical.record) || rows.length > 1) {
          merged.updatedAt = new Date(now).toISOString();
          dirty.add(recordId(guild.id, userId));
        }
      }

      if (dirty.size) await flushDirty().catch(() => {});
      else await writeLocal();
    } else {
      console.warn('[activity-v2] neverless-data channel unavailable; using local fallback only.');
    }

    await refreshInviteTotals(guild, true).catch(() => null);
    console.log(`[activity-v2] Activity state recovered and commands ready in ${guild.name}.`);
  })();
  return readyPromise;
}

function installActivity(client) {
  if (client.__neverlessActivityV2Installed) return;
  client.__neverlessActivityV2Installed = true;

  client.once('ready', () => {
    initialize(client).catch((error) => console.error('[activity-v2] Initialization failed:', error));
  });

  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot) return;

    Promise.resolve(readyPromise).then(() => {
      if (!targetGuildId || message.guildId !== targetGuildId) return;

      awardMessageXp(message);
      if (message.channelId !== COMMAND_CHANNEL_ID) return;

      if (isInviteTopCommand(message.content)) {
        handleInviteTop(message).catch((error) => console.error('[activity-v2] Top invites failed:', error));
        return;
      }

      if (isSelfInviteCommand(message.content)) {
        handleSelfOrMemberInvites(message).catch((error) => console.error('[activity-v2] My invites failed:', error));
        return;
      }

      if (isMemberInviteCommand(message.content) && message.mentions?.users?.size) {
        handleSelfOrMemberInvites(message).catch((error) => console.error('[activity-v2] Member invites failed:', error));
        return;
      }

      if (isActivityTopCommand(message.content)) {
        handleActivityTop(message).catch((error) => console.error('[activity-v2] Activity top failed:', error));
      }
    }).catch((error) => console.error('[activity-v2] Message processing failed:', error));
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
    resolveInviteJoin(member).catch((error) => console.warn('[activity-v2] Join attribution failed:', error.message));
  });
}

module.exports = {
  installActivity,
  levelFromXp,
  xpForNextLevel,
  xpRemainingForNextLevel,
  periodKeys,
  periodScore,
  mergeActivityRecords,
  parsePeriod,
  isInviteTopCommand,
  isSelfInviteCommand,
  isMemberInviteCommand,
  isActivityTopCommand,
  renderActivityTop,
  detectUsedInvite,
  nextInviteCache,
};