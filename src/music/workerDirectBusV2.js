'use strict';

const { Client, GatewayIntentBits } = require('discord.js');
const { Readable } = require('node:stream');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} = require('@discordjs/voice');
const play = require('@iamtraction/play-dl');
const { DATA_CHANNEL_NAME, record, parseRecord } = require('./protocol');

const TOKEN = String(process.env.DISCORD_TOKEN || '').trim();
const WORKER_ID = String(process.env.MUSIC_WORKER_ID || '').trim();
const YOUTUBE_COOKIE = String(process.env.YOUTUBE_COOKIE || '').trim();
const HEARTBEAT_MS = 10_000;
const EMPTY_LEAVE_MS = Math.max(5_000, Number(process.env.MUSIC_EMPTY_LEAVE_MS || 10_000));
const REQUEST_TTL_MS = 45_000;
const MAX_QUERY_LENGTH = 300;
const SOURCE_ORDER = String(process.env.MUSIC_SOURCE_ORDER || 'soundcloud,youtube')
  .split(',').map((x) => x.trim().toLowerCase()).filter((x) => ['soundcloud', 'youtube'].includes(x));
if (!SOURCE_ORDER.length) SOURCE_ORDER.push('soundcloud', 'youtube');

if (!TOKEN) throw new Error('MUSIC_MISSING_DISCORD_TOKEN');
if (!/^[123]$/.test(WORKER_ID)) throw new Error('MUSIC_WORKER_ID must be 1, 2, or 3');

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
] });

const guildStates = new Map();
const seenRequests = new Set();
let youtubePromise = null;

function clean(value, max = 180) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }

function stateFor(guildId) {
  const key = String(guildId);
  let state = guildStates.get(key);
  if (state) return state;
  state = {
    guildId: key,
    voiceId: null,
    textId: null,
    current: null,
    queue: [],
    volume: 100,
    connection: null,
    subscription: null,
    statusMessageId: null,
    emptyTimer: null,
    pinnedVoiceId: null,
    advancing: false,
    player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
  };
  installPlayerEvents(state);
  guildStates.set(key, state);
  return state;
}

async function getYoutube() {
  if (youtubePromise) return youtubePromise;
  youtubePromise = (async () => {
    const mod = await import('youtubei.js');
    const Innertube = mod.Innertube || mod.default;
    const Platform = mod.Platform;
    if (!Innertube?.create) throw new Error('YOUTUBEJS_INNERTUBE_MISSING');
    if (Platform?.shim) Platform.shim.eval = async (data) => new Function(data.output)();
    const options = { generate_session_locally: true };
    if (YOUTUBE_COOKIE) options.cookie = YOUTUBE_COOKIE;
    const yt = await Innertube.create(options);
    console.log(`[music-worker-v2 ${WORKER_ID}] YouTube.js metadata session ready${YOUTUBE_COOKIE ? ' with cookie' : ''}.`);
    return yt;
  })().catch((error) => { youtubePromise = null; throw error; });
  return youtubePromise;
}

async function dataChannel(guild) {
  let channel = guild.channels.cache.find((c) => c.name === DATA_CHANNEL_NAME && c.isTextBased?.()) || null;
  if (!channel) {
    await guild.channels.fetch().catch(() => null);
    channel = guild.channels.cache.find((c) => c.name === DATA_CHANNEL_NAME && c.isTextBased?.()) || null;
  }
  return channel;
}

function statusPayload(state) {
  return {
    bot_id: client.user?.id || null,
    guild_id: state.guildId,
    voice_id: state.voiceId,
    pinned_voice_id: state.pinnedVoiceId,
    playing: Boolean(state.current || state.queue.length || state.player.state.status === AudioPlayerStatus.Playing || state.player.state.status === AudioPlayerStatus.Buffering),
    current_title: state.current?.title || null,
    queue_length: state.queue.length,
    volume: state.volume,
    backend: 'direct-bus-soundcloud-youtube',
    backend_ready: true,
    heartbeat_at: Date.now(),
    worker_id: WORKER_ID,
  };
}

async function publishStatus(guild) {
  const state = stateFor(guild.id);
  const channel = await dataChannel(guild);
  if (!channel) return false;
  const content = record('STATUS', WORKER_ID, statusPayload(state));
  let message = state.statusMessageId ? await channel.messages.fetch(state.statusMessageId).catch(() => null) : null;
  if (!message) {
    const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (batch) message = batch.find((item) => {
      const parsed = parseRecord(item.content);
      return item.author?.id === client.user?.id && parsed?.type === 'STATUS' && String(parsed.id) === WORKER_ID;
    }) || null;
  }
  if (message) {
    state.statusMessageId = message.id;
    await message.edit({ content, allowedMentions: { parse: [] } }).catch(() => null);
    return true;
  }
  message = await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
  if (message) state.statusMessageId = message.id;
  return Boolean(message);
}

async function emitEvent(guild, payload) {
  const channel = await dataChannel(guild);
  if (!channel) return;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = record('EVENT', id, { worker_id: WORKER_ID, ...payload });
  if (content.length <= 1950) await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

function clearEmptyTimer(state) {
  if (state.emptyTimer) clearTimeout(state.emptyTimer);
  state.emptyTimer = null;
}

function humansInVoice(guild, voiceId) {
  const channel = guild.channels.cache.get(String(voiceId || ''));
  if (!channel?.isVoiceBased?.()) return 0;
  return [...channel.members.values()].filter((member) => !member.user?.bot).length;
}

async function hardResetVoice(guild, state, reason = 'RESET', alreadyDisconnected = false) {
  clearEmptyTimer(state);
  state.queue = [];
  state.current = null;
  try { state.player.stop(true); } catch {}
  const connection = state.connection || getVoiceConnection(guild.id);
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    try { connection.destroy(!alreadyDisconnected); } catch {}
  }
  state.connection = null;
  state.subscription = null;
  state.voiceId = null;
  state.pinnedVoiceId = null;
  console.log(`[music-worker-v2 ${WORKER_ID}] voice reset (${reason}) guild=${guild.id}`);
  await publishStatus(guild).catch(() => false);
}

function scheduleEmptyLeave(guild, state) {
  clearEmptyTimer(state);
  if (!state.voiceId || state.pinnedVoiceId || humansInVoice(guild, state.voiceId) > 0) return;
  const expected = String(state.voiceId);
  state.emptyTimer = setTimeout(async () => {
    state.emptyTimer = null;
    if (String(state.voiceId || '') !== expected) return;
    if (state.pinnedVoiceId || humansInVoice(guild, expected) > 0) return;
    await hardResetVoice(guild, state, 'EMPTY_VOICE').catch(() => {});
  }, EMPTY_LEAVE_MS);
  state.emptyTimer.unref?.();
}

async function ensureVoice(state, guild, voiceId) {
  const channel = guild.channels.cache.get(String(voiceId)) || await guild.channels.fetch(String(voiceId)).catch(() => null);
  if (!channel?.isVoiceBased?.()) throw new Error('VOICE_CHANNEL_NOT_FOUND');
  clearEmptyTimer(state);
  let connection = state.connection || getVoiceConnection(guild.id);
  if (connection && connection.state.status === VoiceConnectionStatus.Destroyed) connection = null;
  if (connection && String(state.voiceId || '') !== String(voiceId)) {
    try { connection.destroy(); } catch {}
    connection = null;
  }
  if (!connection) connection = joinVoiceChannel({
    channelId: String(voiceId),
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });
  state.voiceId = String(voiceId);
  state.connection = connection;
  state.subscription = connection.subscribe(state.player);
  if (!connection.__neverlessBusHooks) {
    connection.__neverlessBusHooks = true;
    connection.on('error', (error) => console.warn(`[music-worker-v2 ${WORKER_ID}] voice error:`, error?.message || error));
  }
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (error) {
    await hardResetVoice(guild, state, 'VOICE_NOT_READY').catch(() => {});
    throw new Error(`VOICE_NOT_READY: ${error.message}`);
  }
  scheduleEmptyLeave(guild, state);
  await publishStatus(guild).catch(() => false);
  return connection;
}

function isSoundCloudUrl(value) {
  try { return /(^|\.)soundcloud\.com$/i.test(new URL(String(value)).hostname); } catch { return false; }
}

function youtubeIdFrom(value) {
  const text = String(value || '').trim();
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/i,
    /[?&]v=([A-Za-z0-9_-]{11})/i,
    /youtube\.com\/(?:shorts|live)\/([A-Za-z0-9_-]{11})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return /^[A-Za-z0-9_-]{11}$/.test(text) ? text : null;
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.toString === 'function') return value.toString();
  return '';
}

async function soundCloudCandidate(query) {
  const wanted = clean(query, MAX_QUERY_LENGTH);
  if (!wanted) return null;
  if (isSoundCloudUrl(wanted)) return { kind: 'soundcloud', source: 'SoundCloud', url: wanted, title: wanted };
  const results = await play.search(wanted, { limit: 5, source: { soundcloud: 'tracks' } });
  const first = (results || []).find((item) => item?.url) || null;
  if (!first) return null;
  return {
    kind: 'soundcloud', source: 'SoundCloud', url: String(first.url),
    title: clean(first.name || first.title || wanted, 180),
  };
}

async function youtubeCandidate(query) {
  const wanted = clean(query, MAX_QUERY_LENGTH);
  if (!wanted) return null;
  const yt = await getYoutube();
  let videoId = youtubeIdFrom(wanted);
  let title = wanted;
  if (!videoId) {
    let first = null;
    try {
      const music = await yt.music.search(wanted, { type: 'song' });
      first = music?.songs?.contents?.find((item) => item?.id || item?.video_id) || null;
    } catch {}
    if (!first) {
      const search = await yt.search(wanted, { type: 'video' });
      first = [...(search?.videos || [])].find((video) => (video.video_id || video.id) && !video.is_live && !video.is_upcoming) || null;
    }
    if (!first) return null;
    videoId = String(first.video_id || first.id);
    title = clean(textOf(first.title) || wanted, 180);
  } else {
    try {
      const info = await yt.getBasicInfo(videoId);
      title = clean(textOf(info?.basic_info?.title) || textOf(info?.title) || wanted, 180);
    } catch {}
  }
  return { kind: 'youtube', source: 'YouTube', videoId, title };
}

async function resolveTrack(query) {
  const wanted = clean(query, MAX_QUERY_LENGTH);
  if (!wanted) return null;
  const candidates = [];
  const errors = [];
  const explicitSoundCloud = isSoundCloudUrl(wanted);
  const explicitYoutube = Boolean(youtubeIdFrom(wanted));
  const order = explicitSoundCloud ? ['soundcloud'] : explicitYoutube ? ['youtube', 'soundcloud'] : SOURCE_ORDER;
  let ytTitle = null;

  for (const source of order) {
    try {
      let candidate = null;
      if (source === 'soundcloud') candidate = await soundCloudCandidate(ytTitle || wanted);
      else {
        candidate = await youtubeCandidate(wanted);
        ytTitle = candidate?.title || null;
      }
      if (candidate && !candidates.some((row) => row.kind === candidate.kind && (row.url || row.videoId) === (candidate.url || candidate.videoId))) candidates.push(candidate);
    } catch (error) {
      errors.push(`${source}:${clean(error?.message || error, 100)}`);
    }
  }

  if (explicitYoutube && ytTitle && !candidates.some((row) => row.kind === 'soundcloud')) {
    try {
      const fallback = await soundCloudCandidate(ytTitle);
      if (fallback) candidates.push(fallback);
    } catch (error) {
      errors.push(`soundcloud:${clean(error?.message || error, 100)}`);
    }
  }
  if (!candidates.length) throw new Error(`NO_PLAYABLE_SOURCE_SEARCH: ${errors.join(' | ') || 'NO_RESULTS'}`);
  return { query: wanted, title: candidates[0].title || wanted, candidates };
}

async function resourceFromSoundCloud(candidate, volume) {
  const source = await play.stream(candidate.url);
  if (!source?.stream) throw new Error('SOUNDCLOUD_NO_STREAM');
  const resource = createAudioResource(source.stream, {
    inputType: source.type || StreamType.Arbitrary,
    inlineVolume: true,
    metadata: candidate,
  });
  resource.volume?.setVolume(Math.max(0, Math.min(2, Number(volume) / 100)));
  return resource;
}

async function resourceFromYoutube(candidate, volume) {
  const yt = await getYoutube();
  const webStream = await yt.download(candidate.videoId, { type: 'audio', quality: 'best', format: 'webm', codec: 'opus' });
  if (!webStream) throw new Error('YOUTUBE_NO_STREAM');
  const nodeStream = typeof Readable.fromWeb === 'function' ? Readable.fromWeb(webStream) : Readable.from(webStream);
  const resource = createAudioResource(nodeStream, { inputType: StreamType.WebmOpus, inlineVolume: true, metadata: candidate });
  resource.volume?.setVolume(Math.max(0, Math.min(2, Number(volume) / 100)));
  return resource;
}

async function createTrackResource(track, volume) {
  const errors = [];
  for (const candidate of track.candidates || []) {
    try {
      const resource = candidate.kind === 'soundcloud'
        ? await resourceFromSoundCloud(candidate, volume)
        : await resourceFromYoutube(candidate, volume);
      track.title = candidate.title || track.title;
      track.source = candidate.source;
      track.activeCandidate = candidate;
      return resource;
    } catch (error) {
      const reason = clean(error?.message || error, 120);
      errors.push(`${candidate.source}:${reason}`);
      console.warn(`[music-worker-v2 ${WORKER_ID}] ${candidate.source} candidate failed: ${reason}`);
    }
  }
  throw new Error(`NO_PLAYABLE_SOURCE: ${errors.join(' | ') || 'unknown'}`);
}

async function startNext(state, guild) {
  if (state.advancing || state.current) return { status: 'busy', track: state.current };
  state.advancing = true;
  let lastError = null;
  try {
    while (state.queue.length) {
      const next = state.queue.shift();
      state.current = next;
      try {
        const resource = await createTrackResource(next, state.volume);
        state.player.play(resource);
        await entersState(state.player, AudioPlayerStatus.Playing, 20_000);
        await publishStatus(guild).catch(() => false);
        return { status: 'playing', track: next };
      } catch (error) {
        lastError = error;
        state.current = null;
        console.warn(`[music-worker-v2 ${WORKER_ID}] failed track ${next?.title || '?'}:`, error?.message || error);
      }
    }
    await publishStatus(guild).catch(() => false);
    return { status: lastError ? 'error' : 'empty', error: lastError };
  } finally {
    state.advancing = false;
  }
}

function installPlayerEvents(state) {
  state.player.on(AudioPlayerStatus.Playing, () => {
    const guild = client.guilds.cache.get(state.guildId);
    if (guild) publishStatus(guild).catch(() => false);
  });
  state.player.on(AudioPlayerStatus.Idle, () => {
    const guild = client.guilds.cache.get(state.guildId);
    if (!guild) return;
    state.current = null;
    startNext(state, guild).catch((error) => console.warn(`[music-worker-v2 ${WORKER_ID}] advance failed:`, error?.message || error));
  });
  state.player.on('error', (error) => {
    const guild = client.guilds.cache.get(state.guildId);
    console.warn(`[music-worker-v2 ${WORKER_ID}] audio player error:`, error?.message || error);
    state.current = null;
    if (guild) startNext(state, guild).catch(() => {});
  });
}

function eventBase(payload, state) {
  return {
    guild_id: payload.guild_id,
    voice_id: state.voiceId || payload.voice_id || null,
    channel_id: payload.channel_id,
    user_id: payload.user_id,
    message_id: payload.message_id,
    response_message_id: payload.response_message_id || null,
    request_id: payload.request_id || null,
  };
}

async function handleJoin(guild, payload) {
  const state = stateFor(guild.id);
  state.textId = payload.channel_id || state.textId;
  await ensureVoice(state, guild, payload.voice_id);
  await emitEvent(guild, { ...eventBase(payload, state), code: 'joined' });
}

async function handlePlay(guild, payload) {
  const state = stateFor(guild.id);
  state.textId = payload.channel_id || state.textId;
  await ensureVoice(state, guild, payload.voice_id);
  let track;
  try { track = await resolveTrack(payload.query); }
  catch (error) {
    await emitEvent(guild, { ...eventBase(payload, state), code: 'error', reason: clean(error?.message || error, 300) });
    return;
  }
  const busy = Boolean(state.current)
    || state.player.state.status === AudioPlayerStatus.Playing
    || state.player.state.status === AudioPlayerStatus.Buffering
    || state.advancing;
  state.queue.push(track);
  if (busy) {
    await publishStatus(guild).catch(() => false);
    await emitEvent(guild, { ...eventBase(payload, state), code: 'queued', title: track.title });
    return;
  }
  const result = await startNext(state, guild);
  if (result.status === 'playing') {
    await emitEvent(guild, {
      ...eventBase(payload, state), code: 'playing',
      title: result.track?.title || track.title, source: result.track?.source || null,
    });
  } else {
    await emitEvent(guild, { ...eventBase(payload, state), code: 'error', reason: clean(result.error?.message || 'PLAYBACK_START_FAILED', 300) });
  }
}

async function handleSkip(guild, payload) {
  const state = stateFor(guild.id);
  if (!state.voiceId || (!state.current && !state.queue.length && state.player.state.status === AudioPlayerStatus.Idle)) {
    await emitEvent(guild, { ...eventBase(payload, state), code: 'not_playing' });
    return;
  }
  const nextTitle = state.queue[0]?.title || null;
  state.current = null;
  state.player.stop(true);
  await emitEvent(guild, { ...eventBase(payload, state), code: 'skipped', next_title: nextTitle });
  await publishStatus(guild).catch(() => false);
}

async function handleStop(guild, payload) {
  const state = stateFor(guild.id);
  if (!state.current && !state.queue.length && state.player.state.status === AudioPlayerStatus.Idle) {
    await emitEvent(guild, { ...eventBase(payload, state), code: 'not_playing' });
    return;
  }
  state.queue = [];
  state.current = null;
  state.player.stop(true);
  scheduleEmptyLeave(guild, state);
  await publishStatus(guild).catch(() => false);
  await emitEvent(guild, { ...eventBase(payload, state), code: 'stopped' });
}

async function handleVolume(guild, payload) {
  const state = stateFor(guild.id);
  state.volume = Math.max(0, Math.min(200, Number(payload.value) || 0));
  state.player.state.resource?.volume?.setVolume(state.volume / 100);
  await publishStatus(guild).catch(() => false);
  await emitEvent(guild, { ...eventBase(payload, state), code: 'volume', value: state.volume });
}

async function handleLeave(guild, payload) {
  const state = stateFor(guild.id);
  await hardResetVoice(guild, state, 'COMMAND_LEAVE');
  await emitEvent(guild, { ...eventBase(payload, state), code: 'left', voice_id: payload.voice_id || null });
}

async function handlePin(guild, payload) {
  const state = stateFor(guild.id);
  state.pinnedVoiceId = String(payload.voice_id || '');
  await ensureVoice(state, guild, state.pinnedVoiceId);
  await publishStatus(guild).catch(() => false);
}

async function handleUnpin(guild) {
  const state = stateFor(guild.id);
  state.pinnedVoiceId = null;
  scheduleEmptyLeave(guild, state);
  await publishStatus(guild).catch(() => false);
}

async function processRequest(message, parsed) {
  const payload = parsed.payload || {};
  const requestId = String(payload.request_id || message.id);
  if (seenRequests.has(requestId)) return;
  if (Number(payload.expires_at) && Date.now() > Number(payload.expires_at) + REQUEST_TTL_MS) return;
  seenRequests.add(requestId);
  if (seenRequests.size > 500) for (const id of [...seenRequests].slice(0, 250)) seenRequests.delete(id);
  const guild = client.guilds.cache.get(String(payload.guild_id)) || null;
  if (!guild) return;
  try {
    if (payload.action === 'join') await handleJoin(guild, payload);
    else if (payload.action === 'play') await handlePlay(guild, payload);
    else if (payload.action === 'skip') await handleSkip(guild, payload);
    else if (payload.action === 'stop') await handleStop(guild, payload);
    else if (payload.action === 'volume') await handleVolume(guild, payload);
    else if (payload.action === 'leave') await handleLeave(guild, payload);
    else if (payload.action === 'pin') await handlePin(guild, payload);
    else if (payload.action === 'unpin') await handleUnpin(guild);
  } catch (error) {
    console.warn(`[music-worker-v2 ${WORKER_ID}] request ${payload.action || '?'} failed:`, error?.message || error);
    const state = stateFor(guild.id);
    await emitEvent(guild, { ...eventBase(payload, state), code: 'error', reason: clean(error?.message || error, 300) });
  }
}

async function initializeGuild(guild) {
  stateFor(guild.id);
  await publishStatus(guild).catch(() => false);
}

client.once('clientReady', async () => {
  console.log(`[music-worker-v2 ${WORKER_ID}] ${client.user.tag} online. Command input disabled; controlled by Neverless main.`);
  console.log(`[music-worker-v2 ${WORKER_ID}] Source order: ${SOURCE_ORDER.join(' -> ')}`);
  for (const guild of client.guilds.cache.values()) await initializeGuild(guild);
  const timer = setInterval(() => {
    for (const guild of client.guilds.cache.values()) publishStatus(guild).catch(() => false);
  }, HEARTBEAT_MS);
  timer.unref?.();
});

client.on('messageCreate', (message) => {
  if (message.channel?.name !== DATA_CHANNEL_NAME) return;
  const parsed = parseRecord(message.content);
  if (parsed?.type !== 'REQ' || String(parsed.id) !== WORKER_ID) return;
  processRequest(message, parsed).catch((error) => console.warn(`[music-worker-v2 ${WORKER_ID}] bus error:`, error?.message || error));
});

client.on('guildCreate', (guild) => initializeGuild(guild).catch(() => {}));

client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = oldState.guild || newState.guild;
  const state = guildStates.get(String(guild.id));
  if (!state?.voiceId) return;
  if (String(oldState.id || '') === String(client.user?.id || '') || String(newState.id || '') === String(client.user?.id || '')) {
    if (oldState.channelId && !newState.channelId) {
      hardResetVoice(guild, state, 'DISCORD_SIDE_DISCONNECT', true).catch(() => {});
      return;
    }
    if (newState.channelId) state.voiceId = String(newState.channelId);
  }
  const active = String(state.voiceId || '');
  if (String(oldState.channelId || '') === active || String(newState.channelId || '') === active) scheduleEmptyLeave(guild, state);
});

client.login(TOKEN).catch((error) => {
  console.error(`[music-worker-v2 ${WORKER_ID}] login failed:`, error);
  process.exitCode = 1;
});
