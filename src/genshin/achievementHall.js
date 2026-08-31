'use strict';

const { EmbedBuilder } = require('discord.js');
const { buildNeverlessLeaderboard, getCachedNeverlessLeaderboard } = require('./leaderboard');

const DATA_CHANNEL_NAME = 'neverless-data';
const RECORD_PREFIX = 'NLHOF1|';
const NEVERLESS_ROLE = 'Top Neverless';
const ANNOUNCEMENT_CHANNEL_ID = '1537605789521543251';
const MAX_SCAN_MESSAGES = 5000;

const states = new Map();
const loadPromises = new Map();
const queues = new Map();

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeTopBuilds(rows) {
  return [...(rows || [])]
    .filter((row) => row?.name && Number.isFinite(Number(row?.score)))
    .sort((a, b) => numberOr(b?.rankingScore ?? b?.evaluation?.rankingScore ?? b?.score) - numberOr(a?.rankingScore ?? a?.evaluation?.rankingScore ?? a?.score))
    .slice(0, 3)
    .map((row) => ({ name: String(row.name).slice(0, 80), score: numberOr(row.score) }));
}

function encodeTopBuilds(rows) {
  return Buffer.from(JSON.stringify(safeTopBuilds(rows)), 'utf8').toString('base64url');
}

function decodeTopBuilds(value) {
  try {
    return safeTopBuilds(JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8')));
  } catch {
    return [];
  }
}

function currentContent(guildId, current, updatedAt = new Date().toISOString()) {
  if (!current) return `${RECORD_PREFIX}current|${guildId}||||||${updatedAt}|`;
  return [
    `${RECORD_PREFIX}current`,
    guildId,
    current.userId,
    String(Math.max(0, Math.floor(numberOr(current.startedAt)))),
    String(numberOr(current.score)),
    String(numberOr(current.peakScore)),
    String(numberOr(current.averageBuild)),
    updatedAt,
    encodeTopBuilds(current.topBuilds),
  ].join('|');
}

function championContent(guildId, row, updatedAt = new Date().toISOString()) {
  return [
    `${RECORD_PREFIX}champ`,
    guildId,
    row.userId,
    String(Math.max(0, Math.floor(numberOr(row.firstAt)))),
    String(Math.max(0, Math.floor(numberOr(row.lastStartedAt)))),
    String(Math.max(0, Math.floor(numberOr(row.totalMs)))),
    String(numberOr(row.peakScore)),
    String(Math.max(1, Math.floor(numberOr(row.reigns, 1)))),
    updatedAt,
  ].join('|');
}

function parseHallRecord(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(RECORD_PREFIX)) return null;
  const parts = value.split('|');
  const type = parts[1];

  if (type === 'current') {
    const [, , guildId, userId, rawStartedAt, rawScore, rawPeak, rawAverage, updatedAt, encodedBuilds = ''] = parts;
    if (!/^\d{15,22}$/.test(guildId || '')) return null;
    if (userId && !/^\d{15,22}$/.test(userId)) return null;
    return {
      type,
      guildId,
      updatedAt: updatedAt || null,
      updatedMs: Date.parse(updatedAt || '') || 0,
      current: userId ? {
        userId,
        startedAt: numberOr(rawStartedAt),
        score: numberOr(rawScore),
        peakScore: numberOr(rawPeak),
        averageBuild: numberOr(rawAverage),
        topBuilds: decodeTopBuilds(encodedBuilds),
      } : null,
    };
  }

  if (type === 'champ') {
    const [, , guildId, userId, rawFirstAt, rawLastStartedAt, rawTotalMs, rawPeak, rawReigns, updatedAt] = parts;
    if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(userId || '')) return null;
    return {
      type,
      guildId,
      userId,
      updatedAt: updatedAt || null,
      updatedMs: Date.parse(updatedAt || '') || 0,
      champion: {
        userId,
        firstAt: numberOr(rawFirstAt),
        lastStartedAt: numberOr(rawLastStartedAt),
        totalMs: Math.max(0, numberOr(rawTotalMs)),
        peakScore: numberOr(rawPeak),
        reigns: Math.max(1, Math.floor(numberOr(rawReigns, 1))),
      },
    };
  }

  return null;
}

function dataChannel(guild) {
  return guild?.channels?.cache?.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
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

async function loadState(guild) {
  const state = {
    loaded: true,
    current: null,
    champions: new Map(),
    currentMessageId: null,
    championMessageIds: new Map(),
  };
  const channel = dataChannel(guild);
  if (!channel) {
    states.set(guild.id, state);
    return state;
  }

  const messages = await fetchAllMessages(channel);
  let latestCurrent = null;
  const latestChampions = new Map();
  for (const message of messages) {
    if (message.author?.id !== guild.members.me?.id) continue;
    const parsed = parseHallRecord(message.content);
    if (!parsed || parsed.guildId !== guild.id) continue;
    if (parsed.type === 'current') {
      const rank = parsed.updatedMs || Number(message.createdTimestamp) || 0;
      if (!latestCurrent || rank > latestCurrent.rank) latestCurrent = { parsed, rank, messageId: message.id };
      continue;
    }
    const rank = parsed.updatedMs || Number(message.createdTimestamp) || 0;
    const previous = latestChampions.get(parsed.userId);
    if (!previous || rank > previous.rank) latestChampions.set(parsed.userId, { parsed, rank, messageId: message.id });
  }

  if (latestCurrent) {
    state.current = latestCurrent.parsed.current;
    state.currentMessageId = latestCurrent.messageId;
  }
  for (const { parsed, messageId } of latestChampions.values()) {
    state.champions.set(parsed.userId, parsed.champion);
    state.championMessageIds.set(parsed.userId, messageId);
  }
  states.set(guild.id, state);
  return state;
}

function ensureState(guild) {
  if (states.has(guild.id)) return Promise.resolve(states.get(guild.id));
  if (loadPromises.has(guild.id)) return loadPromises.get(guild.id);
  const promise = loadState(guild).finally(() => loadPromises.delete(guild.id));
  loadPromises.set(guild.id, promise);
  return promise;
}

async function persistCurrent(guild, state) {
  const channel = dataChannel(guild);
  if (!channel) return false;
  const content = currentContent(guild.id, state.current);
  let message = state.currentMessageId ? await channel.messages.fetch(state.currentMessageId).catch(() => null) : null;
  if (message) await message.edit(content);
  else {
    message = await channel.send(content);
    state.currentMessageId = message.id;
  }
  return true;
}

async function persistChampion(guild, state, row) {
  const channel = dataChannel(guild);
  if (!channel || !row?.userId) return false;
  const content = championContent(guild.id, row);
  const knownId = state.championMessageIds.get(row.userId);
  let message = knownId ? await channel.messages.fetch(knownId).catch(() => null) : null;
  if (message) await message.edit(content);
  else {
    message = await channel.send(content);
    state.championMessageIds.set(row.userId, message.id);
  }
  return true;
}

function winnerSnapshot(winner) {
  if (!winner?.discordUserId) return null;
  const score = numberOr(winner.accountScore);
  if (!(score > 0)) return null;
  return {
    userId: String(winner.discordUserId),
    score,
    averageBuild: numberOr(winner.averageBuild),
    topBuilds: safeTopBuilds(winner.topBuilds?.length ? winner.topBuilds : winner.rated),
  };
}

function holdMsFor(row, state, now = Date.now()) {
  const base = Math.max(0, numberOr(row?.totalMs));
  if (state?.current?.userId !== row?.userId) return base;
  return base + Math.max(0, now - numberOr(state.current.startedAt, now));
}

function formatHoldDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(numberOr(ms) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function roleStyle(guild) {
  const role = guild.roles.cache.find((item) => item.name === NEVERLESS_ROLE) || null;
  const color = role?.color || 0xc9a227;
  const icon = role?.iconURL?.({ size: 256 }) || null;
  return { role, color, icon };
}

async function announceTransfer(guild, previous, current) {
  if (!current?.userId || !previous?.userId || previous.userId === current.userId) return;
  const channel = guild.channels.cache.get(ANNOUNCEMENT_CHANNEL_ID)
    || await guild.channels.fetch(ANNOUNCEMENT_CHANNEL_ID).catch(() => null);
  if (!channel?.isSendable?.()) return;
  const style = roleStyle(guild);
  const builds = safeTopBuilds(current.topBuilds);
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle('🏆 Top Neverless — تحديث الترتيب')
    .setDescription(`<@${current.userId}> أصبح الآن صاحب رتبة **Top Neverless** بعد تحديث ترتيب الحسابات.`)
    .addFields(
      { name: 'Neverless', value: `**${current.score}%**`, inline: true },
      { name: 'الحامل السابق', value: `<@${previous.userId}>`, inline: true },
    )
    .setTimestamp();
  if (builds.length) embed.addFields({
    name: 'أقوى البيلدات',
    value: builds.map((row) => `**${row.name}** ${row.score}%`).join(' • '),
  });
  if (style.icon) embed.setThumbnail(style.icon);
  await channel.send({ embeds: [embed], allowedMentions: { users: [current.userId] } }).catch(() => {});
}

async function recordUnlocked(guild, winner, options = {}) {
  const state = await ensureState(guild);
  const next = winnerSnapshot(winner);
  const now = Date.now();

  if (!state.current) {
    if (!next) return { changed: false, seeded: false, current: null };
    let champion = state.champions.get(next.userId);
    if (!champion) {
      champion = { userId: next.userId, firstAt: now, lastStartedAt: now, totalMs: 0, peakScore: next.score, reigns: 1 };
    } else {
      champion.lastStartedAt = now;
      champion.peakScore = Math.max(numberOr(champion.peakScore), next.score);
      champion.reigns = Math.max(1, numberOr(champion.reigns)) + 1;
    }
    state.champions.set(next.userId, champion);
    state.current = { ...next, startedAt: now, peakScore: Math.max(next.score, numberOr(champion.peakScore)) };
    await persistChampion(guild, state, champion).catch(() => false);
    await persistCurrent(guild, state).catch(() => false);
    return { changed: false, seeded: true, current: state.current };
  }

  if (!next) {
    const previous = { ...state.current };
    const champion = state.champions.get(previous.userId);
    if (champion) {
      champion.totalMs = Math.max(0, numberOr(champion.totalMs)) + Math.max(0, now - numberOr(previous.startedAt, now));
      state.champions.set(champion.userId, champion);
      await persistChampion(guild, state, champion).catch(() => false);
    }
    state.current = null;
    await persistCurrent(guild, state).catch(() => false);
    return { changed: true, previous, current: null };
  }

  if (state.current.userId === next.userId) {
    const champion = state.champions.get(next.userId) || {
      userId: next.userId,
      firstAt: numberOr(state.current.startedAt, now),
      lastStartedAt: numberOr(state.current.startedAt, now),
      totalMs: 0,
      peakScore: 0,
      reigns: 1,
    };
    champion.peakScore = Math.max(numberOr(champion.peakScore), next.score, numberOr(state.current.peakScore));
    state.champions.set(next.userId, champion);
    state.current = {
      ...state.current,
      ...next,
      peakScore: Math.max(numberOr(state.current.peakScore), next.score, numberOr(champion.peakScore)),
    };
    await persistChampion(guild, state, champion).catch(() => false);
    await persistCurrent(guild, state).catch(() => false);
    return { changed: false, current: state.current };
  }

  const previous = { ...state.current };
  const previousChampion = state.champions.get(previous.userId);
  if (previousChampion) {
    previousChampion.totalMs = Math.max(0, numberOr(previousChampion.totalMs)) + Math.max(0, now - numberOr(previous.startedAt, now));
    state.champions.set(previousChampion.userId, previousChampion);
    await persistChampion(guild, state, previousChampion).catch(() => false);
  }

  let champion = state.champions.get(next.userId);
  if (!champion) {
    champion = { userId: next.userId, firstAt: now, lastStartedAt: now, totalMs: 0, peakScore: next.score, reigns: 1 };
  } else {
    champion.lastStartedAt = now;
    champion.reigns = Math.max(1, Math.floor(numberOr(champion.reigns))) + 1;
    champion.peakScore = Math.max(numberOr(champion.peakScore), next.score);
  }
  state.champions.set(next.userId, champion);
  state.current = { ...next, startedAt: now, peakScore: Math.max(next.score, numberOr(champion.peakScore)) };
  await persistChampion(guild, state, champion).catch(() => false);
  await persistCurrent(guild, state).catch(() => false);
  if (options.announce !== false) await announceTransfer(guild, previous, state.current);
  return { changed: true, previous, current: state.current };
}

function recordTopNeverless(guild, winner, options = {}) {
  if (!guild?.id) return Promise.resolve({ changed: false, current: null });
  const previous = queues.get(guild.id) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => recordUnlocked(guild, winner, options));
  const queued = task.finally(() => {
    if (queues.get(guild.id) === queued) queues.delete(guild.id);
  });
  queues.set(guild.id, queued);
  return task;
}

async function ensureCurrentChampion(guild) {
  const state = await ensureState(guild);
  if (state.current) return state;
  const board = getCachedNeverlessLeaderboard(guild) || await buildNeverlessLeaderboard(guild).catch(() => null);
  const winner = board?.rows?.[0] || null;
  if (winner) await recordTopNeverless(guild, winner, { announce: false });
  return ensureState(guild);
}

function hallEmbed(guild, state, lang = 'ar') {
  const ar = lang === 'ar';
  const style = roleStyle(guild);
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(ar ? '🏛️ Neverless — قاعة الأبطال' : '🏛️ Neverless — Hall of Fame')
    .setDescription(ar
      ? 'سجل أصحاب رتبة **Top Neverless** منذ تفعيل قاعة الأبطال.'
      : 'A record of the members who have held **Top Neverless** since the Hall of Fame was enabled.')
    .setTimestamp();
  if (style.icon) embed.setThumbnail(style.icon);

  if (state.current) {
    const builds = safeTopBuilds(state.current.topBuilds);
    const currentText = [
      `<@${state.current.userId}> — **${state.current.score}% Neverless**`,
      `${ar ? 'منذ' : 'Since'} <t:${Math.floor(numberOr(state.current.startedAt) / 1000)}:R>`,
    ];
    if (builds.length) currentText.push(builds.map((row) => `${row.name} ${row.score}%`).join(' • '));
    embed.addFields({ name: ar ? '👑 الحامل الحالي' : '👑 Current Holder', value: currentText.join('\n') });
  }

  const rows = [...state.champions.values()]
    .sort((a, b) => numberOr(b.lastStartedAt) - numberOr(a.lastStartedAt))
    .slice(0, 10);
  if (rows.length) {
    const history = rows.map((row, index) => {
      const held = formatHoldDuration(holdMsFor(row, state));
      const reignWord = ar ? (row.reigns === 1 ? 'فترة' : 'فترات') : (row.reigns === 1 ? 'reign' : 'reigns');
      return `${index + 1}. <@${row.userId}> — Peak **${row.peakScore}%** • ${row.reigns} ${reignWord} • ${held}`;
    });
    embed.addFields({ name: ar ? '🏅 السجل' : '🏅 History', value: history.join('\n') });
  } else {
    embed.addFields({ name: ar ? '🏅 السجل' : '🏅 History', value: ar ? 'لا يوجد سجل بعد.' : 'No history yet.' });
  }
  embed.setFooter({ text: ar ? 'نفس ترتيب Neverless الرسمي يحدد صاحب اللقب' : 'The official Neverless ranking determines the holder' });
  return embed;
}

function isHallCommand(text) {
  return /^(?:hall\s+of\s+fame|قاعة\s+(?:الأبطال|الابطال)|قاعه\s+(?:الأبطال|الابطال))$/iu.test(String(text || '').trim());
}

function commandLanguage(text) {
  return /[\u0600-\u06ff]/u.test(String(text || '')) ? 'ar' : 'en';
}

async function handleHallOfFameMessage(message) {
  if (!isHallCommand(message?.content)) return false;
  const state = await ensureCurrentChampion(message.guild);
  await message.channel.send({
    embeds: [hallEmbed(message.guild, state, commandLanguage(message.content))],
    allowedMentions: { parse: [] },
  });
  return true;
}

async function handleNeverlessFlex(message, lang = 'ar') {
  const state = await ensureCurrentChampion(message.guild);
  const ar = lang === 'ar';
  const current = state.current;
  const style = roleStyle(message.guild);
  if (!current) {
    await message.reply({
      content: ar ? 'ما فيه صاحب **Top Neverless** مسجل حاليًا.' : 'There is no recorded **Top Neverless** holder right now.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const member = message.guild.members.cache.get(current.userId)
    || await message.guild.members.fetch(current.userId).catch(() => null);
  const champion = state.champions.get(current.userId);
  const builds = safeTopBuilds(current.topBuilds);
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle('🏆 Top Neverless')
    .setDescription(`<@${current.userId}>\n**${current.score}% Neverless**`)
    .addFields({
      name: ar ? 'السجل الحالي' : 'Current Record',
      value: `${ar ? 'Peak' : 'Peak'} **${Math.max(numberOr(current.peakScore), numberOr(champion?.peakScore))}%** • ${ar ? 'منذ' : 'since'} <t:${Math.floor(numberOr(current.startedAt) / 1000)}:R>`,
    })
    .setFooter({ text: ar ? 'Top Neverless • المركز الأول في ترتيب الحسابات' : 'Top Neverless • #1 in the account ranking' })
    .setTimestamp();
  if (builds.length) embed.addFields({
    name: ar ? 'أقوى 3 بيلدات' : 'Top 3 Builds',
    value: builds.map((row, index) => `${index + 1}. **${row.name}** — ${row.score}%`).join('\n'),
  });
  const avatar = member?.displayAvatarURL?.({ size: 256 }) || null;
  if (style.icon) embed.setThumbnail(style.icon);
  else if (avatar) embed.setThumbnail(avatar);
  if (member) embed.setAuthor({ name: member.displayName || member.user?.username || 'Top Neverless', iconURL: avatar || undefined });

  await message.reply({ embeds: [embed], allowedMentions: { users: [current.userId], repliedUser: false } });
  return true;
}

module.exports = {
  recordTopNeverless,
  handleHallOfFameMessage,
  handleNeverlessFlex,
  isHallCommand,
  parseHallRecord,
  currentContent,
  championContent,
  formatHoldDuration,
  safeTopBuilds,
};
