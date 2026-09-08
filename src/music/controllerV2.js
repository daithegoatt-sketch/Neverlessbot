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
} = require('./protocol');

const WORKER_IDS = ['1', '2', '3'];
const RESERVATION_MS = 45_000;
const PROMPT_MS = 45_000;
const statuses = new Map();
const statusMessageIds = new Map();
const reservations = new Map();
const pending = new Map();
let installed = false;
let cachedDataChannel = null;

function now() { return Date.now(); }
function clean(value, max = 180) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function isAdmin(member) { return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)); }
function pendingKey(message) { return `${message.guildId}:${message.author.id}:${message.channelId}`; }

async function findDataChannel(guild) {
  if (cachedDataChannel?.guildId === guild.id) return cachedDataChannel;
  cachedDataChannel = guild.channels.cache.find((c) => c.name === DATA_CHANNEL_NAME && c.isTextBased?.()) || null;
  if (!cachedDataChannel) {
    await guild.channels.fetch().catch(() => null);
    cachedDataChannel = guild.channels.cache.find((c) => c.name === DATA_CHANNEL_NAME && c.isTextBased?.()) || null;
  }
  return cachedDataChannel;
}

async function grantWorkerAccess(guild) {
  const channel = await findDataChannel(guild);
  if (!channel?.permissionOverwrites?.edit) return;
  await guild.members.fetch().catch(() => null);
  for (const member of guild.members.cache.values()) {
    if (!member.user?.bot) continue;
    const name = `${member.user.username || ''} ${member.displayName || ''}`;
    if (!/neverless\s*music/i.test(name)) continue;
    await channel.permissionOverwrites.edit(member.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }, { reason: 'Neverless isolated music worker bus' }).catch(() => {});
  }
}

function rememberStatus(message, parsed = parseRecord(message?.content)) {
  if (parsed?.type !== 'STATUS' || !WORKER_IDS.includes(String(parsed.id))) return false;
  const id = String(parsed.id);
  const heartbeat = Number(parsed.payload?.heartbeat_at) || message?.editedTimestamp || message?.createdTimestamp || 0;
  const previous = statuses.get(id);
  if (!previous || heartbeat >= Number(previous.heartbeat_at || 0)) {
    statuses.set(id, { ...(parsed.payload || {}), heartbeat_at: heartbeat });
  }
  if (message?.id) statusMessageIds.set(id, message.id);
  const reservation = reservations.get(id);
  if (reservation && parsed.payload?.voice_id && String(parsed.payload.voice_id) === String(reservation.voiceId)) {
    reservations.delete(id);
  }
  return true;
}

function reconcileDiscordVoice(guild) {
  for (const [id, status] of statuses) {
    if (!status?.bot_id) continue;
    const member = guild.members.cache.get(String(status.bot_id));
    if (!member) continue;
    const actual = member.voice?.channelId || null;
    if (String(actual || '') !== String(status.voice_id || '')) {
      statuses.set(id, {
        ...status,
        voice_id: actual,
        playing: actual ? Boolean(status.playing) : false,
        current_title: actual ? status.current_title : null,
        queue_length: actual ? Number(status.queue_length || 0) : 0,
      });
    }
  }
}

async function refreshStatuses(guild) {
  const channel = await findDataChannel(guild);
  if (!channel) return;
  const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (batch) {
    for (const message of batch.values()) rememberStatus(message);
  }
  reconcileDiscordVoice(guild);
}

function fresh(status) {
  return Number(status?.heartbeat_at || 0) >= now() - HEARTBEAT_STALE_MS && status?.backend_ready !== false;
}

function healthyWorkers() {
  return WORKER_IDS.map((id) => ({ id, ...(statuses.get(id) || {}) })).filter((row) => fresh(row));
}

function activeReservation(id) {
  const row = reservations.get(String(id));
  if (!row) return null;
  if (row.expiresAt <= now()) {
    reservations.delete(String(id));
    return null;
  }
  return row;
}

function workerForVoice(voiceId) {
  const wanted = String(voiceId || '');
  for (const worker of healthyWorkers()) {
    if (String(worker.voice_id || '') === wanted) return worker;
    const reserved = activeReservation(worker.id);
    if (reserved && String(reserved.voiceId) === wanted) return worker;
  }
  return null;
}

function freeWorkerForVoice(voiceId) {
  const existing = workerForVoice(voiceId);
  if (existing) return existing;
  return healthyWorkers().find((worker) => !worker.voice_id && !activeReservation(worker.id)) || null;
}

function reserve(workerId, voiceId) {
  reservations.set(String(workerId), { voiceId: String(voiceId), expiresAt: now() + RESERVATION_MS });
}

function release(workerId) {
  reservations.delete(String(workerId));
}

async function reply(message, content) {
  return message.reply({ content, allowedMentions: { repliedUser: false, parse: [] } }).catch(() => null);
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

function immediateText(command) {
  if (command.action === 'play') return `جاري تشغيل **${clean(command.query, 160)}**...`;
  if (command.action === 'skip') return 'جاري التخطي...';
  if (command.action === 'stop') return 'جاري إيقاف التشغيل...';
  if (command.action === 'volume') return `جاري ضبط الصوت على **${command.value}%**...`;
  return null;
}

async function ensureWorkerSelection(message, voiceId, forPlay = true) {
  reconcileDiscordVoice(message.guild);
  let worker = forPlay ? freeWorkerForVoice(voiceId) : workerForVoice(voiceId);
  if (!worker) {
    await refreshStatuses(message.guild).catch(() => {});
    worker = forPlay ? freeWorkerForVoice(voiceId) : workerForVoice(voiceId);
  }
  return worker;
}

async function dispatch(message, worker, action, extra = {}, ackText = null) {
  const voiceId = message.member?.voice?.channelId || extra.voice_id || null;
  if (voiceId && ['join', 'play'].includes(action)) reserve(worker.id, voiceId);
  const ack = ackText ? await reply(message, ackText) : null;
  try {
    await sendRequest(message.guild, worker.id, {
      action,
      guild_id: message.guildId,
      voice_id: voiceId,
      channel_id: message.channelId,
      user_id: message.author.id,
      message_id: message.id,
      response_message_id: ack?.id || null,
      ...extra,
    });
  } catch (error) {
    if (['join', 'play'].includes(action)) release(worker.id);
    console.warn('[music-v2] dispatch failed:', error.message);
    if (ack) await ack.edit({ content: 'ما قدرت أوصل لـMusic Bot حاليًا.' }).catch(() => {});
    else await reply(message, 'ما قدرت أوصل لـMusic Bot حاليًا.');
  }
  return ack;
}

async function handleBarePlay(message) {
  const voiceId = message.member?.voice?.channelId;
  if (!voiceId) {
    await reply(message, 'ادخل روم صوتي أول.');
    return true;
  }
  const worker = await ensureWorkerSelection(message, voiceId, true);
  if (!worker) {
    await reply(message, healthyWorkers().length ? 'كل Music Bots مستخدمين حاليًا.' : 'Music Bots مو جاهزين حاليًا.');
    return true;
  }
  pending.set(pendingKey(message), {
    workerId: worker.id,
    voiceId: String(voiceId),
    expiresAt: now() + PROMPT_MS,
  });
  await dispatch(message, worker, 'join', {}, 'جاري إدخال Music Bot للروم...');
  return true;
}

async function handlePendingQuery(message) {
  const key = pendingKey(message);
  const row = pending.get(key);
  if (!row) return false;
  if (row.expiresAt <= now()) {
    pending.delete(key);
    return false;
  }
  const voiceId = message.member?.voice?.channelId;
  if (!voiceId || String(voiceId) !== String(row.voiceId)) {
    pending.delete(key);
    return false;
  }
  const query = clean(message.content, 400);
  if (!query) return false;
  pending.delete(key);
  let worker = healthyWorkers().find((item) => item.id === row.workerId) || null;
  if (!worker) worker = await ensureWorkerSelection(message, voiceId, true);
  if (!worker) {
    await reply(message, 'Music Bots مو جاهزين حاليًا.');
    return true;
  }
  await dispatch(message, worker, 'play', { query }, `جاري تشغيل **${clean(query, 160)}**...`);
  return true;
}

async function handleCommand(message) {
  if (!isAllowedCommandChannel(message)) return false;
  const raw = clean(message.content, 400);
  if (!raw) return false;

  if (/^(?:ش|شغل|تشغيل|play|p)$/iu.test(raw)) return handleBarePlay(message);
  if (/^(?:اخرج|اطلع|leave|disconnect)$/iu.test(raw)) {
    const voiceId = message.member?.voice?.channelId;
    if (!voiceId) return reply(message, 'ادخل نفس الروم الصوتي أول.').then(() => true);
    const worker = await ensureWorkerSelection(message, voiceId, false);
    if (!worker) return reply(message, 'ما في Music Bot مربوط بهالروم.').then(() => true);
    await dispatch(message, worker, 'leave', {}, 'جاري إخراج Music Bot...');
    return true;
  }

  const command = parseMusicCommand(raw);
  if (!command) return false;
  if (command.action === 'help') {
    await reply(message, `${helpText()}\n\`ش\` ثم اكتب اسم الأغنية بالرسالة التالية.\n\`اخرج\` — إخراج Music Bot من الروم.`);
    return true;
  }
  if (command.action === 'volume_invalid') {
    await reply(message, 'الصوت لازم يكون من 0% إلى 200%. مثال: `ص 50`.');
    return true;
  }
  const voiceId = message.member?.voice?.channelId;
  if (!voiceId) {
    await reply(message, 'ادخل روم صوتي أول.');
    return true;
  }
  const worker = await ensureWorkerSelection(message, voiceId, command.action === 'play');
  if (!worker) {
    await reply(message, healthyWorkers().length ? 'كل Music Bots مستخدمين حاليًا.' : 'Music Bots مو جاهزين حاليًا.');
    return true;
  }
  await dispatch(message, worker, command.action, {
    query: command.query || null,
    value: command.value ?? null,
  }, immediateText(command));
  return true;
}

function friendlyError(reason) {
  const value = String(reason || '');
  if (/LOGIN_REQUIRED|login required/i.test(value)) return 'YouTube رفض البث من خادم الاستضافة، وجربت مصدر الصوت الاحتياطي أيضًا.';
  if (/SOUNDCLOUD/i.test(value)) return 'تعذر جلب نسخة قابلة للتشغيل من SoundCloud.';
  if (/VOICE_NOT_READY|VOICE_JOIN/i.test(value)) return 'دخل البوت محاولة الاتصال لكن Discord ما جهز اتصال الصوت.';
  if (/NO_PLAYABLE_SOURCE/i.test(value)) return 'ما لقيت نسخة قابلة للتشغيل للأغنية من المصادر المتاحة.';
  return `تعذر تشغيل الأغنية. \`${clean(value || 'UNKNOWN', 100)}\``;
}

async function handleWorkerEvent(client, message, parsed) {
  const payload = parsed.payload || {};
  const workerId = String(payload.worker_id || '');
  if (payload.code === 'error' || payload.code === 'left') release(workerId);
  if (payload.voice_id && ['joined', 'playing', 'queued'].includes(payload.code)) reserve(workerId, payload.voice_id);

  const channel = await client.channels.fetch(payload.channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) {
    await message.delete().catch(() => {});
    return;
  }
  const response = payload.response_message_id ? await channel.messages.fetch(payload.response_message_id).catch(() => null) : null;
  const original = !response && payload.message_id ? await channel.messages.fetch(payload.message_id).catch(() => null) : null;
  const send = async (text) => {
    if (!text) return;
    if (response) await response.edit({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
    else if (original) await original.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    else await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  };

  if (payload.code === 'joined') await send('دخل Music Bot الروم. اكتب اسم الأغنية أو رابطها.');
  else if (payload.code === 'playing') await send(`تشغيل **${payload.title || 'الأغنية'}**${payload.source ? ` • ${payload.source}` : ''}`);
  else if (payload.code === 'queued') await send(`تمت إضافة **${payload.title || 'الأغنية'}** إلى الانتظار.`);
  else if (payload.code === 'skipped') await send(payload.next_title ? `تم التخطي. التالي **${payload.next_title}**` : 'تم تخطي الأغنية.');
  else if (payload.code === 'stopped') await send('تم إيقاف التشغيل ومسح الانتظار.');
  else if (payload.code === 'volume') await send(`تم ضبط الصوت على **${payload.value}%**.`);
  else if (payload.code === 'left') await send('تم إخراج Music Bot من الروم.');
  else if (payload.code === 'not_playing') await send('ما فيه أغنية شغالة حاليًا.');
  else if (payload.code === 'not_found') await send('ما لقيت نتيجة مناسبة للأغنية.');
  else if (payload.code === 'error') {
    console.warn(`[music-v2] Worker ${workerId || '?'} error: ${payload.reason || 'unknown'}`);
    await send(friendlyError(payload.reason));
  }
  await message.delete().catch(() => {});
}

function installMusicControllerV2(client) {
  if (installed) return;
  installed = true;

  client.once('ready', async () => {
    for (const guild of client.guilds.cache.values()) {
      await grantWorkerAccess(guild).catch(() => {});
      await refreshStatuses(guild).catch((error) => console.warn('[music-v2] status load:', error.message));
    }
    console.log('[music-v2] Main controller ready. Workers are command-silent.');
  });

  client.on('guildCreate', (guild) => {
    grantWorkerAccess(guild).then(() => refreshStatuses(guild)).catch(() => {});
  });

  client.on('messageCreate', (message) => {
    if (!message?.guildId) return;
    if (message.channel?.name === DATA_CHANNEL_NAME) {
      if (message.author?.id === client.user?.id) return;
      const parsed = parseRecord(message.content);
      if (!parsed) return;
      if (parsed.type === 'STATUS') {
        rememberStatus(message, parsed);
        return;
      }
      if (parsed.type === 'EVENT') {
        handleWorkerEvent(client, message, parsed).catch((error) => console.warn('[music-v2] event:', error.message));
      }
      return;
    }
    if (message.author?.bot || !isAllowedCommandChannel(message)) return;
    Promise.resolve(handlePendingQuery(message))
      .then((handled) => handled ? true : handleCommand(message))
      .catch((error) => console.warn('[music-v2] command:', error.message));
  });

  client.on('messageUpdate', (_oldMessage, newMessage) => {
    if (newMessage?.channel?.name === DATA_CHANNEL_NAME) rememberStatus(newMessage);
  });

  client.on('voiceStateUpdate', (_oldState, newState) => {
    if (newState?.guild) reconcileDiscordVoice(newState.guild);
  });

  const timer = setInterval(() => {
    for (const guild of client.guilds.cache.values()) refreshStatuses(guild).catch(() => {});
    for (const [key, row] of pending) if (row.expiresAt <= now()) pending.delete(key);
    for (const id of WORKER_IDS) activeReservation(id);
  }, 10_000);
  timer.unref?.();
}

module.exports = { installMusicControllerV2 };
