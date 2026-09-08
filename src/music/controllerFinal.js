'use strict';

const { PermissionFlagsBits } = require('discord.js');
const {
  CMD_CHANNEL_ID,
  DATA_CHANNEL_NAME,
  HEARTBEAT_STALE_MS,
  record,
  parseRecord,
  parseMusicCommand,
  helpText,
} = require('./protocol');

const WORKER_IDS = ['1', '2', '3'];
const RESERVATION_MS = 60_000;
const PROMPT_MS = 60_000;
const statuses = new Map();
const reservations = new Map();
const pending = new Map();
const pins = new Map();
const pinMessageIds = new Map();
let dataChannelCache = null;
let installed = false;

function now() { return Date.now(); }
function clean(v, max = 400) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function keyFor(message) { return `${message.guildId}:${message.author.id}`; }
function isAdmin(member) { return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)); }

async function dataChannel(guild) {
  if (dataChannelCache?.guildId === guild.id) return dataChannelCache;
  dataChannelCache = guild.channels.cache.find((c) => c.name === DATA_CHANNEL_NAME && c.isTextBased?.()) || null;
  if (!dataChannelCache) {
    await guild.channels.fetch().catch(() => null);
    dataChannelCache = guild.channels.cache.find((c) => c.name === DATA_CHANNEL_NAME && c.isTextBased?.()) || null;
  }
  return dataChannelCache;
}

function rememberStatus(message, parsed = parseRecord(message?.content)) {
  if (parsed?.type !== 'STATUS' || !WORKER_IDS.includes(String(parsed.id))) return false;
  const id = String(parsed.id);
  const heartbeat = Number(parsed.payload?.heartbeat_at) || message?.editedTimestamp || message?.createdTimestamp || 0;
  const previous = statuses.get(id);
  if (!previous || heartbeat >= Number(previous.heartbeat_at || 0)) statuses.set(id, { ...parsed.payload, heartbeat_at: heartbeat });
  return true;
}

function reconcileVoice(guild) {
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
      });
    }
  }
}

function healthyWorkers() {
  const cutoff = now() - HEARTBEAT_STALE_MS;
  return WORKER_IDS.map((id) => ({ id, ...(statuses.get(id) || {}) }))
    .filter((row) => Number(row.heartbeat_at || 0) >= cutoff && row.backend_ready !== false && row.bot_id);
}

function reservation(id) {
  const row = reservations.get(String(id));
  if (!row) return null;
  if (row.expiresAt <= now()) { reservations.delete(String(id)); return null; }
  return row;
}

function reserve(id, voiceId) {
  reservations.set(String(id), { voiceId: String(voiceId), expiresAt: now() + RESERVATION_MS });
}

function workerForVoice(voiceId) {
  const wanted = String(voiceId || '');
  const pinnedId = pins.get(wanted);
  const healthy = healthyWorkers();
  if (pinnedId) {
    const pinned = healthy.find((w) => w.id === pinnedId);
    if (pinned) return pinned;
  }
  return healthy.find((w) => String(w.voice_id || '') === wanted)
    || healthy.find((w) => String(reservation(w.id)?.voiceId || '') === wanted)
    || null;
}

function freeWorker(voiceId) {
  const existing = workerForVoice(voiceId);
  if (existing) return existing;
  return healthyWorkers().find((w) => !w.voice_id && !w.pinned_voice_id && !reservation(w.id)) || null;
}

async function refresh(guild) {
  const channel = await dataChannel(guild);
  if (!channel) return;
  const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (batch) for (const message of batch.values()) rememberStatus(message);
  reconcileVoice(guild);
}

async function loadPinsAndStatuses(guild) {
  const channel = await dataChannel(guild);
  if (!channel) return;
  let before;
  let scanned = 0;
  const latestPin = new Map();
  while (scanned < 1000) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    for (const message of batch.values()) {
      const parsed = parseRecord(message.content);
      if (!parsed) continue;
      if (parsed.type === 'STATUS') rememberStatus(message, parsed);
      if (parsed.type === 'PIN' && WORKER_IDS.includes(String(parsed.id)) && !latestPin.has(String(parsed.id))) {
        latestPin.set(String(parsed.id), { payload: parsed.payload, messageId: message.id });
      }
    }
    scanned += batch.size;
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  pins.clear();
  for (const [id, row] of latestPin) {
    pinMessageIds.set(id, row.messageId);
    const voiceId = row.payload?.voice_id ? String(row.payload.voice_id) : null;
    if (voiceId && guild.channels.cache.get(voiceId)?.isVoiceBased?.()) pins.set(voiceId, id);
  }
  reconcileVoice(guild);
}

function commandAllowed(message) {
  if (!message?.guildId || message.author?.bot || message.channel?.name === DATA_CHANNEL_NAME) return false;
  if (message.channelId === CMD_CHANNEL_ID) return true;
  // Voice-channel chats and temporary/private text rooms are both supported.
  return Boolean(message.member?.voice?.channelId && message.channel?.isTextBased?.());
}

async function reply(message, text) {
  return message.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } }).catch(() => null);
}

async function ensureWorkerAccess(guild, worker, voiceId) {
  const voice = guild.channels.cache.get(String(voiceId)) || await guild.channels.fetch(String(voiceId)).catch(() => null);
  if (!voice?.isVoiceBased?.()) throw new Error('VOICE_CHANNEL_NOT_FOUND');
  const member = guild.members.cache.get(String(worker.bot_id)) || await guild.members.fetch(String(worker.bot_id)).catch(() => null);
  if (!member) throw new Error('MUSIC_WORKER_MEMBER_NOT_FOUND');
  let perms = voice.permissionsFor(member);
  const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
  if (!needed.every((p) => perms?.has(p))) {
    await voice.permissionOverwrites.edit(member.id, {
      ViewChannel: true,
      Connect: true,
      Speak: true,
    }, { reason: 'Neverless music access for selected voice room' });
    perms = voice.permissionsFor(member);
  }
  if (!needed.every((p) => perms?.has(p))) throw new Error('MUSIC_WORKER_VOICE_PERMISSION_DENIED');
  return voice;
}

async function sendRequest(guild, workerId, payload) {
  const channel = await dataChannel(guild);
  if (!channel) throw new Error('MUSIC_DATA_CHANNEL_MISSING');
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = record('REQ', String(workerId), { ...payload, request_id: requestId, expires_at: Date.now() + 45_000 });
  if (content.length > 1950) throw new Error('MUSIC_REQUEST_TOO_LONG');
  await channel.send({ content, allowedMentions: { parse: [] } });
  return requestId;
}

async function dispatch(message, worker, action, extra = {}, ackText = null) {
  const voiceId = extra.voice_id || message.member?.voice?.channelId || null;
  if (voiceId && ['join', 'play', 'pin'].includes(action)) {
    try { await ensureWorkerAccess(message.guild, worker, voiceId); }
    catch (error) {
      await reply(message, `ما قدرت أعطي Music Bot صلاحية دخول هالروم. \`${clean(error.message, 80)}\``);
      return null;
    }
    reserve(worker.id, voiceId);
  }
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
    reservations.delete(worker.id);
    if (ack) await ack.edit({ content: 'ما قدرت أوصل لـMusic Bot حاليًا.' }).catch(() => {});
    else await reply(message, 'ما قدرت أوصل لـMusic Bot حاليًا.');
  }
  return ack;
}

async function persistPin(guild, workerId, voiceId) {
  const channel = await dataChannel(guild);
  if (!channel) throw new Error('MUSIC_DATA_CHANNEL_MISSING');
  const content = record('PIN', String(workerId), { voice_id: voiceId ? String(voiceId) : null, updated_at: Date.now() });
  const known = pinMessageIds.get(String(workerId));
  let message = known ? await channel.messages.fetch(known).catch(() => null) : null;
  if (message) await message.edit({ content }).catch(() => {});
  else {
    message = await channel.send({ content, allowedMentions: { parse: [] } });
    pinMessageIds.set(String(workerId), message.id);
  }
  for (const [v, id] of pins) if (id === String(workerId)) pins.delete(v);
  if (voiceId) pins.set(String(voiceId), String(workerId));
}

function mentionedWorker(message) {
  for (const user of message.mentions?.users?.values?.() || []) {
    const found = healthyWorkers().find((w) => String(w.bot_id) === String(user.id));
    if (found) return found;
  }
  return null;
}

async function handlePin(message, unpin = false) {
  if (!isAdmin(message.member)) { await reply(message, 'أمر التثبيت للإدارة فقط.'); return true; }
  const voiceId = message.member?.voice?.channelId;
  if (!voiceId) { await reply(message, 'ادخل الروم الصوتي أول.'); return true; }
  await refresh(message.guild).catch(() => {});
  let worker = mentionedWorker(message) || workerForVoice(voiceId);
  if (unpin) {
    worker ||= healthyWorkers().find((w) => String(w.pinned_voice_id || '') === String(voiceId)) || null;
    if (!worker) { await reply(message, 'ما فيه Music Bot مثبت في هالروم.'); return true; }
    await persistPin(message.guild, worker.id, null).catch(() => {});
    await dispatch(message, worker, 'unpin', { voice_id: voiceId }, 'تم إلغاء تثبيت Music Bot.');
    return true;
  }
  worker ||= freeWorker(voiceId);
  if (!worker) { await reply(message, 'ما فيه Music Bot متاح للتثبيت حاليًا.'); return true; }
  await persistPin(message.guild, worker.id, voiceId).catch(() => {});
  await dispatch(message, worker, 'pin', { voice_id: voiceId }, 'تم تثبيت Music Bot في هالروم.');
  return true;
}

function friendlyError(reason) {
  const value = clean(reason, 140);
  if (/login|required|confirm you.?re not a bot/i.test(value)) return 'YouTube رفض البث من خادم الاستضافة. جرّبت مصدر الموسيقى البديل أولًا.';
  if (/permission/i.test(value)) return 'Music Bot ما عنده صلاحية كافية في الروم.';
  if (/voice/i.test(value)) return 'تعذر تثبيت اتصال الصوت مع Discord.';
  return `تعذر تشغيل الأغنية. \`${value || 'UNKNOWN'}\``;
}

async function handleWorkerEvent(client, message, parsed) {
  const p = parsed.payload || {};
  const workerId = String(p.worker_id || '');
  if (p.code === 'left') reservations.delete(workerId);
  if (p.voice_id && ['joined', 'playing', 'queued', 'pinned'].includes(p.code)) reserve(workerId, p.voice_id);
  const channel = p.channel_id ? await client.channels.fetch(String(p.channel_id)).catch(() => null) : null;
  if (!channel?.isTextBased?.()) { await message.delete().catch(() => {}); return; }
  const response = p.response_message_id ? await channel.messages.fetch(String(p.response_message_id)).catch(() => null) : null;
  const original = !response && p.message_id ? await channel.messages.fetch(String(p.message_id)).catch(() => null) : null;
  const send = async (text) => {
    if (!text) return;
    if (response) return response.edit({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
    if (original) return original.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    return channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  };
  if (p.code === 'joined') await send('دخل Music Bot الروم. اكتب اسم الأغنية.');
  else if (p.code === 'playing') await send(`تشغيل **${clean(p.title, 160) || 'الأغنية'}**${p.source ? ` • ${p.source}` : ''}`);
  else if (p.code === 'queued') await send(`تمت إضافة **${clean(p.title, 160)}** للانتظار.`);
  else if (p.code === 'skipped') await send('تم تخطي الأغنية.');
  else if (p.code === 'stopped') await send('تم إيقاف التشغيل ومسح الانتظار.');
  else if (p.code === 'volume') await send(`تم ضبط الصوت على **${Number(p.value) || 0}%**.`);
  else if (p.code === 'left') await send('تم إخراج Music Bot من الروم.');
  else if (p.code === 'pinned') await send('تم تثبيت Music Bot في هالروم.');
  else if (p.code === 'unpinned') await send('تم إلغاء تثبيت Music Bot.');
  else if (p.code === 'not_found') await send('ما لقيت الأغنية بالمصادر المتاحة.');
  else if (p.code === 'not_playing') await send('ما فيه أغنية شغالة حاليًا.');
  else if (p.code === 'error') await send(friendlyError(p.reason));
  await message.delete().catch(() => {});
}

async function handleCommand(message) {
  if (!commandAllowed(message)) return false;
  const raw = clean(message.content);
  if (!raw) return false;

  const pinRaw = raw.replace(/<@!?\d+>/g, '').trim();
  if (/^(?:تثبيت|ثبت|pin)$/iu.test(pinRaw)) return handlePin(message, false);
  if (/^(?:(?:الغاء|إلغاء|فك)\s*تثبيت|unpin)$/iu.test(pinRaw)) return handlePin(message, true);

  const pendingRow = pending.get(keyFor(message));
  if (pendingRow && pendingRow.expiresAt > now() && !parseMusicCommand(raw)) {
    const voiceId = message.member?.voice?.channelId;
    if (voiceId && String(voiceId) === String(pendingRow.voiceId)) {
      pending.delete(keyFor(message));
      let worker = healthyWorkers().find((w) => w.id === pendingRow.workerId) || freeWorker(voiceId);
      if (!worker) { await refresh(message.guild); worker = freeWorker(voiceId); }
      if (!worker) { await reply(message, 'Music Bots مو جاهزين حاليًا.'); return true; }
      await dispatch(message, worker, 'play', { query: raw, voice_id: voiceId }, `جاري تشغيل **${clean(raw, 160)}**...`);
      return true;
    }
  }

  if (/^(?:ش|شغل|تشغيل|play|p)$/iu.test(raw)) {
    const voiceId = message.member?.voice?.channelId;
    if (!voiceId) { await reply(message, 'ادخل روم صوتي أول.'); return true; }
    await refresh(message.guild).catch(() => {});
    const worker = freeWorker(voiceId);
    if (!worker) { await reply(message, healthyWorkers().length ? 'كل Music Bots مستخدمين حاليًا.' : 'Music Bots مو جاهزين حاليًا.'); return true; }
    pending.set(keyFor(message), { workerId: worker.id, voiceId: String(voiceId), expiresAt: now() + PROMPT_MS });
    await dispatch(message, worker, 'join', { voice_id: voiceId }, 'جاري إدخال Music Bot للروم...');
    return true;
  }

  if (/^(?:اخرج|اطلع|leave|disconnect)$/iu.test(raw)) {
    const voiceId = message.member?.voice?.channelId;
    if (!voiceId) { await reply(message, 'ادخل نفس الروم أول.'); return true; }
    await refresh(message.guild).catch(() => {});
    const worker = workerForVoice(voiceId);
    if (!worker) { await reply(message, 'ما فيه Music Bot في هالروم.'); return true; }
    await dispatch(message, worker, 'leave', { voice_id: voiceId }, 'جاري إخراج Music Bot...');
    return true;
  }

  const cmd = parseMusicCommand(raw);
  if (!cmd) return false;
  if (cmd.action === 'help') {
    await reply(message, `${helpText()}\n\`تثبيت\` — تثبيت Music Bot في رومك\n\`إلغاء تثبيت\` — فك التثبيت`);
    return true;
  }
  if (cmd.action === 'volume_invalid') { await reply(message, 'الصوت من 0 إلى 200.'); return true; }
  const voiceId = message.member?.voice?.channelId;
  if (!voiceId) { await reply(message, 'ادخل روم صوتي أول.'); return true; }
  await refresh(message.guild).catch(() => {});
  const worker = cmd.action === 'play' ? freeWorker(voiceId) : workerForVoice(voiceId);
  if (!worker) { await reply(message, healthyWorkers().length ? 'كل Music Bots مستخدمين حاليًا.' : 'Music Bots مو جاهزين حاليًا.'); return true; }
  const ackText = cmd.action === 'play' ? `جاري تشغيل **${clean(cmd.query, 160)}**...`
    : cmd.action === 'skip' ? 'جاري التخطي...'
      : cmd.action === 'stop' ? 'جاري إيقاف التشغيل...'
        : `جاري ضبط الصوت على **${cmd.value}%**...`;
  await dispatch(message, worker, cmd.action, { query: cmd.query || null, value: cmd.value ?? null, voice_id: voiceId }, ackText);
  return true;
}

function installMusicControllerFinal(client) {
  if (installed) return;
  installed = true;
  client.once('ready', async () => {
    for (const guild of client.guilds.cache.values()) {
      await guild.members.fetch().catch(() => null);
      await guild.channels.fetch().catch(() => null);
      await loadPinsAndStatuses(guild).catch(() => {});
    }
    console.log('[music-final] Main controller ready. Workers are private executors.');
  });
  client.on('guildCreate', (guild) => loadPinsAndStatuses(guild).catch(() => {}));
  client.on('messageCreate', async (message) => {
    const parsed = parseRecord(message.content);
    if (message.channel?.name === DATA_CHANNEL_NAME && parsed) {
      if (parsed.type === 'STATUS') rememberStatus(message, parsed);
      else if (parsed.type === 'EVENT') await handleWorkerEvent(client, message, parsed);
      return;
    }
    await handleCommand(message).catch((error) => console.warn('[music-final] Command failed:', error?.message || error));
  });
}

module.exports = { installMusicControllerFinal };
