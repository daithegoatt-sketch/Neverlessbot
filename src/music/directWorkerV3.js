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
const {
  DATA_CHANNEL_NAME,
  HEARTBEAT_STALE_MS,
  helpText,
  isAllowedCommandChannel,
  parseMusicCommand,
  parseRecord,
  record,
} = require('./protocol');

const TOKEN = String(process.env.DISCORD_TOKEN || '').trim();
const WORKER_ID = String(process.env.MUSIC_WORKER_ID || '').trim();
const YOUTUBE_COOKIE = String(process.env.YOUTUBE_COOKIE || '').trim();
const HEARTBEAT_MS = 10_000;
const CLAIM_STAGGER_MS = 250;
const EMPTY_LEAVE_MS = 10_000;
const PROMPT_TTL_MS = 45_000;
const MAX_QUERY_LENGTH = 300;

if (!TOKEN) throw new Error('MUSIC_MISSING_DISCORD_TOKEN');
if (!/^[123]$/.test(WORKER_ID)) throw new Error('MUSIC_WORKER_ID must be 1, 2, or 3');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const guildStates = new Map();
const peerStatuses = new Map();
const pendingQueries = new Map();
const handledMessages = new Set();
let youtubePromise = null;

function clean(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function peerMap(guildId) {
  const key = String(guildId);
  if (!peerStatuses.has(key)) peerStatuses.set(key, new Map());
  return peerStatuses.get(key);
}
function stateFor(guildId) {
  const key = String(guildId);
  let state = guildStates.get(key);
  if (state) return state;
  state = {
    guildId: key,
    voiceId: null,
    textId: null,
    connection: null,
    subscription: null,
    current: null,
    queue: [],
    volume: 100,
    statusMessageId: null,
    emptyTimer: null,
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
    if (Platform?.shim) {
      Platform.shim.eval = async (data) => new Function(data.output)();
    }
    const config = { generate_session_locally: true };
    if (YOUTUBE_COOKIE) config.cookie = YOUTUBE_COOKIE;
    const yt = await Innertube.create(config);
    console.log(`[music-v3 ${WORKER_ID}] YouTube.js session ready${YOUTUBE_COOKIE ? ' with cookie' : ''}.`);
    return yt;
  })().catch((error) => {
    youtubePromise = null;
    throw error;
  });
  return youtubePromise;
}

async function dataChannel(guild) {
  let channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  if (!channel) {
    await guild.channels.fetch().catch(() => null);
    channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  }
  return channel;
}

function statusPayload(state) {
  return {
    bot_id: client.user?.id || null,
    guild_id: state.guildId,
    voice_id: state.voiceId,
    playing: Boolean(state.current || state.queue.length || state.player.state.status === AudioPlayerStatus.Playing || state.player.state.status === AudioPlayerStatus.Buffering),
    current_title: state.current?.title || null,
    queue_length: state.queue.length,
    volume: state.volume,
    backend: 'youtubejs-direct',
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
    if (batch) {
      message = batch.find((item) => {
        const parsed = parseRecord(item.content);
        return item.author?.id === client.user?.id && parsed?.type === 'STATUS' && parsed.id === WORKER_ID;
      }) || null;
    }
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

function ingestStatus(message) {
  const parsed = parseRecord(message?.content);
  if (parsed?.type !== 'STATUS' || !/^[123]$/.test(parsed.id)) return false;
  const guildId = String(parsed.payload?.guild_id || message.guildId || '');
  if (!guildId) return false;
  peerMap(guildId).set(parsed.id, parsed.payload || {});
  return true;
}

async function refreshPeerStatuses(guild) {
  const channel = await dataChannel(guild);
  if (!channel) return false;
  const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!batch) return false;
  for (const message of batch.values()) ingestStatus(message);
  return true;
}

function isFresh(payload) {
  const at = Number(payload?.heartbeat_at) || 0;
  return at > 0 && Date.now() - at <= HEARTBEAT_STALE_MS;
}
function ownerForVoice(guildId, voiceId) {
  const wanted = String(voiceId || '');
  if (!wanted) return null;
  const local = stateFor(guildId);
  if (String(local.voiceId || '') === wanted) return WORKER_ID;
  for (const [id, payload] of peerMap(guildId)) {
    if (id === WORKER_ID || !isFresh(payload)) continue;
    if (String(payload.voice_id || '') === wanted) return id;
  }
  return null;
}
function workerIsFree(guildId, id) {
  if (id === WORKER_ID) return !stateFor(guildId).voiceId;
  const payload = peerMap(guildId).get(id);
  return Boolean(payload && isFresh(payload) && !payload.voice_id);
}
function firstFreeWorker(guildId) {
  return ['1', '2', '3'].find((id) => workerIsFree(guildId, id)) || null;
}
function fallbackWorkerForVoice(voiceId) {
  try { return String((BigInt(String(voiceId)) % 3n) + 1n); } catch { return '1'; }
}

function pendingKey(message) { return `${message.guildId}:${message.author.id}:${message.channelId}`; }
function markPending(message) { pendingQueries.set(pendingKey(message), Date.now() + PROMPT_TTL_MS); }
function takePending(message) {
  const key = pendingKey(message);
  const expiresAt = pendingQueries.get(key) || 0;
  pendingQueries.delete(key);
  return expiresAt > 0 && Date.now() <= expiresAt;
}
async function reply(message, content) {
  return message.reply({ content, allowedMentions: { repliedUser: false, parse: [] } }).catch(() => null);
}
function canUseVoice(message) {
  const voice = message.member?.voice?.channel;
  if (!voice?.isVoiceBased?.()) return null;
  if (!isAllowedCommandChannel(message)) return null;
  return voice;
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
  console.log(`[music-v3 ${WORKER_ID}] Voice reset (${reason}) in guild ${guild.id}.`);
  await publishStatus(guild).catch(() => false);
}

function scheduleEmptyLeave(guild, state) {
  clearEmptyTimer(state);
  if (!state.voiceId || humansInVoice(guild, state.voiceId) > 0) return;
  const expected = String(state.voiceId);
  state.emptyTimer = setTimeout(async () => {
    state.emptyTimer = null;
    if (String(state.voiceId || '') !== expected) return;
    if (humansInVoice(guild, expected) > 0) return;
    await hardResetVoice(guild, state, 'EMPTY_VOICE_10S').catch(() => {});
  }, EMPTY_LEAVE_MS);
  state.emptyTimer.unref?.();
}

async function ensureVoice(state, guild, voiceChannel) {
  const voiceId = String(voiceChannel.id);
  clearEmptyTimer(state);
  let connection = state.connection || getVoiceConnection(guild.id);
  if (connection && connection.state.status === VoiceConnectionStatus.Destroyed) connection = null;
  if (connection && String(state.voiceId || '') !== voiceId) {
    try { connection.destroy(); } catch {}
    connection = null;
  }
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
  }
  state.voiceId = voiceId;
  state.connection = connection;
  state.subscription = connection.subscribe(state.player);
  if (!connection.__neverlessHooks) {
    connection.__neverlessHooks = true;
    connection.on('error', (error) => console.warn(`[music-v3 ${WORKER_ID}] voice error:`, error?.message || error));
  }
  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  scheduleEmptyLeave(guild, state);
  return connection;
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

async function resolveTrack(query) {
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
  return { videoId, title, query: wanted };
}

async function createTrackResource(track, volume) {
  const yt = await getYoutube();
  const webStream = await yt.download(track.videoId, {
    type: 'audio',
    quality: 'best',
    format: 'webm',
    codec: 'opus',
  });
  if (!webStream) throw new Error('YOUTUBE_NO_STREAM');
  const nodeStream = typeof Readable.fromWeb === 'function' ? Readable.fromWeb(webStream) : Readable.from(webStream);
  const resource = createAudioResource(nodeStream, {
    inputType: StreamType.WebmOpus,
    inlineVolume: true,
    metadata: track,
  });
  resource.volume?.setVolume(Math.max(0, Math.min(2, Number(volume) / 100)));
  return resource;
}

async function playNext(state, guild) {
  if (state.advancing || state.current) return;
  const next = state.queue.shift() || null;
  if (!next) {
    await publishStatus(guild).catch(() => false);
    return;
  }
  state.advancing = true;
  state.current = next;
  try {
    const resource = await createTrackResource(next, state.volume);
    state.player.play(resource);
    await entersState(state.player, AudioPlayerStatus.Playing, 20_000);
    await publishStatus(guild).catch(() => false);
  } catch (error) {
    console.warn(`[music-v3 ${WORKER_ID}] stream failed for ${next.title}:`, error?.message || error);
    state.current = null;
    const channel = state.textId ? guild.channels.cache.get(state.textId) : null;
    if (channel?.isTextBased?.()) {
      const reason = clean(error?.message || 'UNKNOWN_STREAM_ERROR', 140);
      await channel.send({
        content: `تعذر تشغيل **${clean(next.title, 120)}**. \`${reason}\``,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
    if (state.queue.length) setImmediate(() => playNext(state, guild).catch(() => {}));
    else await publishStatus(guild).catch(() => false);
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
    playNext(state, guild).catch(() => {});
  });
  state.player.on('error', (error) => {
    const guild = client.guilds.cache.get(state.guildId);
    console.warn(`[music-v3 ${WORKER_ID}] player error:`, error?.message || error);
    state.current = null;
    if (guild) playNext(state, guild).catch(() => {});
  });
}

async function handlePlay(message, voice, query) {
  const state = stateFor(message.guildId);
  state.textId = message.channelId;
  try {
    await ensureVoice(state, message.guild, voice);
    await publishStatus(message.guild).catch(() => false);
  } catch (error) {
    await hardResetVoice(message.guild, state, 'VOICE_NOT_READY').catch(() => {});
    await reply(message, `تعذر تجهيز الاتصال الصوتي: \`${clean(error?.message || error, 120)}\``);
    return;
  }

  let track;
  try {
    track = await resolveTrack(query);
  } catch (error) {
    console.warn(`[music-v3 ${WORKER_ID}] search failed:`, error?.message || error);
    await reply(message, `تعذر البحث في YouTube: \`${clean(error?.message || error, 140)}\``);
    return;
  }
  if (!track) {
    await reply(message, 'ما لقيت نتيجة للأغنية.');
    return;
  }

  const busy = Boolean(state.current) || state.queue.length > 0 || [AudioPlayerStatus.Playing, AudioPlayerStatus.Buffering].includes(state.player.state.status);
  state.queue.push(track);
  if (busy) {
    await reply(message, `انضافت للانتظار: **${track.title}**`);
    await publishStatus(message.guild).catch(() => false);
    return;
  }
  await reply(message, `جاري التشغيل: **${track.title}**`);
  await playNext(state, message.guild);
}

async function handleBoundCommand(message, voice, command) {
  if (ownerForVoice(message.guildId, voice.id) !== WORKER_ID) return false;
  const state = stateFor(message.guildId);
  state.textId = message.channelId;

  if (command.action === 'skip') {
    const hadSomething = Boolean(state.current || state.queue.length || state.player.state.status !== AudioPlayerStatus.Idle);
    if (!hadSomething) {
      await reply(message, 'ما في أغنية شغالة حاليًا.');
      return true;
    }
    state.player.stop(true);
    await reply(message, state.queue.length ? 'تم التخطي.' : 'تم التخطي، والانتظار فاضي.');
    return true;
  }
  if (command.action === 'stop') {
    state.queue = [];
    state.current = null;
    state.player.stop(true);
    await publishStatus(message.guild).catch(() => false);
    await reply(message, 'تم إيقاف التشغيل ومسح الانتظار. البوت يبقى في الروم لين يفضى من الأشخاص.');
    return true;
  }
  if (command.action === 'volume') {
    state.volume = Math.max(0, Math.min(200, Number(command.value) || 0));
    state.player.state.resource?.volume?.setVolume(state.volume / 100);
    await publishStatus(message.guild).catch(() => false);
    await reply(message, `الصوت: **${state.volume}%**`);
    return true;
  }
  if (command.action === 'volume_invalid') {
    await reply(message, 'الصوت لازم يكون بين 0 و200.');
    return true;
  }
  return false;
}

async function disconnectFromVoice(message, voice) {
  if (ownerForVoice(message.guildId, voice.id) !== WORKER_ID) return false;
  await hardResetVoice(message.guild, stateFor(message.guildId), 'USER_LEAVE_COMMAND').catch(() => {});
  await reply(message, 'تم الخروج من الروم الصوتي.');
  return true;
}

async function claimVoiceOnly(message, voice) {
  let owner = ownerForVoice(message.guildId, voice.id);
  if (owner) {
    if (owner !== WORKER_ID) return false;
    await ensureVoice(stateFor(message.guildId), message.guild, voice);
    return true;
  }
  await sleep((Number(WORKER_ID) - 1) * CLAIM_STAGGER_MS);
  const coordinated = await refreshPeerStatuses(message.guild).catch(() => false);
  owner = ownerForVoice(message.guildId, voice.id);
  if (owner) {
    if (owner !== WORKER_ID) return false;
    await ensureVoice(stateFor(message.guildId), message.guild, voice);
    return true;
  }
  const winner = coordinated ? firstFreeWorker(message.guildId) : fallbackWorkerForVoice(voice.id);
  if (winner !== WORKER_ID) return false;
  const state = stateFor(message.guildId);
  state.voiceId = String(voice.id);
  state.textId = message.channelId;
  await publishStatus(message.guild).catch(() => false);
  try {
    await ensureVoice(state, message.guild, voice);
    await publishStatus(message.guild).catch(() => false);
    return true;
  } catch (error) {
    state.voiceId = null;
    await publishStatus(message.guild).catch(() => false);
    throw error;
  }
}

async function claimAndPlay(message, voice, query) {
  const owner = ownerForVoice(message.guildId, voice.id);
  if (owner) {
    if (owner === WORKER_ID) await handlePlay(message, voice, query);
    return;
  }
  const claimed = await claimVoiceOnly(message, voice);
  if (claimed) await handlePlay(message, voice, query);
}

async function handleMessage(message) {
  if (!message?.guildId || message.author?.bot) return;
  if (message.channel?.name === DATA_CHANNEL_NAME) {
    ingestStatus(message);
    return;
  }
  if (handledMessages.has(message.id)) return;
  handledMessages.add(message.id);
  if (handledMessages.size > 1200) {
    for (const id of [...handledMessages].slice(0, 600)) handledMessages.delete(id);
  }

  const voice = canUseVoice(message);
  if (!voice) return;
  const text = clean(message.content, 400);
  if (!text) return;

  if (/^(?:اخرج|اطلع|leave|disconnect)$/iu.test(text)) {
    await disconnectFromVoice(message, voice);
    return;
  }
  if (/^(?:ش|شغل|تشغيل|play|p)$/iu.test(text)) {
    try {
      const claimed = await claimVoiceOnly(message, voice);
      if (claimed) {
        markPending(message);
        await reply(message, 'دخلت الروم. اكتب اسم الأغنية أو رابط YouTube في الرسالة التالية.');
      }
    } catch (error) {
      console.warn(`[music-v3 ${WORKER_ID}] join prompt failed:`, error?.message || error);
      if (WORKER_ID === '1') await reply(message, `تعذر دخول الروم: \`${clean(error?.message || error, 120)}\``);
    }
    return;
  }

  let command = parseMusicCommand(text);
  if (!command && takePending(message)) command = { action: 'play', query: text.slice(0, MAX_QUERY_LENGTH) };
  if (!command) return;

  if (command.action === 'help') {
    if (WORKER_ID === '1') await reply(message, `${helpText()}\n\`اخرج\` — إخراج بوت الموسيقى من الروم.`);
    return;
  }
  if (command.action === 'play') {
    await claimAndPlay(message, voice, command.query);
    return;
  }

  const handled = await handleBoundCommand(message, voice, command);
  if (!handled && WORKER_ID === '1' && !ownerForVoice(message.guildId, voice.id)) {
    await reply(message, 'ما في بوت موسيقى مربوط بهالروم حاليًا.');
  }
}

async function initializeGuild(guild) {
  stateFor(guild.id);
  await refreshPeerStatuses(guild).catch(() => false);
  await publishStatus(guild).catch(() => false);
}

client.once('ready', async () => {
  console.log(`[music-v3 ${WORKER_ID}] ${client.user.tag} online. Backend=@discordjs/voice + youtubei.js.`);
  getYoutube().catch((error) => console.warn(`[music-v3 ${WORKER_ID}] YouTube.js warmup failed:`, error?.message || error));
  for (const guild of client.guilds.cache.values()) await initializeGuild(guild);
  const timer = setInterval(() => {
    for (const guild of client.guilds.cache.values()) publishStatus(guild).catch(() => false);
  }, HEARTBEAT_MS);
  timer.unref?.();
});

client.on('messageCreate', (message) => {
  handleMessage(message).catch((error) => console.error(`[music-v3 ${WORKER_ID}] message handler failed:`, error));
});
client.on('guildCreate', (guild) => initializeGuild(guild).catch(() => {}));
client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = oldState.guild || newState.guild;
  const state = guildStates.get(String(guild.id));
  if (!state) return;

  if (String(oldState.id || '') === String(client.user?.id || '') || String(newState.id || '') === String(client.user?.id || '')) {
    const nextVoiceId = newState.channelId ? String(newState.channelId) : null;
    if (!nextVoiceId) {
      // Discord-side disconnects must destroy the tracked connection, otherwise
      // @discordjs/voice may reuse/rejoin the previous connection.
      hardResetVoice(guild, state, 'DISCORD_SIDE_DISCONNECT', true).catch(() => {});
      return;
    }
    state.voiceId = nextVoiceId;
    scheduleEmptyLeave(guild, state);
    publishStatus(guild).catch(() => false);
    return;
  }

  const active = state.voiceId;
  if (!active) return;
  if (String(oldState.channelId || '') !== String(active) && String(newState.channelId || '') !== String(active)) return;
  scheduleEmptyLeave(guild, state);
});

client.login(TOKEN).catch((error) => {
  console.error(`[music-v3 ${WORKER_ID}] Login failed:`, error);
  process.exitCode = 1;
});
