'use strict';

const { searchMessages, normalize } = require('./messageIndex');

const GENSHIN_CHANNEL_IDS = ['1538091335079297034', '1539226931319545936'];
const BUILD_INTENT = /(?:بيلد|build|تقييم|قيم|احصائ|إحصائ|ستات|stats|كريت|crit|سلاح|weapon|ارتي|artifact|شخصيتي|شخصية)/iu;

function ratingCharacter(text) {
  const value = String(text || '').replace(/<@!?\d{15,22}>/g, ' ').replace(/\s+/g, ' ').trim();
  const match = value.match(/(?:تقييم|قيم)\s+(.{1,80}?)\s+بحسابي(?:\s|$)/iu);
  return match ? match[1].trim() : null;
}

function looksLikeBuildQuestion(text, turns = []) {
  if (BUILD_INTENT.test(String(text || ''))) return true;
  const recent = (turns || []).slice(-4).map((turn) => String(turn?.content || '')).join(' ');
  return /(?:وش\s+اغير|وش\s+أغير|شرايك|رايك|رأيك|اطورها|أطورها|ضعيف|قوي)/iu.test(String(text || '')) && BUILD_INTENT.test(recent);
}

function serializeMessage(message) {
  const chunks = [];
  if (message?.content?.trim()) chunks.push(message.content.trim());
  for (const embed of message?.embeds || []) {
    if (embed.title) chunks.push(embed.title);
    if (embed.description) chunks.push(embed.description);
    for (const field of embed.fields || []) chunks.push(`${field.name}: ${field.value}`);
    if (embed.footer?.text) chunks.push(embed.footer.text);
  }
  return chunks.join('\n').trim().slice(0, 7000);
}

function jumpUrl(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function chooseCandidate(candidates, userText) {
  const sorted = candidates.sort((a, b) => b.timestamp - a.timestamp);
  const wanted = normalize(userText || '');
  const explicit = sorted.find((row) => {
    const character = normalize(row.character || '');
    return character && wanted.includes(character);
  });
  return explicit || sorted[0] || null;
}

async function indexedCandidates(guild, requester, userId) {
  const rows = searchMessages(guild, requester, {
    query: 'تقييم بحسابي',
    authorId: userId,
    limit: 20,
  });
  return rows.map((row) => {
    const character = ratingCharacter(row.content);
    return character ? {
      character,
      channelId: row.channel_id,
      messageId: row.message_id,
      timestamp: Date.parse(row.timestamp) || 0,
      commandText: row.content,
    } : null;
  }).filter(Boolean);
}

async function liveCandidates(guild, requester, userId, maxPerChannel = 300) {
  const out = [];
  for (const channelId of GENSHIN_CHANNEL_IDS) {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.messages?.fetch) continue;
    const permissions = channel.permissionsFor?.(requester);
    if (!permissions?.has('ViewChannel') || !permissions?.has('ReadMessageHistory')) continue;
    let before;
    let scanned = 0;
    while (scanned < maxPerChannel) {
      const batch = await channel.messages.fetch({ limit: Math.min(100, maxPerChannel - scanned), before }).catch(() => null);
      if (!batch?.size) break;
      for (const message of batch.values()) {
        if (message.author?.id !== userId) continue;
        const character = ratingCharacter(message.content);
        if (!character) continue;
        out.push({
          character,
          channelId,
          messageId: message.id,
          timestamp: message.createdTimestamp || 0,
          commandText: message.content,
        });
      }
      scanned += batch.size;
      before = batch.last()?.id;
      if (batch.size < 100) break;
      if (out.length >= 8) break;
    }
  }
  return out;
}

async function findBotReplies(guild, requester, candidate) {
  const channel = guild.channels.cache.get(candidate.channelId) || await guild.channels.fetch(candidate.channelId).catch(() => null);
  if (!channel?.messages?.fetch) return [];
  const permissions = channel.permissionsFor?.(requester);
  if (!permissions?.has('ViewChannel') || !permissions?.has('ReadMessageHistory')) return [];
  const around = await channel.messages.fetch({ around: candidate.messageId, limit: 100 }).catch(() => null);
  if (!around?.size) return [];
  const botId = guild.members.me?.id;
  return [...around.values()]
    .filter((message) => message.author?.id === botId && message.reference?.messageId === candidate.messageId)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(0, 5);
}

async function getRelevantRatingContext(guild, requester, userText, turns = []) {
  if (!guild || !requester || !looksLikeBuildQuestion(userText, turns)) return null;
  let candidates = await indexedCandidates(guild, requester, requester.id);
  const live = await liveCandidates(guild, requester, requester.id).catch(() => []);
  const seen = new Set(candidates.map((row) => row.messageId));
  for (const row of live) if (!seen.has(row.messageId)) candidates.push(row);
  const chosen = chooseCandidate(candidates, `${userText} ${(turns || []).slice(-4).map((turn) => turn?.content || '').join(' ')}`);
  if (!chosen) return null;
  const replies = await findBotReplies(guild, requester, chosen);
  const response = replies.map(serializeMessage).filter(Boolean).join('\n\n').slice(0, 9000);
  return {
    character: chosen.character,
    command: chosen.commandText,
    timestamp: new Date(chosen.timestamp).toISOString(),
    jump_url: jumpUrl(guild.id, chosen.channelId, chosen.messageId),
    bot_response: response || null,
  };
}

function formatRatingContext(context) {
  if (!context) return '';
  return [
    'Verified latest relevant Neverless Genshin rating exchange from Discord:',
    `Character: ${context.character}`,
    `User command: ${context.command}`,
    `Timestamp: ${context.timestamp}`,
    `Original message: ${context.jump_url}`,
    context.bot_response ? `Neverless rating reply:\n${context.bot_response}` : 'The original rating command was found, but its bot reply was not recoverable from the nearby Discord history.',
  ].join('\n');
}

module.exports = {
  ratingCharacter,
  looksLikeBuildQuestion,
  getRelevantRatingContext,
  formatRatingContext,
};
