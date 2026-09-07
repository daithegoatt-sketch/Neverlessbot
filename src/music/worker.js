'use strict';

const {
  Client,
  GatewayIntentBits,
} = require('discord.js');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const play = require('@iamtraction/play-dl');
const {
  DATA_CHANNEL_NAME,
  record,
  parseRecord,
} = require('./protocol');

const WORKER_ID = String(process.env.MUSIC_WORKER_ID || '').trim();
const TOKEN = process.env.DISCORD_TOKEN;
const HEARTBEAT_MS = 10_000;
const REQUEST_TTL_MS = 45_000;

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

const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
const state = {
  guildId: null,
  voiceId: null,
  pinnedVoiceId: null,
  connection: null,
  current: null,
  queue: [],
  volume: 100,
  statusMessageId: null,
  heartbeatTimer: null,
  startedAt: Date.now(),
};
const seenRequests = new Set();
let advancing = false;

function safeText(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function dataChannel(guild) {
  let channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  if (!channel) {
    await guild.channels.fetch().catch(() => null);
    channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  }
  return channel;
}

function statusPayload() {
  return {
    bot_id: client.user?.id || null,
    guild_id: state.guildId,
    voice_id: state.voiceId,
    pinned_voice_id: state.pinnedVoiceId,
    playing: Boolean(state.current),
    current_title: state.current?.title || null,
    queue_length: state.queue.length,
    volume: state.volume,
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

async function ensureConnection(guild, voiceId) {
  if (state.connection && state.guildId === guild.id && state.voiceId === voiceId) return state.connection;
  if (state.connection) {
    try { state.connection.destroy(); } catch {}
    state.connection = null;
  }
  const channel = guild.channels.cache.get(voiceId) || await guild.channels.fetch(voiceId).catch(() => null);
  if (!channel?.isVoiceBased?.()) throw new Error('VOICE_CHANNEL_NOT_FOUND');
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  connection.subscribe(player);
  state.connection = connection;
  state.guildId = guild.id;
  state.voiceId = channel.id;
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      if (state.connection === connection) {
        try { connection.destroy(); } catch {}
        state.connection = null;
        state.voiceId = null;
        state.current = null;
        state.queue = [];
      }
    }
  });
  await publishStatus(guild).catch(() => {});
  return connection;
}

async function resolveTrack(query) {
  const wanted = safeText(query, 400);
  if (!wanted) return null;

  try {
    const type = await play.validate(wanted);
    if (type === 'yt_video') {
      const info = await play.video_basic_info(wanted);
      return {
        title: safeText(info.video_details?.title || wanted, 180),
        url: info.video_details?.url || wanted,
      };
    }
    if (type === 'so_track') {
      const info = await play.soundcloud(wanted);
      return {
        title: safeText(info.name || wanted, 180),
        url: info.url || wanted,
      };
    }
  } catch {}

  const results = await play.search(wanted, { limit: 1, source: { youtube: 'video' } }).catch(() => []);
  const result = results?.[0];
  if (!result?.url) return null;
  return { title: safeText(result.title || wanted, 180), url: result.url };
}

async function streamTrack(track) {
  const source = await play.stream(track.url, { quality: 2 });
  const resource = createAudioResource(source.stream, {
    inputType: source.type,
    inlineVolume: true,
    metadata: track,
  });
  if (resource.volume) resource.volume.setVolume(state.volume / 100);
  return resource;
}

async function startTrack(guild, track) {
  await ensureConnection(guild, state.voiceId);
  const resource = await streamTrack(track);
  state.current = track;
  player.play(resource);
  await publishStatus(guild).catch(() => {});
}

async function playNext() {
  if (advancing) return;
  advancing = true;
  try {
    const guild = state.guildId ? client.guilds.cache.get(state.guildId) : null;
    if (!guild) {
      state.current = null;
      return;
    }
    const next = state.queue.shift() || null;
    if (!next) {
      state.current = null;
      if (!state.pinnedVoiceId) {
        const connection = state.connection;
        state.connection = null;
        state.voiceId = null;
        try { connection?.destroy(); } catch {}
      }
      await publishStatus(guild).catch(() => {});
      return;
    }
    state.voiceId = next.voiceId;
    await ensureConnection(guild, next.voiceId);
    await startTrack(guild, next.track);
  } catch (error) {
    console.warn(`[music-worker ${WORKER_ID}] Next track failed:`, error.message);
    state.current = null;
    setTimeout(() => playNext().catch(() => {}), 100).unref?.();
  } finally {
    advancing = false;
  }
}

player.on(AudioPlayerStatus.Idle, () => {
  if (!state.current) return;
  state.current = null;
  playNext().catch(() => {});
});

player.on('error', (error) => {
  console.warn(`[music-worker ${WORKER_ID}] Player error:`, error.message);
  state.current = null;
  playNext().catch(() => {});
});

async function handlePlay(guild, payload) {
  const track = await resolveTrack(payload.query);
  if (!track) {
    await emitEvent(guild, { ...payload, code: 'not_found' });
    return;
  }

  const sameVoice = !state.voiceId || String(state.voiceId) === String(payload.voice_id);
  if (!sameVoice) {
    await emitEvent(guild, { ...payload, code: 'error', reason: 'WORKER_BUSY_OTHER_VOICE' });
    return;
  }

  await ensureConnection(guild, payload.voice_id);
  if (state.current || player.state.status !== AudioPlayerStatus.Idle) {
    state.queue.push({ track, voiceId: payload.voice_id });
    await publishStatus(guild).catch(() => {});
    await emitEvent(guild, { ...payload, code: 'queued', title: track.title });
    return;
  }

  state.voiceId = payload.voice_id;
  await startTrack(guild, track);
  await emitEvent(guild, { ...payload, code: 'playing', title: track.title });
}

async function handleSkip(guild, payload) {
  if (!state.current && !state.queue.length) {
    await emitEvent(guild, { ...payload, code: 'not_playing' });
    return;
  }
  const nextTitle = state.queue[0]?.track?.title || null;
  player.stop(true);
  await emitEvent(guild, { ...payload, code: 'skipped', next_title: nextTitle });
}

async function handleStop(guild, payload) {
  if (!state.current && !state.queue.length) {
    await emitEvent(guild, { ...payload, code: 'not_playing' });
    return;
  }
  state.queue = [];
  state.current = null;
  player.stop(true);
  if (!state.pinnedVoiceId) {
    const connection = state.connection;
    state.connection = null;
    state.voiceId = null;
    try { connection?.destroy(); } catch {}
  }
  await publishStatus(guild).catch(() => {});
  await emitEvent(guild, { ...payload, code: 'stopped' });
}

async function handleVolume(guild, payload) {
  const value = Math.max(0, Math.min(200, Number(payload.value) || 0));
  state.volume = value;
  const resource = player.state?.resource;
  if (resource?.volume) resource.volume.setVolume(value / 100);
  await publishStatus(guild).catch(() => {});
  await emitEvent(guild, { ...payload, code: 'volume', value });
}

async function handlePin(guild, payload) {
  if (state.current && state.voiceId && String(state.voiceId) !== String(payload.voice_id)) return;
  state.pinnedVoiceId = String(payload.voice_id);
  state.voiceId = String(payload.voice_id);
  await ensureConnection(guild, state.voiceId);
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

  const guild = client.guilds.cache.get(payload.guild_id) || null;
  if (!guild) return;
  try {
    if (payload.action === 'play') await handlePlay(guild, payload);
    else if (payload.action === 'skip') await handleSkip(guild, payload);
    else if (payload.action === 'stop') await handleStop(guild, payload);
    else if (payload.action === 'volume') await handleVolume(guild, payload);
    else if (payload.action === 'pin') await handlePin(guild, payload);
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
      if (parsed?.payload?.voice_id) {
        state.pinnedVoiceId = String(parsed.payload.voice_id);
        state.voiceId = state.pinnedVoiceId;
        await ensureConnection(guild, state.pinnedVoiceId).catch(() => {});
      }
    }
  }
  await publishStatus(guild);
  return true;
}

async function initialize() {
  console.log(`[music-worker ${WORKER_ID}] Logged in as ${client.user.tag}`);
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

client.on('guildCreate', (guild) => bootstrapGuild(guild).catch(() => {}));

client.login(TOKEN).catch((error) => {
  console.error(`[music-worker ${WORKER_ID}] Login failed:`, error);
  process.exitCode = 1;
});
