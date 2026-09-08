'use strict';

const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const { DATA_CHANNEL_NAME, record, parseRecord } = require('./protocol');

const WORKER_ID = String(process.env.MUSIC_WORKER_ID || '').trim();
const TOKEN = process.env.DISCORD_TOKEN;
const LAVALINK_HOST = String(process.env.LAVALINK_HOST || '').trim();
const LAVALINK_PORT = Math.max(1, Number(process.env.LAVALINK_PORT || 2333));
const LAVALINK_PASSWORD = String(process.env.LAVALINK_PASSWORD || '').trim();
const LAVALINK_SECURE = /^(?:1|true|yes)$/i.test(String(process.env.LAVALINK_SECURE || 'false'));
const SOURCE_ORDER = String(process.env.MUSIC_SOURCE_ORDER || 'soundcloud,youtube')
  .split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
const EMPTY_LEAVE_MS = Math.max(15_000, Number(process.env.MUSIC_EMPTY_LEAVE_MS || 30_000));
const KEEP_ALIVE_MS = 90_000;
const HEARTBEAT_MS = 5_000;
const JOIN_TIMEOUT_MS = 12_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const PLAY_TIMEOUT_MS = 15_000;

if (!TOKEN) throw new Error('MUSIC_WORKER_MISSING_DISCORD_TOKEN');
if (!/^[123]$/.test(WORKER_ID)) throw new Error('MUSIC_WORKER_ID_MUST_BE_1_2_3');
if (!LAVALINK_HOST || !LAVALINK_PASSWORD) throw new Error('MUSIC_WORKER_MISSING_LAVALINK_CONFIG');

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
] });

const state = {
  guildId: null,
  pinnedVoiceId: null,
  currentTitle: null,
  currentSource: null,
  volume: 100,
  backendReady: false,
  statusMessageId: null,
  heartbeatTimer: null,
  emptyTimer: null,
  keepAliveUntil: 0,
  startedAt: Date.now(),
  starting: new Set(),
};

const seenRequests = new Set();
const playbackWaiters = new Map();
let lavalink = null;

function clean(v, max = 180) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function actualVoiceId(guild) { return guild?.members?.me?.voice?.channelId || null; }
function playerFor(guildId = state.guildId) { return lavalink && guildId ? lavalink.getPlayer(String(guildId)) || null : null; }
function queueLength(player) { return Array.isArray(player?.queue?.tracks) ? player.queue.tracks.length : 0; }
function titleOf(track, fallback = 'الأغنية') { return clean(track?.info?.title || track?.title || fallback, 180); }
function sourceOf(track) { return clean(track?.info?.sourceName || track?.info?.source || '', 40); }
function backendUsable() { return Boolean(lavalink && state.backendReady && lavalink.useable); }

async function dataChannel(guild) {
  let channel = guild.channels.cache.find((c) => c.name === DATA_CHANNEL_NAME && c.isTextBased?.()) || null;
  if (!channel) {
    await guild.channels.fetch().catch(() => null);
    channel = guild.channels.cache.find((c) => c.name === DATA_CHANNEL_NAME && c.isTextBased?.()) || null;
  }
  return channel;
}

function statusPayload(guild) {
  const player = playerFor(guild?.id);
  const voiceId = actualVoiceId(guild);
  return {
    worker_id: WORKER_ID,
    bot_id: client.user?.id || null,
    guild_id: guild?.id || state.guildId,
    voice_id: voiceId,
    pinned_voice_id: state.pinnedVoiceId,
    playing: Boolean(voiceId && player?.playing && player?.queue?.current),
    current_title: voiceId ? (titleOf(player?.queue?.current, state.currentTitle || '') || null) : null,
    current_source: state.currentSource,
    queue_length: voiceId ? queueLength(player) : 0,
    volume: state.volume,
    backend: 'lavalink-final',
    backend_ready: backendUsable(),
    heartbeat_at: Date.now(),
    started_at: state.startedAt,
  };
}

async function publishStatus(guild) {
  const channel = await dataChannel(guild);
  if (!channel) return;
  const content = record('STATUS', WORKER_ID, statusPayload(guild));
  let message = state.statusMessageId ? await channel.messages.fetch(state.statusMessageId).catch(() => null) : null;
  if (!message) {
    const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    message = batch?.find((m) => {
      const parsed = parseRecord(m.content);
      return parsed?.type === 'STATUS' && String(parsed.id) === WORKER_ID && m.author?.id === client.user?.id;
    }) || null;
  }
  if (message) {
    state.statusMessageId = message.id;
    await message.edit({ content }).catch(() => {});
  } else {
    message = await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
    if (message) state.statusMessageId = message.id;
  }
}

async function emitEvent(guild, payload) {
  const channel = await dataChannel(guild);
  if (!channel) return;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = record('EVENT', id, { worker_id: WORKER_ID, ...payload });
  if (content.length <= 1950) await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

function voiceHasHuman(guild, voiceId) {
  const wanted = String(voiceId || '');
  if (!wanted) return false;
  for (const vs of guild.voiceStates.cache.values()) {
    if (String(vs.channelId || '') !== wanted || String(vs.id) === String(client.user?.id)) continue;
    if (vs.member?.user?.bot !== true) return true;
  }
  const channel = guild.channels.cache.get(wanted);
  return Boolean(channel?.isVoiceBased?.() && [...channel.members.values()].some((m) => m.id !== client.user?.id && !m.user?.bot));
}

function clearEmptyTimer() {
  if (state.emptyTimer) clearTimeout(state.emptyTimer);
  state.emptyTimer = null;
}

function keepAlive(ms = KEEP_ALIVE_MS) {
  state.keepAliveUntil = Math.max(state.keepAliveUntil, Date.now() + ms);
  clearEmptyTimer();
}

function scheduleEmptyLeave(guild) {
  clearEmptyTimer();
  const voiceId = actualVoiceId(guild);
  if (!voiceId || state.pinnedVoiceId === String(voiceId) || state.starting.has(String(guild.id))) return;
  if (voiceHasHuman(guild, voiceId)) return;
  const wait = Math.max(EMPTY_LEAVE_MS, state.keepAliveUntil - Date.now());
  const expected = String(voiceId);
  state.emptyTimer = setTimeout(async () => {
    state.emptyTimer = null;
    const current = actualVoiceId(guild);
    if (!current || String(current) !== expected) return;
    if (state.pinnedVoiceId === expected || state.starting.has(String(guild.id)) || voiceHasHuman(guild, current)) return;
    if (Date.now() < state.keepAliveUntil) return scheduleEmptyLeave(guild);
    await disconnectVoice(guild, 'EMPTY_VOICE_TIMEOUT').catch(() => {});
  }, Math.max(1_000, wait));
  state.emptyTimer.unref?.();
}

async function disconnectVoice(guild, reason = 'DISCONNECT') {
  clearEmptyTimer();
  state.keepAliveUntil = 0;
  const player = playerFor(guild.id);
  if (player) await player.destroy(reason, true).catch(() => {});
  state.currentTitle = null;
  state.currentSource = null;
  await publishStatus(guild).catch(() => {});
}

function waitUntil(check, timeoutMs, step = 100) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      const timer = setTimeout(tick, step); timer.unref?.();
    };
    tick();
  });
}

function handshakeReady(player, voiceId) {
  const v = player?.voice;
  return Boolean(v?.sessionId && v?.token && v?.endpoint && String(v?.channelId || '') === String(voiceId));
}

function settlePlayback(guildId, result) {
  const cb = playbackWaiters.get(String(guildId));
  if (!cb) return;
  playbackWaiters.delete(String(guildId));
  cb(result);
}

function waitPlayback(guildId) {
  const key = String(guildId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      playbackWaiters.delete(key);
      resolve({ ok: false, reason: 'PLAYBACK_START_TIMEOUT' });
    }, PLAY_TIMEOUT_MS);
    timer.unref?.();
    playbackWaiters.set(key, (result) => { clearTimeout(timer); resolve(result); });
  });
}

function setupLavalink() {
  const manager = new LavalinkManager({
    nodes: [{
      id: 'neverless-lavalink', host: LAVALINK_HOST, port: LAVALINK_PORT,
      authorization: LAVALINK_PASSWORD, secure: LAVALINK_SECURE,
      retryAmount: 20, retryDelay: 5_000,
    }],
    sendToShard: (guildId, payload) => client.guilds.cache.get(String(guildId))?.shard?.send(payload),
    autoSkip: false,
    linksAllowed: true,
    client: { id: 'pending', username: `Neverless Music ${WORKER_ID}` },
    playerOptions: {
      defaultSearchPlatform: 'soundcloud',
      applyVolumeAsFilter: false,
      onDisconnect: { autoReconnect: false, destroyPlayer: true },
      // Negative means: keep the player/voice connection when the queue is empty.
      onEmptyQueue: { destroyAfterMs: -1 },
    },
  });

  manager.nodeManager.on('connect', (node) => {
    state.backendReady = true;
    console.log(`[music-final-worker ${WORKER_ID}] Lavalink connected: ${node.id}`);
    for (const guild of client.guilds.cache.values()) publishStatus(guild).catch(() => {});
  });
  manager.nodeManager.on('disconnect', () => { state.backendReady = false; });
  manager.nodeManager.on('error', (_node, error) => {
    state.backendReady = false;
    console.warn(`[music-final-worker ${WORKER_ID}] Lavalink error:`, error?.message || error);
  });
  manager.on('trackStart', (player, track) => {
    state.currentTitle = titleOf(track);
    state.currentSource = sourceOf(track);
    settlePlayback(player.guildId, { ok: true, track });
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) publishStatus(guild).catch(() => {});
  });
  manager.on('trackError', (player, _track, payload) => {
    const reason = clean(payload?.exception?.message || payload?.message || 'TRACK_ERROR', 180);
    console.warn(`[music-final-worker ${WORKER_ID}] Track error: ${reason}`);
    state.currentTitle = null;
    state.currentSource = null;
    settlePlayback(player.guildId, { ok: false, reason });
  });
  manager.on('trackStuck', (player, _track, payload) => {
    settlePlayback(player.guildId, { ok: false, reason: `TRACK_STUCK_${Number(payload?.thresholdMs) || 0}` });
  });
  manager.on('trackEnd', (player) => {
    state.currentTitle = null;
    state.currentSource = null;
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) publishStatus(guild).catch(() => {});
  });
  manager.on('queueEnd', (player) => {
    state.currentTitle = null;
    state.currentSource = null;
    settlePlayback(player.guildId, { ok: false, reason: 'QUEUE_ENDED_BEFORE_AUDIO' });
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) {
      publishStatus(guild).catch(() => {});
      scheduleEmptyLeave(guild);
    }
  });
  return manager;
}

lavalink = setupLavalink();
client.on('raw', (packet) => {
  try { lavalink?.sendRawData(packet); } catch (error) {
    console.warn(`[music-final-worker ${WORKER_ID}] raw voice forward failed:`, error?.message || error);
  }
});

async function ensurePlayer(guild, voiceId, textChannelId = null) {
  if (!backendUsable()) throw new Error('LAVALINK_UNAVAILABLE');
  const wanted = String(voiceId || '');
  state.guildId = guild.id;
  let voice = guild.channels.cache.get(wanted) || await guild.channels.fetch(wanted).catch(() => null);
  if (!voice?.isVoiceBased?.()) {
    await sleep(500);
    voice = await guild.channels.fetch(wanted).catch(() => null);
  }
  if (!voice?.isVoiceBased?.()) throw new Error('VOICE_CHANNEL_NOT_FOUND');
  let perms = voice.permissionsFor(guild.members.me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    await sleep(500);
    perms = voice.permissionsFor(guild.members.me);
  }
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) throw new Error('MISSING_VIEW_CHANNEL_PERMISSION');
  if (!perms?.has(PermissionFlagsBits.Connect)) throw new Error('MISSING_CONNECT_PERMISSION');
  if (!perms?.has(PermissionFlagsBits.Speak)) throw new Error('MISSING_SPEAK_PERMISSION');

  let player = playerFor(guild.id);
  if (player && String(player.voiceChannelId || '') !== wanted) {
    await player.destroy('MOVE_VOICE', true).catch(() => {});
    player = null;
  }
  if (!player) {
    player = lavalink.createPlayer({
      guildId: guild.id, voiceChannelId: wanted,
      textChannelId: textChannelId ? String(textChannelId) : null,
      volume: state.volume, selfDeaf: true, selfMute: false,
    });
  }
  keepAlive();
  if (String(actualVoiceId(guild) || '') !== wanted) await player.connect();
  const joined = await waitUntil(() => String(actualVoiceId(guild) || '') === wanted, JOIN_TIMEOUT_MS);
  if (!joined) throw new Error('VOICE_JOIN_TIMEOUT');
  const handshake = await waitUntil(() => handshakeReady(player, wanted), HANDSHAKE_TIMEOUT_MS);
  if (!handshake) throw new Error('VOICE_HANDSHAKE_TIMEOUT');
  if (guild.members.me?.voice?.serverMute || guild.members.me?.voice?.selfMute) throw new Error('BOT_MUTED');
  await publishStatus(guild).catch(() => {});
  return player;
}

async function search(player, query, source, requesterId) {
  const wanted = clean(query, 400);
  if (!wanted) return null;
  const direct = /^https?:\/\//i.test(wanted);
  const options = direct ? { query: wanted } : { query: wanted, source };
  const result = await player.search(options, { id: String(requesterId || 'unknown') }, false).catch(() => null);
  return Array.isArray(result?.tracks) && result.tracks.length ? result.tracks[0] : null;
}

async function findCandidates(player, query, requesterId) {
  const wanted = clean(query, 400);
  if (/^https?:\/\//i.test(wanted)) {
    const track = await search(player, wanted, undefined, requesterId);
    return track ? [track] : [];
  }
  const found = [];
  for (const source of SOURCE_ORDER.length ? SOURCE_ORDER : ['soundcloud', 'youtube']) {
    const searchSource = source === 'soundcloud' || source === 'sc' ? 'soundcloud' : 'ytsearch';
    const track = await search(player, wanted, searchSource, requesterId);
    if (track) found.push(track);
  }
  return found;
}

async function tryPlay(player, track) {
  await player.stopPlaying(true, false).catch(() => {});
  await player.queue.add(track);
  const playback = waitPlayback(player.guildId);
  await player.play();
  return playback;
}

async function handleJoin(guild, p) {
  const key = String(guild.id);
  state.starting.add(key);
  keepAlive();
  try {
    await ensurePlayer(guild, p.voice_id, p.channel_id);
    await emitEvent(guild, { ...p, code: 'joined', voice_id: String(p.voice_id) });
  } catch (error) {
    await emitEvent(guild, { ...p, code: 'error', reason: clean(error?.message || error) });
  } finally {
    state.starting.delete(key);
    scheduleEmptyLeave(guild);
  }
}

async function handlePlay(guild, p) {
  const key = String(guild.id);
  state.starting.add(key);
  keepAlive();
  try {
    const player = await ensurePlayer(guild, p.voice_id, p.channel_id);
    const candidates = await findCandidates(player, p.query, p.user_id);
    if (!candidates.length) {
      await emitEvent(guild, { ...p, code: 'not_found' });
      return;
    }
    if (player.playing && player.queue?.current) {
      const track = candidates[0];
      await player.queue.add(track);
      await emitEvent(guild, { ...p, code: 'queued', title: titleOf(track), source: sourceOf(track) });
      await publishStatus(guild).catch(() => {});
      return;
    }

    let lastReason = 'PLAYBACK_START_FAILED';
    for (const track of candidates) {
      const result = await tryPlay(player, track);
      if (result?.ok) {
        await sleep(500);
        if (String(actualVoiceId(guild) || '') !== String(p.voice_id)) throw new Error('VOICE_NOT_CONNECTED');
        state.currentTitle = titleOf(result.track || track);
        state.currentSource = sourceOf(result.track || track);
        await emitEvent(guild, {
          ...p, code: 'playing', title: state.currentTitle,
          source: state.currentSource || 'music', voice_id: String(p.voice_id),
        });
        await publishStatus(guild).catch(() => {});
        return;
      }
      lastReason = result?.reason || lastReason;
    }
    throw new Error(lastReason);
  } catch (error) {
    console.warn(`[music-final-worker ${WORKER_ID}] Play failed:`, error?.message || error);
    // Never destroy the voice player because a source failed. The worker stays in the room.
    await emitEvent(guild, { ...p, code: 'error', reason: clean(error?.message || error, 180) });
  } finally {
    state.starting.delete(key);
    scheduleEmptyLeave(guild);
  }
}

async function handleSkip(guild, p) {
  const player = playerFor(guild.id);
  if (!player || !player.queue?.current) return emitEvent(guild, { ...p, code: 'not_playing' });
  await player.skip(0, false).catch(() => player.stopPlaying(false, false));
  await emitEvent(guild, { ...p, code: 'skipped' });
  await publishStatus(guild).catch(() => {});
}

async function handleStop(guild, p) {
  const player = playerFor(guild.id);
  if (!player) return emitEvent(guild, { ...p, code: 'not_playing' });
  await player.stopPlaying(true, false).catch(() => {});
  state.currentTitle = null;
  state.currentSource = null;
  keepAlive(30_000);
  await emitEvent(guild, { ...p, code: 'stopped' });
  await publishStatus(guild).catch(() => {});
}

async function handleVolume(guild, p) {
  state.volume = Math.max(0, Math.min(200, Number(p.value) || 0));
  const player = playerFor(guild.id);
  if (player) await player.setVolume(state.volume, true).catch(() => {});
  await emitEvent(guild, { ...p, code: 'volume', value: state.volume });
  await publishStatus(guild).catch(() => {});
}

async function handlePin(guild, p) {
  state.pinnedVoiceId = String(p.voice_id || '');
  keepAlive(24 * 60 * 60 * 1000);
  try {
    await ensurePlayer(guild, state.pinnedVoiceId, p.channel_id);
    await emitEvent(guild, { ...p, code: 'pinned', voice_id: state.pinnedVoiceId });
  } catch (error) {
    state.pinnedVoiceId = null;
    await emitEvent(guild, { ...p, code: 'error', reason: clean(error?.message || error) });
  }
  await publishStatus(guild).catch(() => {});
}

async function handleUnpin(guild, p) {
  state.pinnedVoiceId = null;
  state.keepAliveUntil = Date.now() + 30_000;
  await emitEvent(guild, { ...p, code: 'unpinned' });
  await publishStatus(guild).catch(() => {});
  scheduleEmptyLeave(guild);
}

async function processRequest(message, parsed) {
  const p = parsed.payload || {};
  const requestId = String(p.request_id || message.id);
  if (seenRequests.has(requestId)) return;
  if (Number(p.expires_at) && Date.now() > Number(p.expires_at) + 45_000) return;
  seenRequests.add(requestId);
  if (seenRequests.size > 500) for (const id of [...seenRequests].slice(0, 250)) seenRequests.delete(id);
  const guild = client.guilds.cache.get(String(p.guild_id));
  if (!guild) return;
  if (p.action === 'join') await handleJoin(guild, p);
  else if (p.action === 'play') await handlePlay(guild, p);
  else if (p.action === 'skip') await handleSkip(guild, p);
  else if (p.action === 'stop') await handleStop(guild, p);
  else if (p.action === 'volume') await handleVolume(guild, p);
  else if (p.action === 'pin') await handlePin(guild, p);
  else if (p.action === 'unpin') await handleUnpin(guild, p);
  else if (p.action === 'leave') {
    state.pinnedVoiceId = null;
    await disconnectVoice(guild, 'USER_LEAVE');
    await emitEvent(guild, { ...p, code: 'left' });
  }
}

async function loadPin(guild) {
  const channel = await dataChannel(guild);
  if (!channel) return;
  let before;
  let scanned = 0;
  while (scanned < 1000) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    const found = batch.find((m) => {
      const parsed = parseRecord(m.content);
      return parsed?.type === 'PIN' && String(parsed.id) === WORKER_ID;
    });
    if (found) {
      const parsed = parseRecord(found.content);
      state.pinnedVoiceId = parsed?.payload?.voice_id ? String(parsed.payload.voice_id) : null;
      break;
    }
    scanned += batch.size;
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
}

async function initialize() {
  console.log(`[music-final-worker ${WORKER_ID}] Logged in as ${client.user.tag}. Sources=${SOURCE_ORDER.join(' -> ')}`);
  await lavalink.init(client.user);
  for (const guild of client.guilds.cache.values()) {
    await guild.channels.fetch().catch(() => null);
    await guild.members.fetch().catch(() => null);
    await loadPin(guild).catch(() => {});
    await publishStatus(guild).catch(() => {});
  }
  state.heartbeatTimer = setInterval(() => {
    for (const guild of client.guilds.cache.values()) publishStatus(guild).catch(() => {});
  }, HEARTBEAT_MS);
  state.heartbeatTimer.unref?.();
}

client.once('ready', () => initialize().catch((error) => {
  console.error(`[music-final-worker ${WORKER_ID}] initialization failed:`, error);
  process.exitCode = 1;
}));

client.on('messageCreate', (message) => {
  if (message.channel?.name !== DATA_CHANNEL_NAME) return;
  const parsed = parseRecord(message.content);
  if (parsed?.type !== 'REQ' || String(parsed.id) !== WORKER_ID) return;
  processRequest(message, parsed).catch((error) => console.warn(`[music-final-worker ${WORKER_ID}] request failed:`, error?.message || error));
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = oldState.guild || newState.guild;
  if (!guild) return;
  if (newState.id === client.user?.id && oldState.channelId && !newState.channelId) {
    clearEmptyTimer();
    const player = playerFor(guild.id);
    if (player) player.destroy('DISCORD_VOICE_DISCONNECT', true).catch(() => {});
    state.currentTitle = null;
    state.currentSource = null;
    publishStatus(guild).catch(() => {});
    if (state.pinnedVoiceId) {
      const wanted = state.pinnedVoiceId;
      const timer = setTimeout(async () => {
        try { await ensurePlayer(guild, wanted, null); }
        catch (error) { console.warn(`[music-final-worker ${WORKER_ID}] pinned reconnect failed:`, error?.message || error); }
      }, 1500);
      timer.unref?.();
    }
    return;
  }
  const active = actualVoiceId(guild);
  if (active) scheduleEmptyLeave(guild);
});

client.on('guildCreate', async (guild) => {
  await loadPin(guild).catch(() => {});
  await publishStatus(guild).catch(() => {});
});

client.login(TOKEN).catch((error) => {
  console.error(`[music-final-worker ${WORKER_ID}] login failed:`, error);
  process.exitCode = 1;
});
