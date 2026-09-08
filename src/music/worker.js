'use strict';

const {
  Client,
  GatewayIntentBits,
} = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const {
  DATA_CHANNEL_NAME,
  record,
  parseRecord,
} = require('./protocol');

const WORKER_ID = String(process.env.MUSIC_WORKER_ID || '').trim();
const TOKEN = process.env.DISCORD_TOKEN;
const LAVALINK_HOST = String(process.env.LAVALINK_HOST || '').trim();
const LAVALINK_PORT = Math.max(1, Number(process.env.LAVALINK_PORT || 2333));
const LAVALINK_PASSWORD = String(process.env.LAVALINK_PASSWORD || '').trim();
const LAVALINK_SECURE = /^(?:1|true|yes)$/i.test(String(process.env.LAVALINK_SECURE || 'false'));
const HEARTBEAT_MS = 10_000;
const REQUEST_TTL_MS = 45_000;
const EMPTY_LEAVE_MS = 5_000;

if (!TOKEN) {
  console.error('[music-worker] Missing DISCORD_TOKEN.');
  process.exit(1);
}
if (!/^[123]$/.test(WORKER_ID)) {
  console.error('[music-worker] MUSIC_WORKER_ID must be 1, 2, or 3.');
  process.exit(1);
}

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
  voiceId: null,
  pinnedVoiceId: null,
  currentTitle: null,
  volume: 100,
  statusMessageId: null,
  heartbeatTimer: null,
  emptyLeaveTimer: null,
  startedAt: Date.now(),
  backendReady: false,
};

const seenRequests = new Set();
const lavalinkConfigured = Boolean(LAVALINK_HOST && LAVALINK_PASSWORD);
let lavalink = null;

function safeText(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function currentPlayer(guildId = state.guildId) {
  if (!lavalink || !guildId) return null;
  return lavalink.getPlayer(String(guildId)) || null;
}

function playerQueueLength(player) {
  return Array.isArray(player?.queue?.tracks) ? player.queue.tracks.length : 0;
}

function currentTrackTitle(player) {
  return safeText(
    player?.queue?.current?.info?.title
      || player?.queue?.current?.title
      || state.currentTitle
      || '',
    180,
  ) || null;
}

function backendUsable() {
  return Boolean(lavalink && state.backendReady && lavalink.useable);
}

function setupLavalink() {
  if (!lavalinkConfigured) {
    console.warn(`[music-worker ${WORKER_ID}] Lavalink is not configured yet. Set LAVALINK_HOST and LAVALINK_PASSWORD.`);
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
    client: {
      id: 'pending',
      username: `Neverless Music ${WORKER_ID}`,
    },
    playerOptions: {
      defaultSearchPlatform: 'ytsearch',
      applyVolumeAsFilter: false,
      onDisconnect: {
        autoReconnect: true,
        destroyPlayer: false,
      },
      onEmptyQueue: {
        destroyAfterMs: 0,
      },
    },
  });

  manager.nodeManager.on('connect', (node) => {
    state.backendReady = true;
    console.log(`[music-worker ${WORKER_ID}] Lavalink node connected: ${node.id}`);
    for (const guild of client.guilds.cache.values()) publishStatus(guild).catch(() => {});
  });
  manager.nodeManager.on('disconnect', (node, reason) => {
    state.backendReady = false;
    console.warn(`[music-worker ${WORKER_ID}] Lavalink node disconnected: ${node.id}`, reason || '');
    for (const guild of client.guilds.cache.values()) publishStatus(guild).catch(() => {});
  });
  manager.nodeManager.on('error', (node, error) => {
    state.backendReady = false;
    console.warn(`[music-worker ${WORKER_ID}] Lavalink node error (${node.id}):`, error?.message || error);
  });

  manager.on('trackStart', (player, track) => {
    if (String(player.guildId) !== String(state.guildId)) return;
    state.currentTitle = safeText(track?.info?.title || track?.title || 'الأغنية', 180);
    state.voiceId = player.voiceChannelId || state.voiceId;
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) publishStatus(guild).catch(() => {});
  });

  manager.on('trackEnd', (player) => {
    if (String(player.guildId) !== String(state.guildId)) return;
    state.currentTitle = currentTrackTitle(player);
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) publishStatus(guild).catch(() => {});
  });

  manager.on('trackError', (player, track, payload) => {
    console.warn(`[music-worker ${WORKER_ID}] Lavalink track error:`, payload?.exception?.message || payload?.message || track?.info?.title || 'unknown');
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) publishStatus(guild).catch(() => {});
  });

  manager.on('trackStuck', (player, track, payload) => {
    console.warn(`[music-worker ${WORKER_ID}] Lavalink track stuck:`, payload?.thresholdMs || track?.info?.title || 'unknown');
    const guild = client.guilds.cache.get(String(player.guildId));
    if (guild) publishStatus(guild).catch(() => {});
  });

  manager.on('queueEnd', async (player) => {
    if (String(player.guildId) !== String(state.guildId)) return;
    state.currentTitle = null;
    const guild = client.guilds.cache.get(String(player.guildId));
    if (!guild) return;
    if (!state.pinnedVoiceId) await disconnectVoice(guild, 'QUEUE_ENDED').catch(() => {});
    else scheduleEmptyLeave(guild);
    await publishStatus(guild).catch(() => {});
  });

  return manager;
}

lavalink = setupLavalink();
client.on('raw', (packet) => {
  try { lavalink?.sendRawData(packet); } catch {}
});

async function dataChannel(guild) {
  let channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  if (!channel) {
    await guild.channels.fetch().catch(() => null);
    channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  }
  return channel;
}

function statusPayload() {
  const player = currentPlayer();
  return {
    bot_id: client.user?.id || null,
    guild_id: state.guildId,
    voice_id: state.voiceId,
    pinned_voice_id: state.pinnedVoiceId,
    playing: Boolean(player?.playing || player?.queue?.current || state.currentTitle),
    current_title: currentTrackTitle(player),
    queue_length: playerQueueLength(player),
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
  const content = record('STATUS', WORKER_ID, statusPayload());
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
  const eventId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = record('EVENT', eventId, {
    worker_id: WORKER_ID,
    ...payload,
  });
  if (content.length > 1950) return;
  await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

function voiceHasHuman(guild, voiceId) {
  if (!voiceId) return false;
  const channel = guild.channels.cache.get(String(voiceId));
  if (!channel?.isVoiceBased?.()) return false;
  return [...channel.members.values()].some((member) => !member.user?.bot);
}

function clearEmptyLeaveTimer() {
  if (state.emptyLeaveTimer) clearTimeout(state.emptyLeaveTimer);
  state.emptyLeaveTimer = null;
}

function scheduleEmptyLeave(guild) {
  clearEmptyLeaveTimer();
  if (!state.voiceId || voiceHasHuman(guild, state.voiceId)) return;
  const expectedVoiceId = String(state.voiceId);
  state.emptyLeaveTimer = setTimeout(async () => {
    state.emptyLeaveTimer = null;
    if (String(state.voiceId || '') !== expectedVoiceId) return;
    if (voiceHasHuman(guild, expectedVoiceId)) return;
    await disconnectVoice(guild, 'EMPTY_VOICE_5S').catch(() => {});
    await publishStatus(guild).catch(() => {});
  }, EMPTY_LEAVE_MS);
  state.emptyLeaveTimer.unref?.();
}

async function disconnectVoice(guild, reason = 'DISCONNECT') {
  clearEmptyLeaveTimer();
  const player = currentPlayer(guild.id);
  if (player) {
    try { await player.destroy(reason, true); } catch {}
  }
  state.voiceId = null;
  state.currentTitle = null;
}

async function ensurePlayer(guild, voiceId, textChannelId = null) {
  if (!backendUsable()) {
    throw new Error(lavalinkConfigured ? 'LAVALINK_UNAVAILABLE' : 'LAVALINK_NOT_CONFIGURED');
  }

  let player = currentPlayer(guild.id);
  if (player && player.voiceChannelId && String(player.voiceChannelId) !== String(voiceId)) {
    try { await player.destroy('MOVE_VOICE', true); } catch {}
    player = null;
  }

  if (!player) {
    player = lavalink.createPlayer({
      guildId: guild.id,
      voiceChannelId: String(voiceId),
      textChannelId: textChannelId ? String(textChannelId) : null,
      volume: state.volume,
      selfDeaf: true,
      selfMute: false,
    });
  } else if (String(player.voiceChannelId || '') !== String(voiceId)) {
    await player.changeVoiceState({ voiceChannelId: String(voiceId), selfDeaf: true, selfMute: false });
  }

  if (!player.connected) await player.connect();
  state.guildId = guild.id;
  state.voiceId = String(voiceId);
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
  const requestUser = { id: String(requesterId || 'unknown') };
  const looksLikeUrl = /^https?:\/\//i.test(wanted);
  const search = await player.search(
    looksLikeUrl ? { query: wanted } : { query: wanted, source: 'ytsearch' },
    requestUser,
    false,
  );
  return Array.isArray(search?.tracks) && search.tracks.length ? search.tracks[0] : null;
}

async function handlePlay(guild, payload) {
  const sameVoice = !state.voiceId || String(state.voiceId) === String(payload.voice_id);
  if (!sameVoice) {
    await emitEvent(guild, { ...payload, code: 'error', reason: 'WORKER_BUSY_OTHER_VOICE' });
    return;
  }

  let player;
  try {
    player = await ensurePlayer(guild, payload.voice_id, payload.channel_id);
  } catch (error) {
    await emitEvent(guild, {
      ...payload,
      code: 'error',
      reason: safeText(error.message, 120),
    });
    return;
  }

  let track;
  try {
    track = await findTrack(player, payload.query, payload.user_id);
  } catch (error) {
    console.warn(`[music-worker ${WORKER_ID}] Lavalink search failed:`, error.message);
    await emitEvent(guild, { ...payload, code: 'error', reason: safeText(error.message, 120) });
    return;
  }

  if (!track) {
    await emitEvent(guild, { ...payload, code: 'not_found' });
    return;
  }

  const wasBusy = Boolean(player.playing || player.queue?.current || playerQueueLength(player));
  await player.queue.add(track);
  const title = trackTitle(track, payload.query);

  if (wasBusy) {
    await publishStatus(guild).catch(() => {});
    await emitEvent(guild, { ...payload, code: 'queued', title });
    return;
  }

  try {
    await player.play();
    state.currentTitle = title;
    await publishStatus(guild).catch(() => {});
    await emitEvent(guild, { ...payload, code: 'playing', title });
  } catch (error) {
    state.currentTitle = null;
    console.warn(`[music-worker ${WORKER_ID}] Lavalink play failed:`, error.message);
    await emitEvent(guild, {
      ...payload,
      code: 'error',
      reason: safeText(error.message, 120),
      title,
    });
  }
}

async function handleSkip(guild, payload) {
  const player = currentPlayer(guild.id);
  if (!player || (!player.playing && !player.queue?.current && !playerQueueLength(player))) {
    await emitEvent(guild, { ...payload, code: 'not_playing' });
    return;
  }
  const nextTitle = trackTitle(player.queue?.tracks?.[0], '') || null;
  await player.skip(0, false).catch(() => player.stopPlaying(false, false));
  await emitEvent(guild, { ...payload, code: 'skipped', next_title: nextTitle });
  await publishStatus(guild).catch(() => {});
}

async function handleStop(guild, payload) {
  const player = currentPlayer(guild.id);
  if (!player || (!player.playing && !player.queue?.current && !playerQueueLength(player))) {
    await emitEvent(guild, { ...payload, code: 'not_playing' });
    return;
  }
  await player.stopPlaying(true, false).catch(() => {});
  state.currentTitle = null;
  if (!state.pinnedVoiceId) await disconnectVoice(guild, 'STOPPED').catch(() => {});
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
  if (state.currentTitle && state.voiceId && String(state.voiceId) !== String(payload.voice_id)) return;
  state.pinnedVoiceId = String(payload.voice_id);
  state.guildId = guild.id;
  try {
    await ensurePlayer(guild, state.pinnedVoiceId, payload.channel_id);
  } catch (error) {
    console.warn(`[music-worker ${WORKER_ID}] Pin waiting for Lavalink:`, error.message);
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

  const guild = client.guilds.cache.get(String(payload.guild_id)) || null;
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
  const channel = await dataChannel(guild);
  if (!channel) {
    console.warn(`[music-worker ${WORKER_ID}] neverless-data is not visible yet; waiting for controller permissions.`);
    return false;
  }

  state.guildId = guild.id;
  const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (batch) {
    const pin = batch.find((item) => {
      const parsed = parseRecord(item.content);
      return parsed?.type === 'PIN' && parsed.id === WORKER_ID;
    });
    if (pin) {
      const parsed = parseRecord(pin.content);
      const voiceId = parsed?.payload?.voice_id ? String(parsed.payload.voice_id) : null;
      state.pinnedVoiceId = voiceId;
      if (voiceId && backendUsable()) {
        await ensurePlayer(guild, voiceId, null).catch((error) => {
          console.warn(`[music-worker ${WORKER_ID}] Could not restore pin yet:`, error.message);
        });
      }
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
      console.warn(`[music-worker ${WORKER_ID}] Lavalink init failed; worker stays online:`, error.message);
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
  const activeVoiceId = state.voiceId;
  if (!activeVoiceId) return;
  if (String(oldState.channelId || '') !== String(activeVoiceId)
      && String(newState.channelId || '') !== String(activeVoiceId)) return;
  const guild = oldState.guild || newState.guild;
  if (guild) scheduleEmptyLeave(guild);
});

client.on('guildCreate', (guild) => bootstrapGuild(guild).catch(() => {}));

client.login(TOKEN).catch((error) => {
  console.error(`[music-worker ${WORKER_ID}] Login failed:`, error);
  process.exitCode = 1;
});
