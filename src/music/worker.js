'use strict';

const { Readable } = require('node:stream');
const { Client, GatewayIntentBits } = require('discord.js');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const play = require('@iamtraction/play-dl');
const { DATA_CHANNEL_NAME, record, parseRecord } = require('./protocol');

try {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath && !process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = ffmpegPath;
} catch {}

const WORKER_ID = String(process.env.MUSIC_WORKER_ID || '').trim();
const TOKEN = process.env.DISCORD_TOKEN;
const HEARTBEAT_MS = 10_000;
const REQUEST_TTL_MS = 45_000;
const SOURCE_TIMEOUT_MS = 20_000;
const EMPTY_LEAVE_MS = 5_000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36';

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
  emptyTimer: null,
  startedAt: Date.now(),
};
const seenRequests = new Set();
let advancing = false;
let youtubePromise = null;

function safeText(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function withTimeout(promise, ms = SOURCE_TIMEOUT_MS, code = 'SOURCE_TIMEOUT') {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function youtube() {
  if (!youtubePromise) {
    youtubePromise = import('youtubei.js')
      .then(({ Innertube, UniversalCache }) => Innertube.create({ cache: new UniversalCache(false) }))
      .catch((error) => {
        youtubePromise = null;
        throw error;
      });
  }
  return youtubePromise;
}

function youtubeVideoId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      if (url.searchParams.get('v')) return url.searchParams.get('v');
      const parts = url.pathname.split('/').filter(Boolean);
      if (['shorts', 'live', 'embed'].includes(parts[0])) return parts[1] || null;
    }
  } catch {}
  return null;
}

function youtubeTitle(node, fallback) {
  return safeText(
    node?.title?.text
      || node?.title?.toString?.()
      || node?.video_details?.title
      || node?.basic_info?.title
      || fallback,
    180,
  );
}

async function resolveYoutubeTrack(wanted) {
  const yt = await withTimeout(youtube(), SOURCE_TIMEOUT_MS, 'YOUTUBE_INIT_TIMEOUT');
  const directId = youtubeVideoId(wanted);
  if (directId) {
    const info = await withTimeout(
      yt.getBasicInfo(directId, { client: 'ANDROID' }),
      SOURCE_TIMEOUT_MS,
      'YOUTUBE_INFO_TIMEOUT',
    );
    return {
      provider: 'youtube',
      title: youtubeTitle(info, wanted),
      url: `https://www.youtube.com/watch?v=${directId}`,
      videoId: directId,
    };
  }

  const search = await withTimeout(yt.search(wanted, { type: 'video' }), SOURCE_TIMEOUT_MS, 'YOUTUBE_SEARCH_TIMEOUT');
  const results = [...(search?.results || [])];
  const result = results.find((item) => item?.video_id && String(item?.type || '').toLowerCase() === 'video')
    || results.find((item) => item?.video_id)
    || results.find((item) => item?.id);
  const videoId = result?.video_id || result?.id || null;
  if (!videoId) return null;
  return {
    provider: 'youtube',
    title: youtubeTitle(result, wanted),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}

async function resolveRedirect(url) {
  try {
    const response = await withTimeout(fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    }), 9_000, 'URL_REDIRECT_TIMEOUT');
    const finalUrl = response.url || url;
    try { await response.body?.cancel?.(); } catch {}
    return finalUrl;
  } catch {
    return url;
  }
}

async function resolveTrack(query) {
  const wanted = safeText(query, 400);
  if (!wanted) return null;
  const looksLikeUrl = /^https?:\/\//i.test(wanted);
  const isYoutubeUrl = Boolean(youtubeVideoId(wanted));

  if (!looksLikeUrl || isYoutubeUrl) {
    const youtubeTrack = await resolveYoutubeTrack(wanted).catch((error) => {
      console.warn(`[music-worker ${WORKER_ID}] YouTube resolve failed:`, error.message);
      return null;
    });
    if (youtubeTrack) return youtubeTrack;
  }

  let candidate = wanted;
  if (/^https?:\/\/(?:on\.)?soundcloud\.com\//i.test(candidate)) candidate = await resolveRedirect(candidate);
  try {
    const type = await play.validate(candidate);
    if (type === 'so_track') {
      const info = await play.soundcloud(candidate);
      return {
        provider: 'soundcloud',
        title: safeText(info.name || wanted, 180),
        url: info.url || candidate,
      };
    }
  } catch (error) {
    console.warn(`[music-worker ${WORKER_ID}] SoundCloud resolve failed:`, error.message);
  }

  return null;
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
  const content = record('EVENT', eventId, { worker_id: WORKER_ID, ...payload });
  if (content.length > 1950) return;
  await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

function clearEmptyTimer() {
  if (state.emptyTimer) clearTimeout(state.emptyTimer);
  state.emptyTimer = null;
}

function voiceHasHuman(guild, voiceId) {
  const channel = guild.channels.cache.get(String(voiceId));
  if (!channel?.isVoiceBased?.()) return false;
  return channel.members.some((member) => !member.user?.bot);
}

async function leaveVoice(guild, { clearPin = false } = {}) {
  clearEmptyTimer();
  if (clearPin) state.pinnedVoiceId = null;
  state.queue = [];
  state.current = null;
  player.stop(true);
  const connection = state.connection;
  state.connection = null;
  state.voiceId = null;
  try { connection?.destroy(); } catch {}
  await publishStatus(guild).catch(() => {});
}

function scheduleEmptyLeave(guild) {
  clearEmptyTimer();
  if (!state.voiceId) return;
  if (voiceHasHuman(guild, state.voiceId)) return;
  const expectedVoice = String(state.voiceId);
  state.emptyTimer = setTimeout(async () => {
    state.emptyTimer = null;
    if (!state.voiceId || String(state.voiceId) !== expectedVoice) return;
    if (voiceHasHuman(guild, expectedVoice)) return;
    await leaveVoice(guild, { clearPin: false });
  }, EMPTY_LEAVE_MS);
  state.emptyTimer.unref?.();
}

async function ensureConnection(guild, voiceId) {
  if (state.connection && state.guildId === guild.id && String(state.voiceId) === String(voiceId)) {
    scheduleEmptyLeave(guild);
    return state.connection;
  }
  if (state.connection) {
    try { state.connection.destroy(); } catch {}
    state.connection = null;
  }
  const channel = guild.channels.cache.get(String(voiceId)) || await guild.channels.fetch(String(voiceId)).catch(() => null);
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
        state.connection = null;
        state.voiceId = null;
        state.current = null;
        state.queue = [];
        try { connection.destroy(); } catch {}
      }
    }
  });
  await publishStatus(guild).catch(() => {});
  scheduleEmptyLeave(guild);
  return connection;
}

async function getYoutubeStream(track) {
  const yt = await withTimeout(youtube(), SOURCE_TIMEOUT_MS, 'YOUTUBE_INIT_TIMEOUT');
  const attempts = [
    { type: 'audio', quality: 'best', format: 'webm', codec: 'opus', client: 'ANDROID' },
    { type: 'audio', quality: 'best', format: 'any', client: 'ANDROID' },
    { type: 'audio', quality: 'best', format: 'any', client: 'WEB' },
  ];
  let lastError = null;

  for (const options of attempts) {
    try {
      const format = await withTimeout(
        yt.getStreamingData(track.videoId, options),
        SOURCE_TIMEOUT_MS,
        'YOUTUBE_FORMAT_TIMEOUT',
      );
      const url = String(format?.url || '');
      if (!url) throw new Error('YOUTUBE_FORMAT_URL_MISSING');
      const response = await withTimeout(fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: 'https://www.youtube.com/',
          Accept: '*/*',
          Range: 'bytes=0-',
        },
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      }), SOURCE_TIMEOUT_MS, 'YOUTUBE_HTTP_TIMEOUT');
      if (!response.ok || !response.body) throw new Error(`YOUTUBE_HTTP_${response.status}`);
      const mime = String(format?.mime_type || format?.mimeType || response.headers.get('content-type') || '').toLowerCase();
      const inputType = mime.includes('webm') && mime.includes('opus') ? StreamType.WebmOpus : StreamType.Arbitrary;
      return { stream: Readable.fromWeb(response.body), inputType };
    } catch (error) {
      lastError = error;
      console.warn(`[music-worker ${WORKER_ID}] YouTube stream attempt failed:`, error.message);
    }
  }

  try {
    const webStream = await withTimeout(
      yt.download(track.videoId, { type: 'audio', quality: 'best', client: 'ANDROID' }),
      SOURCE_TIMEOUT_MS,
      'YOUTUBE_DOWNLOAD_TIMEOUT',
    );
    const stream = typeof webStream?.getReader === 'function' ? Readable.fromWeb(webStream) : webStream;
    if (stream?.pipe) return { stream, inputType: StreamType.Arbitrary };
  } catch (error) {
    lastError = error;
  }

  throw lastError || new Error('YOUTUBE_AUDIO_STREAM_UNAVAILABLE');
}

async function streamTrack(track) {
  if (track.provider === 'youtube' && track.videoId) {
    const source = await getYoutubeStream(track);
    const resource = createAudioResource(source.stream, {
      inputType: source.inputType,
      inlineVolume: true,
      metadata: track,
    });
    if (resource.volume) resource.volume.setVolume(state.volume / 100);
    return resource;
  }

  const source = await withTimeout(play.stream(track.url, { quality: 2 }), SOURCE_TIMEOUT_MS, 'SOUNDCLOUD_STREAM_TIMEOUT');
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
  await entersState(player, AudioPlayerStatus.Playing, 10_000).catch((error) => {
    throw new Error(`AUDIO_DID_NOT_START:${error.message}`);
  });
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
      if (!state.pinnedVoiceId) await leaveVoice(guild, { clearPin: false });
      else await publishStatus(guild).catch(() => {});
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
  try {
    await startTrack(guild, track);
    await emitEvent(guild, { ...payload, code: 'playing', title: track.title });
  } catch (error) {
    state.current = null;
    player.stop(true);
    console.warn(`[music-worker ${WORKER_ID}] Start track failed:`, error.message);
    await emitEvent(guild, { ...payload, code: 'error', reason: safeText(error.message, 120), title: track.title });
  }
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
  if (!state.pinnedVoiceId) await leaveVoice(guild, { clearPin: false });
  else await publishStatus(guild).catch(() => {});
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

async function handleUnpin(guild) {
  state.pinnedVoiceId = null;
  await leaveVoice(guild, { clearPin: true });
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
    else if (payload.action === 'unpin') await handleUnpin(guild, payload);
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
  try {
    await withTimeout(youtube(), SOURCE_TIMEOUT_MS, 'YOUTUBE_INIT_TIMEOUT');
    console.log(`[music-worker ${WORKER_ID}] YouTube.js source ready.`);
  } catch (error) {
    console.warn(`[music-worker ${WORKER_ID}] YouTube init failed; worker stays online:`, error.message);
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
  const guild = newState.guild || oldState.guild;
  if (!guild || !state.voiceId) return;
  if (String(oldState.channelId || '') !== String(state.voiceId) && String(newState.channelId || '') !== String(state.voiceId)) return;
  scheduleEmptyLeave(guild);
});

client.on('guildCreate', (guild) => bootstrapGuild(guild).catch(() => {}));

client.login(TOKEN).catch((error) => {
  console.error(`[music-worker ${WORKER_ID}] Login failed:`, error);
  process.exitCode = 1;
});
