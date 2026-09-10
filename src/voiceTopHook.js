'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client, EmbedBuilder } = require('discord.js');
const { DATA_DIR } = require('./store');

const COMMAND_CHANNEL_ID = process.env.ACTIVITY_CHANNEL_ID || '1538570405617598505';
const DATA_CHANNEL_NAME = 'neverless-data';
const RECORD_PREFIX = 'NLVOICE1|';
const LOCAL_FILE = path.join(DATA_DIR, 'voice-activity.json');
const MAX_SCAN_MESSAGES = 5000;
const FLUSH_DELAY_MS = 2_000;
const CHECKPOINT_MS = 5 * 60_000;
const KUWAIT_OFFSET_MS = 3 * 60 * 60 * 1000;
const HANDLED_SENTINEL = '__neverless_voice_top_handled__';

let state = { guilds: {} };
let dataChannel = null;
let targetGuildId = null;
let readyPromise = Promise.resolve();
let flushTimer = null;
let flushQueue = Promise.resolve();
let checkpointTimer = null;
const dirty = new Set();
const recordMessageIds = new Map();
const activeSessions = new Map();

function cleanMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

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
    console.warn('[voice-top] Failed to load local fallback:', error.message);
  }
}

ensureLoaded();

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
      allMs: 0,
      dayKey: '', dayMs: 0,
      weekKey: '', weekMs: 0,
      monthKey: '', monthMs: 0,
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
  if (record.dayKey !== keys.day) { record.dayKey = keys.day; record.dayMs = 0; }
  if (record.weekKey !== keys.week) { record.weekKey = keys.week; record.weekMs = 0; }
  if (record.monthKey !== keys.month) { record.monthKey = keys.month; record.monthMs = 0; }
  return record;
}

function nextKuwaitDayBoundary(now) {
  const local = new Date(Number(now) + KUWAIT_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - KUWAIT_OFFSET_MS;
}

function accrueInterval(record, startedAt, endedAt) {
  let cursor = Math.max(0, Number(startedAt) || 0);
  const end = Math.max(cursor, Number(endedAt) || 0);
  if (!cursor || end <= cursor) return 0;

  let added = 0;
  while (cursor < end) {
    currentizeRecord(record, cursor);
    const boundary = nextKuwaitDayBoundary(cursor);
    const segmentEnd = Math.min(end, boundary);
    const delta = Math.max(0, segmentEnd - cursor);
    record.allMs = cleanMs(record.allMs) + delta;
    record.dayMs = cleanMs(record.dayMs) + delta;
    record.weekMs = cleanMs(record.weekMs) + delta;
    record.monthMs = cleanMs(record.monthMs) + delta;
    added += delta;
    cursor = segmentEnd;
  }

  record.updatedAt = new Date(end).toISOString();
  return added;
}

function sessionId(guildId, userId) {
  return `${guildId}:${userId}`;
}

function recordContent(guildId, userId, record) {
  return [
    'NLVOICE1', String(guildId), String(userId), cleanMs(record.allMs),
    record.dayKey || '-', cleanMs(record.dayMs),
    record.weekKey || '-', cleanMs(record.weekMs),
    record.monthKey || '-', cleanMs(record.monthMs),
    record.updatedAt || new Date().toISOString(),
  ].join('|');
}

function parseRecord(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(RECORD_PREFIX)) return null;
  const parts = value.split('|');
  if (parts.length < 11) return null;
  const [, guildId, userId, allMs, dayKey, dayMs, weekKey, weekMs, monthKey, monthMs, updatedAt] = parts;
  if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(userId || '')) return null;
  return {
    guildId,
    userId,
    record: {
      allMs: cleanMs(allMs),
      dayKey: dayKey === '-' ? '' : dayKey,
      dayMs: cleanMs(dayMs),
      weekKey: weekKey === '-' ? '' : weekKey,
      weekMs: cleanMs(weekMs),
      monthKey: monthKey === '-' ? '' : monthKey,
      monthMs: cleanMs(monthMs),
      updatedAt: updatedAt || null,
    },
  };
}

function recordTimestamp(record) {
  return Date.parse(record?.updatedAt || '') || 0;
}

function mergeRecords(records, now = Date.now()) {
  const rows = (records || []).filter((record) => record && typeof record === 'object');
  const keys = periodKeys(now);
  const newest = rows.reduce((best, record) => Math.max(best, recordTimestamp(record)), 0);
  const maxFor = (field) => rows.reduce((best, record) => Math.max(best, cleanMs(record[field])), 0);
  const maxPeriod = (keyField, valueField, key) => rows.reduce((best, record) => (
    String(record[keyField] || '') === key ? Math.max(best, cleanMs(record[valueField])) : best
  ), 0);
  return {
    allMs: maxFor('allMs'),
    dayKey: keys.day,
    dayMs: maxPeriod('dayKey', 'dayMs', keys.day),
    weekKey: keys.week,
    weekMs: maxPeriod('weekKey', 'weekMs', keys.week),
    monthKey: keys.month,
    monthMs: maxPeriod('monthKey', 'monthMs', keys.month),
    updatedAt: newest ? new Date(newest).toISOString() : new Date(now).toISOString(),
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

function markDirty(guildId, userId) {
  dirty.add(sessionId(guildId, userId));
  if (!flushTimer) {
    flushTimer = setTimeout(() => flushDirty().catch(() => {}), FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }
}

async function writeLocal() {
  await fs.promises.writeFile(LOCAL_FILE, JSON.stringify(state, null, 2));
}

async function persistRemote(guildId, userId, record) {
  if (!dataChannel || String(dataChannel.guildId) !== String(guildId)) return;
  const key = sessionId(guildId, userId);
  const content = recordContent(guildId, userId, record);
  const knownId = recordMessageIds.get(key);
  let message = knownId ? await dataChannel.messages.fetch(knownId).catch(() => null) : null;
  if (message) await message.edit(content);
  else {
    message = await dataChannel.send(content);
    recordMessageIds.set(key, message.id);
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
        console.warn('[voice-top] Remote persistence failed:', error.message);
      });
    }
  });
  await flushQueue;
}

function checkpointGuild(guildId, now = Date.now()) {
  const prefix = `${guildId}:`;
  for (const [key, session] of activeSessions) {
    if (!key.startsWith(prefix)) continue;
    const userId = key.slice(prefix.length);
    const record = getRecord(guildId, userId);
    const added = accrueInterval(record, session.startedAt, now);
    session.startedAt = now;
    if (added > 0) markDirty(guildId, userId);
  }
}

function stripHash(text) {
  return String(text || '').trim().replace(/^#\s*/, '').replace(/\s+/g, ' ').trim();
}

function isVoiceTopCommand(text) {
  const value = stripHash(text).toLowerCase();
  if (!/^(?:توب|top)(?:\s|$)/iu.test(value)) return false;
  return /(?:صوتي|الصوتي|فويس|voice)/iu.test(value);
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

function periodScore(record, period, now = Date.now()) {
  const keys = periodKeys(now);
  if (period === 'daily') return record.dayKey === keys.day ? cleanMs(record.dayMs) : 0;
  if (period === 'weekly') return record.weekKey === keys.week ? cleanMs(record.weekMs) : 0;
  if (period === 'monthly') return record.monthKey === keys.month ? cleanMs(record.monthMs) : 0;
  return cleanMs(record.allMs);
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

function formatDuration(ms, lang = 'ar') {
  let seconds = Math.floor(cleanMs(ms) / 1000);
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  const parts = [];
  if (lang === 'ar') {
    if (days) parts.push(`${days}ي`);
    if (hours) parts.push(`${hours}س`);
    if (minutes) parts.push(`${minutes}د`);
    if (!parts.length) parts.push(`${seconds}ث`);
  } else {
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (!parts.length) parts.push(`${seconds}s`);
  }
  return parts.slice(0, 3).join(' ');
}

function leaderboardEntries(guildId, period, now = Date.now()) {
  const users = state.guilds[String(guildId)]?.users || {};
  return Object.entries(users)
    .map(([userId, record]) => ({ userId, record, score: periodScore(record, period, now) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || cleanMs(b.record.allMs) - cleanMs(a.record.allMs) || a.userId.localeCompare(b.userId));
}

function renderVoiceTop(guildId, viewerId, period, lang, now = Date.now()) {
  const entries = leaderboardEntries(guildId, period, now);
  const rows = entries.slice(0, 10);
  const viewerRank = entries.findIndex((row) => row.userId === String(viewerId));
  const ar = lang === 'ar';
  const lines = [];

  if (viewerRank >= 10) {
    const row = entries[viewerRank];
    lines.push(`${ar ? 'ترتيبك الصوتي' : 'Your voice rank'}: **#${viewerRank + 1}** • ${formatDuration(row.score, lang)}`);
    lines.push('');
  } else if (viewerRank < 0) {
    lines.push(`${ar ? 'ترتيبك الصوتي' : 'Your voice rank'}: **${ar ? 'غير مصنف بهالفترة' : 'Unranked in this period'}**`);
    lines.push('');
  }

  if (!rows.length) {
    lines.push(ar ? 'ما فيه وقت صوتي مسجل بهالفترة إلى الآن.' : 'No voice time has been recorded for this period yet.');
  } else {
    rows.forEach((row, index) => {
      lines.push(`${rankPrefix(index + 1)} <@${row.userId}> — **${formatDuration(row.score, lang)}**`);
    });
  }

  return new EmbedBuilder()
    .setColor(0x15233a)
    .setTitle(`🎙️ ${ar ? 'توب الصوتي' : 'Voice Top'} — ${periodLabel(period, lang)}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: ar ? 'الترتيب حسب مدة التواجد في الرومات الصوتية' : 'Ranked by time spent in voice channels' });
}

async function handleVoiceTop(message, originalContent) {
  await readyPromise;
  if (!targetGuildId || message.guildId !== targetGuildId) return;
  const now = Date.now();
  checkpointGuild(message.guildId, now);
  const lang = language(originalContent);
  const period = parsePeriod(originalContent);
  const embed = renderVoiceTop(message.guildId, message.author.id, period, lang, now);
  await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false, users: [] } });
}

async function initialize(client) {
  readyPromise = (async () => {
    const commandChannel = client.channels.cache.get(COMMAND_CHANNEL_ID)
      || await client.channels.fetch(COMMAND_CHANNEL_ID).catch(() => null);
    const guild = commandChannel?.guild;
    if (!guild) {
      console.warn(`[voice-top] Command channel ${COMMAND_CHANNEL_ID} not found.`);
      return;
    }

    targetGuildId = guild.id;
    dataChannel = guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
    if (!dataChannel) {
      await guild.channels.fetch().catch(() => null);
      dataChannel = guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
    }

    if (dataChannel) {
      const messages = await fetchAllMessages(dataChannel);
      const remoteByUser = new Map();
      for (const message of messages) {
        if (message.author?.id !== client.user.id) continue;
        const parsed = parseRecord(message.content);
        if (!parsed || parsed.guildId !== guild.id) continue;
        const rows = remoteByUser.get(parsed.userId) || [];
        rows.push({ record: parsed.record, messageId: message.id, createdTimestamp: Number(message.createdTimestamp) || 0 });
        remoteByUser.set(parsed.userId, rows);
      }

      const now = Date.now();
      for (const [userId, rows] of remoteByUser) {
        const local = getRecord(guild.id, userId);
        const merged = mergeRecords([local, ...rows.map((row) => row.record)], now);
        const canonical = rows.slice().sort((a, b) => {
          const aTime = recordTimestamp(a.record) || a.createdTimestamp;
          const bTime = recordTimestamp(b.record) || b.createdTimestamp;
          return bTime - aTime || b.createdTimestamp - a.createdTimestamp;
        })[0];
        guildState(guild.id).users[userId] = merged;
        if (canonical) recordMessageIds.set(sessionId(guild.id, userId), canonical.messageId);
      }
      await writeLocal().catch(() => {});
    } else {
      console.warn('[voice-top] neverless-data unavailable; using local fallback only.');
    }

    const now = Date.now();
    for (const voiceState of guild.voiceStates.cache.values()) {
      if (!voiceState.channelId || voiceState.member?.user?.bot) continue;
      activeSessions.set(sessionId(guild.id, voiceState.id), { startedAt: now });
    }

    console.log(`[voice-top] Voice leaderboard ready in ${guild.name}.`);
  })();
  return readyPromise;
}

function installVoiceTop(client) {
  if (client.__neverlessVoiceTopInstalled) return;
  client.__neverlessVoiceTopInstalled = true;

  client.once('ready', () => {
    initialize(client).catch((error) => console.error('[voice-top] Initialization failed:', error));
  });

  client.prependListener('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot || message.channelId !== COMMAND_CHANNEL_ID) return;
    const originalContent = String(message.content || '');
    if (!isVoiceTopCommand(originalContent)) return;
    try { message.content = HANDLED_SENTINEL; } catch {}
    handleVoiceTop(message, originalContent).catch((error) => console.error('[voice-top] Command failed:', error));
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    Promise.resolve(readyPromise).then(() => {
      const guild = newState.guild || oldState.guild;
      const member = newState.member || oldState.member;
      if (!guild || guild.id !== targetGuildId || member?.user?.bot) return;
      if (oldState.channelId === newState.channelId) return;

      const now = Date.now();
      const key = sessionId(guild.id, member.id);
      if (oldState.channelId) {
        const session = activeSessions.get(key);
        if (session) {
          const record = getRecord(guild.id, member.id);
          const added = accrueInterval(record, session.startedAt, now);
          if (added > 0) markDirty(guild.id, member.id);
        }
      }

      if (newState.channelId) activeSessions.set(key, { startedAt: now });
      else activeSessions.delete(key);
    }).catch((error) => console.error('[voice-top] Voice state failed:', error));
  });

  checkpointTimer = setInterval(() => {
    if (!targetGuildId) return;
    checkpointGuild(targetGuildId, Date.now());
    flushDirty().catch(() => {});
  }, CHECKPOINT_MS);
  checkpointTimer.unref?.();
}

const HOOK_KEY = Symbol.for('neverless.voice-top.login-hook');
if (!Client.prototype[HOOK_KEY]) {
  const originalLogin = Client.prototype.login;
  Object.defineProperty(Client.prototype, HOOK_KEY, { value: true });
  Client.prototype.login = function neverlessVoiceTopLogin(...args) {
    const mode = String(process.env.BOT_MODE || 'main').trim().toLowerCase();
    if (mode !== 'music') installVoiceTop(this);
    return originalLogin.apply(this, args);
  };
}

module.exports = {
  installVoiceTop,
  isVoiceTopCommand,
  parsePeriod,
  formatDuration,
  periodKeys,
};
