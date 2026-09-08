'use strict';

const { Client, GatewayIntentBits } = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const { DATA_CHANNEL_NAME, record, parseRecord } = require('./protocol');

const WORKER_ID = String(process.env.MUSIC_WORKER_ID || '').trim();
const TOKEN = process.env.DISCORD_TOKEN;
const LAVALINK_HOST = String(process.env.LAVALINK_HOST || '').trim();
const LAVALINK_PORT = Math.max(1, Number(process.env.LAVALINK_PORT || 2333));
const LAVALINK_PASSWORD = String(process.env.LAVALINK_PASSWORD || '').trim();
const LAVALINK_SECURE = /^(?:1|true|yes)$/i.test(String(process.env.LAVALINK_SECURE || 'false'));
const HEARTBEAT_MS = 10_000;
const EMPTY_LEAVE_MS = 5_000;
const VOICE_JOIN_TIMEOUT_MS = 8_000;
const PLAY_START_TIMEOUT_MS = 12_000;

if (!TOKEN) throw new Error('MUSIC_WORKER_MISSING_DISCORD_TOKEN');
if (!/^[123]$/.test(WORKER_ID)) throw new Error('MUSIC_WORKER_ID_MUST_BE_1_2_3');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const state = {
  guildId: null,
  pinnedVoiceId: null,
  currentTitle: null,
  volume: 100,
  statusMessageId: null,
  backendReady: false,
  emptyTimer: null,
  heartbeatTimer: null,
  startedAt: Date.now(),
};

const seenRequests = new Set();
let lavalink = null;

function safeText(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function actualVoiceId(guild) {
  return guild?.members?.me?.voice?.channelId || null;
}

function currentPlayer(guildId = state.guildId) {
  return lavalink && guildId ? lavalink.getPlayer(String(guildId)) || null : null;
}

function queueLength(player) {
  return Array.isArray(player?.queue?.tracks) ? player.queue.tracks.length : 0;
}

function currentTitle(player) {
  return safeText(player?.queue?.current?.info?.title || player?.queue?.current?.title || state.currentTitle || '', 180) || null;
}

function backendUsable() {
  return Boolean(lavalink && state.backendReady && lavalink.useable);
}

function sendVoiceState(guild, voiceId) {
  guild.shard.send({
    op: 4,
    d: {
      guild_id: guild.id,
      channel_id: voiceId ? String(voiceId) : null,
      self_mute: false,
      self_deaf: true,
    },
  });
}

function waitForVoiceChannel(guild, voiceId, timeoutMs) {
  const wanted = String(voiceId);
  if (String(actualVoiceId(guild) || '') === wanted) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off('voiceStateUpdate', listener);
      resolve(value);
    };
    const listener = (_oldState, newState) => {
      if (newState.guild.id !== guild.id) return;
      if (newState.id !== client.user.id) return;
      if (String(newState.channelId || '') === wanted) done(true);
    };
    const timer = setTimeout(() => done(String(actualVoiceId(guild) || '') === wanted), timeoutMs);
    timer.unref?.();
    client.on('voiceStateUpdate', listener);
  });
}

function waitForTrackStart(guildId, timeoutMs = PLAY_START_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lavalink?.off('trackStart', listener);
      resolve(value);
    };
    const listener = (player, track) => {
      if (String(player.guildId) !== String(guildId)) return;
      done(track || true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    lavalink?.on('trackStart', listener);
  });
}

async function dataChannel(guild) {
  let channel = guild.channels.cache.find((x) => x.name === DATA_CHANNEL_NAME && x.isTextBased?.()) || null;
  if (!channel) {
    await guild.channels.fetch().catch(() => null);
    channel = guild.channels.cache.find((x) => x.name === DATA_CHANNEL_NAME && x.isTextBased?.()) || null;
  }
  return channel;
}

function statusPayload(guild) {
  const player = currentPlayer(guild?.id);
  const voiceId = actualVoiceId(guild);
  return {
    bot_id: client.user?.id || null,
    guild_id: guild?.id || state.guildId,
    voice_id: voiceId,
    pinned_voice_id: state.pinnedVoiceId,
    playing: Boolean(voiceId && (player?.playing || player?.queue?.current || state.currentTitle)),
    current_title: currentTitle(player),
    queue_length: queueLength(player),
    volume: state.volume,
    backend: 'lavalink',
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
    if (batch) message = batch.find((item) => {
      const parsed = parseRecord(item.content);
      return parsed?.type === 'STATUS' && parsed.id === WORKER_ID && item.author?.id === client.user?.id;
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

function hasHuman(guild, voiceId) {
  const channel = guild.channels.cache.get(String(voiceId || ''));
  return Boolean(channel?.isVoiceBased?.() && [...channel.members.values()].some((m) => !m.user?.bot));
}

function clearEmptyTimer() {
  if (state.emptyTimer) clearTimeout(state.emptyTimer);
  state.emptyTimer = null;
}

function scheduleEmptyLeave(guild) {
  clearEmptyTimer();
  const voiceId = actualVoiceId(guild);
  if (!voiceId || hasHuman(guild, voiceId)) return;
  state.emptyTimer = setTimeout(async () => {
    state.emptyTimer = null;
    const nowVoice = actualVoiceId(guild);
    if (!nowVoice || nowVoice !== voiceId || hasHuman(guild, nowVoice)) return;
    await disconnectVoice(guild, 'EMPTY_VOICE_5S');
    await publishStatus(guild).catch(() => {});
  }, EMPTY_LEAVE_MS);
  state.emptyTimer.unref?.();
}

async function disconnectVoice(guild, reason = 'DISCONNECT') {
  clearEmptyTimer();
  const player = currentPlayer(guild.id);
  if (player) await player.destroy(reason, true).catch(() => {});
  try { sendVoiceState(guild, null); } catch {}
  state.currentTitle = null;
}

function setupLavalink() {
  if (!LAVALINK_HOST || !LAVALINK_PASSWORD) {
    console.warn(`[music-worker ${WORKER_ID}] Lavalink variables are missing.`);
    return null;
  }
  const manager = new LavalinkManager({
    nodes: [{
      id: 'neverless-lavalink',
      host: LAVALINK_HOST,
      port: LAVALINK_PORT,
      authorization: LAVALINK_PASSWORD,
      secure: LAVALINK_SECURE,
      retryAmount: 20,
      retryDelay: 5_000,
    }],
    sendToShard: (guildId, payload) => client.guilds.cache.get(String(guildId))?.shard?.send(payload),
    autoSkip: true,
    linksAllowed: true,
    client: { id: 'pending', username: `Neverless Music ${WORKER_ID}` },
    playerOptions: {
      defaultSearchPlatform: 'ytsearch',
      applyVolumeAsFilter: false,
      onDisconnect: { autoReconnect: true, destroyPlayer: false },
      onEmptyQueue: { destroyAfterMs: 0 },
    },
  });

  manager.nodeManager.on('connect', (node) => {
    state.backendReady = true;
    console.log(`[music-worker ${WORKER_ID}] Lavalink connected: ${node.id}`);
    for (const guild of client.guilds.cache.values()) publishStatus(guild).catch(() => {});
  });
  manager.nodeManager.on('disconnect', () => { state.backendReady = false; });
  manager.nodeManager.on('error', (_node, error) => {
    state.backendReady = false;
    console.warn(`[music-worker ${WORKER_ID}] Lavalink node error:`, error?.message || error);
  });
  manager.on('trackStart', (player, track) => {
    state.guildId = String(player.guildId);
    state.currentTitle = safeText(track?.info?.title || track?.title || 'الأغنية', 180);
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) publishStatus(guild).catch(() => {});
  });
  manager.on('trackError', (player, _track, payload) => {
    console.warn(`[music-worker ${WORKER_ID}] Track error:`, payload?.exception?.message || payload?.message || 'unknown');
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) publishStatus(guild).catch(() => {});
  });
  manager.on('trackStuck', (player, _track, payload) => {
    console.warn(`[music-worker ${WORKER_ID}] Track stuck:`, payload?.thresholdMs || 'unknown');
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) publishStatus(guild).catch(() => {});
  });
  manager.on('queueEnd', async (player) => {
    state.currentTitle = null;
    const guild = client.guilds.cache.get(String(player.guildId));
    if (!guild) return;
    if (!state.pinnedVoiceId) await disconnectVoice(guild, 'QUEUE_END').catch(() => {});
    else scheduleEmptyLeave(guild);
    await publishStatus(guild).catch(() => {});
  });
  return manager;
}

lavalink = setupLavalink();
client.on('raw', (packet) => { try { lavalink?.sendRawData(packet); } catch {} });

async function ensurePlayer(guild, voiceId, textChannelId = null) {
  if (!backendUsable()) throw new Error('LAVALINK_UNAVAILABLE');
  const wanted = String(voiceId);
  state.guildId = guild.id;

  let player = currentPlayer(guild.id);
  if (player && player.voiceChannelId && String(player.voiceChannelId) !== wanted) {
    await player.destroy('MOVE_VOICE', true).catch(() => {});
    player = null;
  }
  if (!player) {
    player = lavalink.createPlayer({
      guildId: guild.id,
      voiceChannelId: wanted,
      textChannelId: textChannelId ? String(textChannelId) : null,
      volume: state.volume,
      selfDeaf: true,
      selfMute: false,
    });
  }

  if (String(actualVoiceId(guild) || '') !== wanted) {
    await player.connect().catch((error) => {
      console.warn(`[music-worker ${WORKER_ID}] player.connect failed:`, error.message);
    });
    let joined = await waitForVoiceChannel(guild, wanted, 3_000);
    if (!joined) {
      console.warn(`[music-worker ${WORKER_ID}] Lavalink connect did not move bot; sending gateway voice-state fallback.`);
      sendVoiceState(guild, wanted);
      joined = await waitForVoiceChannel(guild, wanted, VOICE_JOIN_TIMEOUT_MS - 3_000);
    }
    if (!joined) {
      await player.destroy('VOICE_JOIN_TIMEOUT', true).catch(() => {});
      throw new Error('VOICE_JOIN_TIMEOUT');
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  if (String(actualVoiceId(guild) || '') !== wanted) throw new Error('VOICE_CONNECTION_LOST');
  scheduleEmptyLeave(guild);
  await publishStatus(guild).catch(() => {});
  return player;
}

function trackTitle(track, fallback = 'الأغنية') {
  return safeText(track?.info?.title || track?.title || fallback, 180);
}

async function findTrack(player, query, requesterId) {
  const wanted = safeText(query, 400);
  if (!wanted) return null;
  const looksLikeUrl = /^https?:\/\//i.test(wanted);
  const result = await player.search(
    looksLikeUrl ? { query: wanted } : { query: wanted, source: 'ytsearch' },
    { id: String(requesterId || 'unknown') },
    false,
  );
  return Array.isArray(result?.tracks) && result.tracks.length ? result.tracks[0] : null;
}

async function handlePlay(guild, payload) {
  let player;
  try {
    player = await ensurePlayer(guild, payload.voice_id, payload.channel_id);
  } catch (error) {
    await emitEvent(guild, { ...payload, code: 'error', reason: safeText(error.message, 120) });
    return;
  }

  let track;
  try {
    track = await findTrack(player, payload.query, payload.user_id);
  } catch (error) {
    console.warn(`[music-worker ${WORKER_ID}] Search failed:`, error.message);
    await emitEvent(guild, { ...payload, code: 'error', reason: safeText(error.message, 120) });
    return;
  }
  if (!track) {
    await emitEvent(guild, { ...payload, code: 'not_found' });
    return;
  }

  const title = trackTitle(track, payload.query);
  const wasBusy = Boolean(player.playing || player.queue?.current || queueLength(player));
  await player.queue.add(track);
  if (wasBusy) {
    await publishStatus(guild).catch(() => {});
    await emitEvent(guild, { ...payload, code: 'queued', title });
    return;
  }

  try {
    const startedPromise = waitForTrackStart(guild.id);
    await player.play();
    const started = await startedPromise;
    const stillJoined = String(actualVoiceId(guild) || '') === String(payload.voice_id);
    if (!started || !stillJoined) throw new Error(!stillJoined ? 'VOICE_NOT_CONNECTED' : 'PLAYBACK_START_TIMEOUT');
    state.currentTitle = trackTitle(started, title);
    await publishStatus(guild).catch(() => {});
    await emitEvent(guild, { ...payload, code: 'playing', title: state.currentTitle || title });
  } catch (error) {
    state.currentTitle = null;
    console.warn(`[music-worker ${WORKER_ID}] Playback failed:`, error.message);
    await emitEvent(guild, { ...payload, code: 'error', reason: safeText(error.message, 120), title });
  }
}

async function handleSkip(guild, payload) {
  const player = currentPlayer(guild.id);
  if (!player || (!player.playing && !player.queue?.current && !queueLength(player))) {
    await emitEvent(guild, { ...payload, code: 'not_playing' });
    return;
  }
  const next = trackTitle(player.queue?.tracks?.[0], '') || null;
  await player.skip(0, false).catch(() => player.stopPlaying(false, false));
  await emitEvent(guild, { ...payload, code: 'skipped', next_title: next });
  await publishStatus(guild).catch(() => {});
}

async function handleStop(guild, payload) {
  const player = currentPlayer(guild.id);
  if (!player || (!player.playing && !player.queue?.current && !queueLength(player))) {
    await emitEvent(guild, { ...payload, code: 'not_playing' });
    return;
  }
  await player.stopPlaying(true, false).catch(() => {});
  state.currentTitle = null;
  if (!state.pinnedVoiceId) await disconnectVoice(guild, 'STOPPED');
  else scheduleEmptyLeave(guild);
  await publishStatus(guild).catch(() => {});
  await emitEvent(guild, { ...payload, code: 'stopped' });
}

async function handleVolume(guild, payload) {
  const value = Math.max(0, Math.min(200, Number(payload.value) || 0));
  state.volume = value;
  const player = currentPlayer(guild.id);
  if (player) await player.setVolume(value, true).catch(() => {});
  await publishStatus(guild).catch(() => {});
  await emitEvent(guild, { ...payload, code: 'volume', value });
}

async function handlePin(guild, payload) {
  state.pinnedVoiceId = String(payload.voice_id);
  try { await ensurePlayer(guild, state.pinnedVoiceId, payload.channel_id); }
  catch (error) { console.warn(`[music-worker ${WORKER_ID}] Pin join failed:`, error.message); }
  scheduleEmptyLeave(guild);
  await publishStatus(guild).catch(() => {});
}

async function handleUnpin(guild) {
  state.pinnedVoiceId = null;
  await disconnectVoice(guild, 'UNPINNED');
  await publishStatus(guild).catch(() => {});
}

async function processRequest(message, parsed) {
  const payload = parsed.payload || {};
  const requestId = String(payload.request_id || message.id);
  if (seenRequests.has(requestId)) return;
  seenRequests.add(requestId);
  if (seenRequests.size > 500) for (const id of [...seenRequests].slice(0, 250)) seenRequests.delete(id);
  const guild = client.guilds.cache.get(String(payload.guild_id));
  if (!guild) return;
  try {
    if (payload.action === 'play') await handlePlay(guild, payload);
    else if (payload.action === 'skip') await handleSkip(guild, payload);
    else if (payload.action === 'stop') await handleStop(guild, payload);
    else if (payload.action === 'volume') await handleVolume(guild, payload);
    else if (payload.action === 'pin') await handlePin(guild, payload);
    else if (payload.action === 'unpin') await handleUnpin(guild);
  } catch (error) {
    console.warn(`[music-worker ${WORKER_ID}] Request failed:`, error.message);
    await emitEvent(guild, { ...payload, code: 'error', reason: safeText(error.message, 120) });
  }
}

async function bootstrapGuild(guild) {
  state.guildId = guild.id;
  const channel = await dataChannel(guild);
  if (!channel) return false;
  const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (batch) {
    const pinMessage = batch.find((item) => {
      const parsed = parseRecord(item.content);
      return parsed?.type === 'PIN' && parsed.id === WORKER_ID;
    });
    const parsed = pinMessage ? parseRecord(pinMessage.content) : null;
    state.pinnedVoiceId = parsed?.payload?.voice_id ? String(parsed.payload.voice_id) : null;
  }
  await publishStatus(guild);
  return true;
}

async function initialize() {
  console.log(`[music-worker ${WORKER_ID}] Logged in as ${client.user.tag}`);
  if (lavalink) {
    try {
      await lavalink.init({ ...client.user });
      console.log(`[music-worker ${WORKER_ID}] Lavalink initialized.`);
    } catch (error) {
      state.backendReady = false;
      console.warn(`[music-worker ${WORKER_ID}] Lavalink init failed:`, error.message);
    }
  }
  for (const guild of client.guilds.cache.values()) await bootstrapGuild(guild).catch(() => false);
  state.heartbeatTimer = setInterval(() => {
    for (const guild of client.guilds.cache.values()) publishStatus(guild).catch(() => {});
  }, HEARTBEAT_MS);
  state.heartbeatTimer.unref?.();
}

client.once('ready', () => initialize().catch((error) => console.error(`[music-worker ${WORKER_ID}] init failed:`, error)));
client.on('messageCreate', (message) => {
  if (message.channel?.name !== DATA_CHANNEL_NAME) return;
  const parsed = parseRecord(message.content);
  if (parsed?.type !== 'REQ' || parsed.id !== WORKER_ID) return;
  processRequest(message, parsed).catch(() => {});
});
client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = oldState.guild || newState.guild;
  if (!guild) return;
  if (oldState.id === client.user?.id || newState.id === client.user?.id) publishStatus(guild).catch(() => {});
  const voiceId = actualVoiceId(guild);
  if (voiceId && (oldState.channelId === voiceId || newState.channelId === voiceId)) scheduleEmptyLeave(guild);
});
client.on('guildCreate', (guild) => bootstrapGuild(guild).catch(() => {}));
client.login(TOKEN).catch((error) => {
  console.error(`[music-worker ${WORKER_ID}] Login failed:`, error);
  process.exitCode = 1;
});
