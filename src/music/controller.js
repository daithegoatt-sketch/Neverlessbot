'use strict';

const { PermissionFlagsBits } = require('discord.js');
const {
  DATA_CHANNEL_NAME,
  HEARTBEAT_STALE_MS,
  record,
  parseRecord,
  parseMusicCommand,
  isAllowedCommandChannel,
  helpText,
  workerNumberFromName,
} = require('./protocol');

const statuses = new Map();
const statusRecordIds = new Map();
const pins = new Map();
const pinRecordIds = new Map();
let installed = false;
let dataChannel = null;
let lastStatusRefreshAt = 0;

function now() { return Date.now(); }
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function isAdmin(member) { return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)); }

async function findDataChannel(guild) {
  if (dataChannel?.guildId === guild.id) return dataChannel;
  dataChannel = guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
  if (!dataChannel) {
    await guild.channels.fetch().catch(() => null);
    dataChannel = guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
  }
  return dataChannel;
}

async function grantWorkersDataAccess(guild) {
  const channel = await findDataChannel(guild);
  if (!channel?.permissionOverwrites?.edit) return;
  await guild.members.fetch().catch(() => null);
  for (const member of guild.members.cache.values()) {
    if (!member.user?.bot) continue;
    if (!/neverless\s*music/i.test(member.user.username) && !/neverless\s*music/i.test(member.displayName)) continue;
    await channel.permissionOverwrites.edit(member.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }, { reason: 'Neverless music worker control bus' }).catch(() => {});
  }
}

function rememberStatusMessage(message, parsed) {
  if (!parsed || parsed.type !== 'STATUS') return false;
  const heartbeatAt = Number(parsed.payload.heartbeat_at) || message.editedTimestamp || message.createdTimestamp || 0;
  const previous = statuses.get(parsed.id);
  if (!previous || heartbeatAt >= Number(previous.heartbeat_at || 0)) {
    statuses.set(String(parsed.id), { ...parsed.payload, heartbeat_at: heartbeatAt });
  }
  if (message?.id) statusRecordIds.set(String(parsed.id), message.id);
  return true;
}

async function loadState(guild) {
  const channel = await findDataChannel(guild);
  if (!channel) return;
  let before;
  let scanned = 0;
  const latestPins = new Map();
  while (scanned < 1000) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    scanned += batch.size;
    for (const message of batch.values()) {
      const parsed = parseRecord(message.content);
      if (!parsed) continue;
      if (parsed.type === 'STATUS') rememberStatusMessage(message, parsed);
      if (parsed.type === 'PIN') {
        const previous = latestPins.get(parsed.id);
        if (!previous || message.createdTimestamp > previous.createdTimestamp) {
          latestPins.set(String(parsed.id), { ...parsed.payload, messageId: message.id, createdTimestamp: message.createdTimestamp });
        }
      }
    }
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  pins.clear();
  for (const [workerId, pin] of latestPins) {
    if (pin.voice_id) pins.set(String(pin.voice_id), String(workerId));
    pinRecordIds.set(String(workerId), pin.messageId);
  }
  lastStatusRefreshAt = now();
}

function applyControlRecord(message) {
  const parsed = parseRecord(message.content);
  if (!parsed) return false;
  if (parsed.type === 'STATUS') return rememberStatusMessage(message, parsed);
  return false;
}

async function refreshWorkerStatuses(guild, force = false) {
  if (!force && now() - lastStatusRefreshAt < 5_000) return;
  const channel = await findDataChannel(guild);
  if (!channel) return;
  let refreshed = 0;
  for (const workerId of ['1', '2', '3']) {
    const messageId = statusRecordIds.get(workerId);
    if (!messageId) continue;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      statusRecordIds.delete(workerId);
      continue;
    }
    const parsed = parseRecord(message.content);
    if (parsed?.type === 'STATUS' && String(parsed.id) === workerId) {
      rememberStatusMessage(message, parsed);
      refreshed += 1;
    }
  }
  if (refreshed < 3) {
    const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (batch) {
      for (const message of batch.values()) {
        const parsed = parseRecord(message.content);
        if (parsed?.type === 'STATUS') rememberStatusMessage(message, parsed);
      }
    }
  }
  lastStatusRefreshAt = now();
}

function healthyWorkers() {
  const cutoff = now() - HEARTBEAT_STALE_MS;
  return [...statuses.entries()]
    .filter(([, status]) => Number(status.heartbeat_at) >= cutoff)
    .map(([id, status]) => ({ id, ...status }));
}

function workerForVoice(voiceId) {
  const healthy = healthyWorkers();
  const pinned = pins.get(String(voiceId));
  if (pinned) {
    const row = healthy.find((worker) => worker.id === pinned);
    if (row) return row;
  }
  return healthy.find((worker) => String(worker.voice_id || '') === String(voiceId)) || null;
}

function freeWorkerForVoice(voiceId) {
  const healthy = healthyWorkers();
  const pinned = pins.get(String(voiceId));
  if (pinned) {
    const row = healthy.find((worker) => worker.id === pinned);
    if (row) return row;
  }
  return healthy.find((worker) => String(worker.voice_id || '') === String(voiceId))
    || healthy.find((worker) => !worker.voice_id && !worker.pinned_voice_id)
    || null;
}

async function sendRequest(guild, workerId, payload) {
  const channel = await findDataChannel(guild);
  if (!channel) throw new Error('MUSIC_DATA_CHANNEL_MISSING');
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = record('REQ', String(workerId), {
    ...payload,
    request_id: requestId,
    expires_at: Date.now() + 30_000,
  });
  if (content.length > 1950) throw new Error('MUSIC_REQUEST_TOO_LONG');
  await channel.send({ content, allowedMentions: { parse: [] } });
  return requestId;
}

async function persistPin(guild, workerId, voiceId) {
  const channel = await findDataChannel(guild);
  if (!channel) return;
  const content = record('PIN', String(workerId), {
    voice_id: voiceId ? String(voiceId) : null,
    updated_at: Date.now(),
  });
  const known = pinRecordIds.get(String(workerId));
  let message = known ? await channel.messages.fetch(known).catch(() => null) : null;
  if (message) await message.edit({ content }).catch(() => {});
  else {
    message = await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
    if (message) pinRecordIds.set(String(workerId), message.id);
  }
  for (const [key, value] of pins) if (value === String(workerId)) pins.delete(key);
  if (voiceId) pins.set(String(voiceId), String(workerId));
}

function messageVoiceId(message) { return message.member?.voice?.channelId || null; }
async function reply(message, text) {
  return message.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } }).catch(() => null);
}

function mentionedWorker(message) {
  for (const user of message.mentions?.users?.values?.() || []) {
    const status = [...statuses.entries()].find(([, row]) => row.bot_id === user.id);
    if (status) return { id: status[0], botId: user.id };
    const member = message.guild?.members?.cache?.get(user.id);
    const id = workerNumberFromName(member?.displayName || user.username);
    if (id) return { id, botId: user.id };
  }
  return null;
}

async function handlePinCommand(message) {
  if (!isAdmin(message.member)) return false;
  const content = clean(message.content).replace(/<@!?\d+>/g, ' ').trim();
  const isPin = /^تثبيت$/u.test(content);
  const isUnpin = /^(?:إلغاء|الغاء)\s+تثبيت$/u.test(content) || /^فك\s+تثبيت$/u.test(content);
  if (!isPin && !isUnpin) return false;
  const target = mentionedWorker(message);
  if (!target) return false;

  await refreshWorkerStatuses(message.guild, true).catch(() => {});

  if (isUnpin) {
    await persistPin(message.guild, target.id, null);
    await sendRequest(message.guild, target.id, {
      action: 'unpin',
      guild_id: message.guildId,
      channel_id: message.channelId,
      user_id: message.author.id,
      message_id: message.id,
    }).catch(() => {});
    await reply(message, `تم إلغاء تثبيت <@${target.botId}> وخروجه من الروم.`);
    return true;
  }

  const voiceId = message.member?.voice?.channelId;
  if (!voiceId) {
    await reply(message, 'ادخل الروم الصوتي اللي تبي تثبت فيه البوت أول.');
    return true;
  }
  const status = statuses.get(String(target.id));
  if (status?.voice_id && String(status.voice_id) !== String(voiceId) && status.playing) {
    await reply(message, 'هذا Music Bot مشغول حاليًا في روم صوتي ثاني.');
    return true;
  }
  await persistPin(message.guild, target.id, voiceId);
  await sendRequest(message.guild, target.id, {
    action: 'pin',
    guild_id: message.guildId,
    voice_id: voiceId,
    channel_id: message.channelId,
    user_id: message.author.id,
    message_id: message.id,
  }).catch(() => {});
  await reply(message, `تم تثبيت <@${target.botId}> في <#${voiceId}>.`);
  return true;
}

async function handleMusicCommand(message) {
  if (!isAllowedCommandChannel(message)) return false;
  const command = parseMusicCommand(message.content);
  if (!command) return false;
  if (command.action === 'help') {
    await reply(message, helpText());
    return true;
  }
  if (command.action === 'volume_invalid') {
    await reply(message, 'الصوت لازم يكون من 0% إلى 200%. مثال: `ص 50`.');
    return true;
  }
  const voiceId = messageVoiceId(message);
  if (!voiceId) {
    await reply(message, 'ادخل روم صوتي أول عشان أقدر أحدد Music Bot لك.');
    return true;
  }
  await refreshWorkerStatuses(message.guild, true).catch(() => {});
  const worker = command.action === 'play' ? freeWorkerForVoice(voiceId) : workerForVoice(voiceId);
  if (!worker) {
    const online = healthyWorkers().length;
    await reply(message, online ? 'كل Music Bots مستخدمين حاليًا في رومات ثانية.' : 'Music Bots مو متصلين حاليًا.');
    return true;
  }
  await sendRequest(message.guild, worker.id, {
    action: command.action,
    query: command.query || null,
    value: command.value ?? null,
    guild_id: message.guildId,
    voice_id: voiceId,
    channel_id: message.channelId,
    user_id: message.author.id,
    message_id: message.id,
  }).catch(async (error) => {
    console.warn('[music] Request failed:', error.message);
    await reply(message, 'ما قدرت أوصل لـMusic Bot حاليًا.');
  });
  return true;
}

async function handleWorkerEvent(client, message) {
  const parsed = parseRecord(message.content);
  if (!parsed || parsed.type !== 'EVENT') return false;
  const payload = parsed.payload || {};
  const channel = await client.channels.fetch(payload.channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) {
    await message.delete().catch(() => {});
    return true;
  }
  const original = payload.message_id ? await channel.messages.fetch(payload.message_id).catch(() => null) : null;
  const send = async (text) => {
    if (!text) return;
    if (original) await original.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    else await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  };
  if (payload.code === 'playing') await send(`تشغيل **${payload.title || 'الأغنية'}**`);
  else if (payload.code === 'queued') await send(`تم إضافة **${payload.title || 'الأغنية'}** إلى الانتظار.`);
  else if (payload.code === 'skipped') await send(payload.next_title ? `تم التخطي. تشغيل **${payload.next_title}**` : 'تم تخطي الأغنية.');
  else if (payload.code === 'stopped') await send('تم إيقاف التشغيل ومسح الانتظار.');
  else if (payload.code === 'volume') await send(`تم ضبط الصوت على **${payload.value}%**.`);
  else if (payload.code === 'not_playing') await send('ما فيه أغنية شغالة حاليًا.');
  else if (payload.code === 'not_found') await send('ما لقيت نتيجة مناسبة للأغنية.');
  else if (payload.code === 'error') {
    console.warn(`[music] Worker ${payload.worker_id || '?'} playback error: ${payload.reason || 'unknown'}`);
    await send('صار خطأ أثناء تشغيل الأغنية. جرّب اسم ثاني أو رابط مباشر.');
  }
  await message.delete().catch(() => {});
  return true;
}

function installMusicController(client) {
  if (installed) return;
  installed = true;
  client.once('ready', async () => {
    for (const guild of client.guilds.cache.values()) {
      await grantWorkersDataAccess(guild).catch(() => {});
      await loadState(guild).catch((error) => console.warn('[music] State load failed:', error.message));
    }
    console.log('[music] Controller ready.');
  });
  client.on('guildCreate', (guild) => {
    grantWorkersDataAccess(guild).then(() => loadState(guild)).catch(() => {});
  });
  client.on('messageCreate', (message) => {
    if (!message?.guildId) return;
    if (message.channel?.name === DATA_CHANNEL_NAME) {
      if (message.author?.id === client.user?.id) return;
      if (applyControlRecord(message)) return;
      handleWorkerEvent(client, message).catch((error) => console.warn('[music] Worker event failed:', error.message));
      return;
    }
    if (message.author?.bot) return;
    Promise.resolve(handlePinCommand(message))
      .then((handled) => handled ? true : handleMusicCommand(message))
      .catch((error) => console.warn('[music] Command failed:', error.message));
  });
  client.on('messageUpdate', (_oldMessage, newMessage) => {
    if (newMessage?.channel?.name === DATA_CHANNEL_NAME) applyControlRecord(newMessage);
  });
  const refreshTimer = setInterval(() => {
    for (const guild of client.guilds.cache.values()) refreshWorkerStatuses(guild, true).catch(() => {});
  }, 20_000);
  refreshTimer.unref?.();
}

module.exports = { installMusicController };
