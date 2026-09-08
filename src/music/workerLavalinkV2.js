'use strict';

const {
  Client,
  GatewayIntentBits,
  GatewayDispatchEvents,
  PermissionFlagsBits,
} = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const { DATA_CHANNEL_NAME, record, parseRecord } = require('./protocol');

const WORKER_ID = String(process.env.MUSIC_WORKER_ID || '').trim();
const TOKEN = process.env.DISCORD_TOKEN;
const LAVALINK_HOST = String(process.env.LAVALINK_HOST || '').trim();
const LAVALINK_PORT = Math.max(1, Number(process.env.LAVALINK_PORT || 2333));
const LAVALINK_PASSWORD = String(process.env.LAVALINK_PASSWORD || '').trim();
const LAVALINK_SECURE = /^(?:1|true|yes)$/i.test(String(process.env.LAVALINK_SECURE || 'false'));

const HEARTBEAT_MS = 10_000;
const REQUEST_TTL_MS = 45_000;
const EMPTY_LEAVE_MS = 5_000;
const VOICE_JOIN_TIMEOUT_MS = 10_000;
const PLAY_START_TIMEOUT_MS = 15_000;

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
  startingGuilds: new Set(),
};

const seenRequests = new Set();
const playbackWaiters = new Map();
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

function trackTitle(track, fallback = 'الأغنية') {
  return safeText(track?.info?.title || track?.title || fallback, 180);
}

function currentTitle(player) {
  return trackTitle(player?.queue?.current, state.currentTitle || '') || null;
}

function backendUsable() {
  return Boolean(lavalink && state.backendReady && lavalink.useable);
}

async function dataChannel(guild) {
  let channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  if (!channel) {
    await guild.channels.fetch().catch(() => null);
    channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
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
    if (batch) {
      message = batch.find((item) => {
        const parsed = parseRecord(item.content);
        return parsed?.type === 'STATUS' && parsed.id === WORKER_ID && item.author?.id === client.user?.id;
      }) || null;
    }
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
  if (content.length <= 1950) {
    await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
  }
}

function voiceHasHuman(guild, voiceId) {
  const wanted = String(voiceId || '');
  if (!wanted) return false;

  // VoiceState cache is authoritative for users already in VC when this worker starts.
  for (const voiceState of guild.voiceStates.cache.values()) {
    if (String(voiceState.channelId || '') !== wanted) continue;
    if (String(voiceState.id) === String(client.user?.id)) continue;
    // If the member object is not cached, treat it as human rather than falsely ejecting.
    if (voiceState.member?.user?.bot === true) continue;
    return true;
  }

  // Secondary path for normal cached members.
  const channel = guild.channels.cache.get(wanted);
  if (channel?.isVoiceBased?.()) {
    return [...channel.members.values()].some((member) => member.id !== client.user?.id && !member.user?.bot);
  }
  return false;
}

function clearEmptyTimer() {
  if (state.emptyTimer) clearTimeout(state.emptyTimer);
  state.emptyTimer = null;
}

function scheduleEmptyLeave(guild) {
  clearEmptyTimer();
  const voiceId = actualVoiceId(guild);
  if (!voiceId) return;
  if (state.startingGuilds.has(String(guild.id))) return;
  if (voiceHasHuman(guild, voiceId)) return;

  const expectedVoice = String(voiceId);
  state.emptyTimer = setTimeout(async () => {
    state.emptyTimer = null;
    if (state.startingGuilds.has(String(guild.id))) return;
    const nowVoice = actualVoiceId(guild);
    if (!nowVoice || String(nowVoice) !== expectedVoice) return;
    if (voiceHasHuman(guild, nowVoice)) return;
    await disconnectVoice(guild, 'EMPTY_VOICE_5S').catch(() => {});
    await publishStatus(guild).catch(() => {});
  }, EMPTY_LEAVE_MS);
  state.emptyTimer.unref?.();
}

async function disconnectVoice(guild, reason = 'DISCONNECT') {
  clearEmptyTimer();
  const player = currentPlayer(guild.id);
  if (player) await player.destroy(reason, true).catch(() => {});
  state.currentTitle = null;
}

function waitForVoiceChannel(guild, voiceId, timeoutMs = VOICE_JOIN_TIMEOUT_MS) {
  const wanted = String(voiceId);
  if (String(actualVoiceId(guild) || '') === wanted) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off('voiceStateUpdate', listener);
      resolve(value);
    };
    const listener = (_oldState, newState) => {
      if (newState.guild.id !== guild.id || newState.id !== client.user.id) return;
      if (String(newState.channelId || '') === wanted) finish(true);
    };
    const timer = setTimeout(() => finish(String(actualVoiceId(guild) || '') === wanted), timeoutMs);
    timer.unref?.();
    client.on('voiceStateUpdate', listener);
  });
}

function settlePlayback(guildId, result) {
  const waiter = playbackWaiters.get(String(guildId));
  if (!waiter) return;
  playbackWaiters.delete(String(guildId));
  waiter(result);
}

function waitForPlayback(guildId, timeoutMs = PLAY_START_TIMEOUT_MS) {
  const key = String(guildId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      playbackWaiters.delete(key);
      resolve({ ok: false, reason: 'PLAYBACK_START_TIMEOUT' });
    }, timeoutMs);
    timer.unref?.();
    playbackWaiters.set(key, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
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
    sendToShard: (guildId, payload) => {
      const guild = client.guilds.cache.get(String(guildId));
      if (guild) guild.shard.send(payload);
    },
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
  manager.nodeManager.on('disconnect', (node, reason) => {
    state.backendReady = false;
    console.warn(`[music-worker ${WORKER_ID}] Lavalink disconnected: ${node?.id || '?'} ${reason || ''}`);
  });
  manager.nodeManager.on('error', (node, error) => {
    state.backendReady = false;
    console.warn(`[music-worker ${WORKER_ID}] Lavalink error (${node?.id || '?'}):`, error?.message || error);
  });

  manager.on('trackStart', (player, track) => {
    state.currentTitle = trackTitle(track, 'الأغنية');
    settlePlayback(player.guildId, { ok: true, track });
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) {
      clearEmptyTimer();
      scheduleEmptyLeave(guild);
      publishStatus(guild).catch(() => {});
    }
  });
  manager.on('trackError', (player, _track, payload) => {
    const reason = safeText(payload?.exception?.message || payload?.message || 'TRACK_ERROR', 120);
    console.warn(`[music-worker ${WORKER_ID}] Track error: ${reason}`);
    settlePlayback(player.guildId, { ok: false, reason });
  });
  manager.on('trackStuck', (player, _track, payload) => {
    const reason = `TRACK_STUCK_${Number(payload?.thresholdMs) || 0}`;
    console.warn(`[music-worker ${WORKER_ID}] ${reason}`);
    settlePlayback(player.guildId, { ok: false, reason });
  });
  manager.on('queueEnd', (player) => {
    state.currentTitle = null;
    settlePlayback(player.guildId, { ok: false, reason: 'QUEUE_ENDED_BEFORE_AUDIO' });
    const guild = client.guilds.cache.get(String(player.guildId));
    // Keep the bot connected while people are still in the VC. Leave only if truly alone for 5s.
    if (guild) {
      scheduleEmptyLeave(guild);
      publishStatus(guild).catch(() => {});
    }
  });

  return manager;
}

lavalink = setupLavalink();
client.on('raw', (packet) => {
  if (!packet || ![GatewayDispatchEvents.VoiceStateUpdate, GatewayDispatchEvents.VoiceServerUpdate].includes(packet.t)) return;
  try { lavalink?.sendRawData(packet); } catch (error) {
    console.warn(`[music-worker ${WORKER_ID}] Voice packet forward failed:`, error?.message || error);
  }
});

async function ensurePlayer(guild, voiceId, textChannelId = null) {
  if (!backendUsable()) throw new Error('LAVALINK_UNAVAILABLE');
  const wanted = String(voiceId);
  state.guildId = guild.id;

  const voiceChannel = guild.channels.cache.get(wanted) || await guild.channels.fetch(wanted).catch(() => null);
  if (!voiceChannel?.isVoiceBased?.()) throw new Error('VOICE_CHANNEL_NOT_FOUND');
  const permissions = voiceChannel.permissionsFor(guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) throw new Error('MISSING_VIEW_CHANNEL_PERMISSION');
  if (!permissions?.has(PermissionFlagsBits.Connect)) throw new Error('MISSING_CONNECT_PERMISSION');
  if (!permissions?.has(PermissionFlagsBits.Speak)) throw new Error('MISSING_SPEAK_PERMISSION');

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

  clearEmptyTimer();
  if (String(actualVoiceId(guild) || '') !== wanted) {
    await player.connect();
    const joined = await waitForVoiceChannel(guild, wanted);
    if (!joined) {
      await player.destroy('VOICE_JOIN_TIMEOUT', true).catch(() => {});
      throw new Error('VOICE_JOIN_TIMEOUT');
    }
  }

  const me = guild.members.me?.voice;
  if (me?.serverMute || me?.selfMute) {
    await player.destroy('VOICE_MUTED', true).catch(() => {});
    throw new Error(me.serverMute ? 'BOT_SERVER_MUTED' : 'BOT_SELF_MUTED');
  }

  await publishStatus(guild).catch(() => {});
  return player;
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
  const guildKey = String(guild.id);
  state.startingGuilds.add(guildKey);
  clearEmptyTimer();
  try {
    const player = await ensurePlayer(guild, payload.voice_id, payload.channel_id);
    const track = await findTrack(player, payload.query, payload.user_id);
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

    const playbackPromise = waitForPlayback(guild.id);
    await player.play();
    const playback = await playbackPromise;
    const stillJoined = String(actualVoiceId(guild) || '') === String(payload.voice_id);
    if (!stillJoined) throw new Error('VOICE_NOT_CONNECTED');
    if (!playback?.ok) throw new Error(playback?.reason || 'PLAYBACK_START_FAILED');

    state.currentTitle = trackTitle(playback.track, title);
    await publishStatus(guild).catch(() => {});
    await emitEvent(guild, { ...payload, code: 'playing', title: state.currentTitle || title });
  } catch (error) {
    state.currentTitle = null;
    console.warn(`[music-worker ${WORKER_ID}] Play failed:`, error?.message || error);
    await emitEvent(guild, { ...payload, code: 'error', reason: safeText(error?.message || error, 120) });
  } finally {
    state.startingGuilds.delete(guildKey);
    scheduleEmptyLeave(guild);
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
  await publishStatus(guild).catch(() => {});
  await emitEvent(guild, { ...payload, code: 'stopped' });
  scheduleEmptyLeave(guild);
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
  state.pinnedVoiceId = String(payload.voice_id || '');
  state.guildId = guild.id;
  try {
    await ensurePlayer(guild, state.pinnedVoiceId, payload.channel_id);
  } catch (error) {
    console.warn(`[music-worker ${WORKER_ID}] Pin connect failed:`, error?.message || error);
  }
  scheduleEmptyLeave(guild);
  await publishStatus(guild).catch(() => {});
}

async function handleUnpin(guild) {
  state.pinnedVoiceId = null;
  await disconnectVoice(guild, 'UNPINNED').catch(() => {});
  await publishStatus(guild).catch(() => {});
}

async function processRequest(message, parsed) {
  const payload = parsed.payload || {};
  const requestId = String(payload.request_id || message.id);
  if (seenRequests.has(requestId)) return;
  if (Number(payload.expires_at) && Date.now() > Number(payload.expires_at) + REQUEST_TTL_MS) return;
  seenRequests.add(requestId);
  if (seenRequests.size > 500) {
    for (const value of [...seenRequests].slice(0, 250)) seenRequests.delete(value);
  }

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
    console.warn(`[music-worker ${WORKER_ID}] Request failed:`, error?.message || error);
    await emitEvent(guild, { ...payload, code: 'error', reason: safeText(error?.message || error, 120) });
  }
}

async function bootstrapGuild(guild) {
  const channel = await dataChannel(guild);
  if (!channel) return false;
  state.guildId = guild.id;

  const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (batch) {
    const pin = batch.find((item) => {
      const parsed = parseRecord(item.content);
      return parsed?.type === 'PIN' && parsed.id === WORKER_ID;
    });
    if (pin) {
      const parsed = parseRecord(pin.content);
      state.pinnedVoiceId = parsed?.payload?.voice_id ? String(parsed.payload.voice_id) : null;
    }
  }
  await publishStatus(guild);
  return true;
}

async function initialize() {
  console.log(`[music-worker ${WORKER_ID}] Logged in as ${client.user.tag}`);
  if (lavalink) {
    try {
      await lavalink.init({ id: client.user.id, username: client.user.username });
      console.log(`[music-worker ${WORKER_ID}] Lavalink manager initialized.`);
    } catch (error) {
      state.backendReady = false;
      console.warn(`[music-worker ${WORKER_ID}] Lavalink init failed:`, error?.message || error);
    }
  }

  for (const guild of client.guilds.cache.values()) {
    let ready = await bootstrapGuild(guild).catch(() => false);
    if (!ready) {
      const retry = setInterval(async () => {
        ready = await bootstrapGuild(guild).catch(() => false);
        if (ready) clearInterval(retry);
      }, 10_000);
      retry.unref?.();
    }
  }

  state.heartbeatTimer = setInterval(() => {
    for (const guild of client.guilds.cache.values()) publishStatus(guild).catch(() => {});
  }, HEARTBEAT_MS);
  state.heartbeatTimer.unref?.();
}

client.once('ready', () => initialize().catch((error) => {
  console.error(`[music-worker ${WORKER_ID}] Initialization failed:`, error);
}));

client.on('messageCreate', (message) => {
  if (message.channel?.name !== DATA_CHANNEL_NAME) return;
  const parsed = parseRecord(message.content);
  if (parsed?.type !== 'REQ' || parsed.id !== WORKER_ID) return;
  processRequest(message, parsed).catch(() => {});
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = oldState.guild || newState.guild;
  if (!guild) return;

  // If our own bot was removed externally, keep Lavalink state consistent.
  if (newState.id === client.user?.id && oldState.channelId && !newState.channelId) {
    clearEmptyTimer();
    const player = currentPlayer(guild.id);
    if (player) player.destroy('DISCORD_VOICE_DISCONNECT', true).catch(() => {});
    state.currentTitle = null;
    publishStatus(guild).catch(() => {});
    return;
  }

  const activeVoice = actualVoiceId(guild);
  if (!activeVoice) return;
  if (String(oldState.channelId || '') !== String(activeVoice)
      && String(newState.channelId || '') !== String(activeVoice)) return;
  scheduleEmptyLeave(guild);
});

client.on('guildCreate', (guild) => bootstrapGuild(guild).catch(() => {}));

client.login(TOKEN).catch((error) => {
  console.error(`[music-worker ${WORKER_ID}] Login failed:`, error);
  process.exitCode = 1;
});
