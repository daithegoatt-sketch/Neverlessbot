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
  getVoiceConnection,
  joinVoiceChannel,
} = require('@discordjs/voice');
const play = require('@iamtraction/play-dl');
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
const HEARTBEAT_MS = 10_000;
const CLAIM_STAGGER_MS = 350;
const PROMPT_TTL_MS = 60_000;
const MAX_QUERY_LENGTH = 300;

if (!TOKEN) throw new Error('MUSIC_DIRECT_MISSING_DISCORD_TOKEN');
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
const peerStatus = new Map();
const pendingQueries = new Map();
const handledMessages = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(value, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function stateFor(guildId) {
  const key = String(guildId);
  let state = guildStates.get(key);
  if (!state) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    state = {
      guildId: key,
      voiceId: null,
      textId: null,
      connection: null,
      player,
      subscription: null,
      current: null,
      queue: [],
      volume: 100,
      statusMessageId: null,
      advancing: false,
      startedAt: Date.now(),
    };
    installPlayerEvents(state);
    guildStates.set(key, state);
  }
  return state;
}

function peerMap(guildId) {
  const key = String(guildId);
  let map = peerStatus.get(key);
  if (!map) {
    map = new Map();
    peerStatus.set(key, map);
  }
  return map;
}

async function dataChannel(guild) {
  let channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  if (!channel) {
    await guild.channels.fetch().catch(() => null);
    channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  }
  return channel;
}

function localStatusPayload(state) {
  return {
    bot_id: client.user?.id || null,
    guild_id: state.guildId,
    voice_id: state.voiceId,
    playing: state.player.state.status === AudioPlayerStatus.Playing || state.player.state.status === AudioPlayerStatus.Buffering,
    current_title: state.current?.title || null,
    queue_length: state.queue.length,
    volume: state.volume,
    backend: 'discord-voice-direct',
    backend_ready: true,
    heartbeat_at: Date.now(),
    started_at: state.startedAt,
  };
}

async function publishStatus(guild) {
  const state = stateFor(guild.id);
  const channel = await dataChannel(guild);
  if (!channel) return false;
  const payload = localStatusPayload(state);
  peerMap(guild.id).set(WORKER_ID, payload);
  const content = record('STATUS', WORKER_ID, payload);
  let statusMessage = state.statusMessageId
    ? await channel.messages.fetch(state.statusMessageId).catch(() => null)
    : null;
  if (!statusMessage) {
    const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (batch) {
      statusMessage = batch.find((item) => {
        const parsed = parseRecord(item.content);
        return item.author?.id === client.user?.id
          && parsed?.type === 'STATUS'
          && parsed.id === WORKER_ID;
      }) || null;
    }
  }
  if (statusMessage) {
    state.statusMessageId = statusMessage.id;
    const edited = await statusMessage.edit({ content, allowedMentions: { parse: [] } }).catch(() => null);
    return Boolean(edited);
  }
  statusMessage = await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
  if (statusMessage) state.statusMessageId = statusMessage.id;
  return Boolean(statusMessage);
}

function ingestStatus(message) {
  const parsed = parseRecord(message?.content);
  if (parsed?.type !== 'STATUS') return false;
  const guildId = parsed.payload?.guild_id || message.guildId;
  if (!guildId || !/^[123]$/.test(parsed.id)) return false;
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

function isFreshStatus(payload) {
  const at = Number(payload?.heartbeat_at) || 0;
  return at > 0 && Date.now() - at <= HEARTBEAT_STALE_MS;
}

function ownerForVoice(guildId, voiceId) {
  const wanted = String(voiceId || '');
  if (!wanted) return null;
  const local = stateFor(guildId);
  if (String(local.voiceId || '') === wanted) return WORKER_ID;
  for (const [id, payload] of peerMap(guildId)) {
    if (!isFreshStatus(payload)) continue;
    if (String(payload.voice_id || '') === wanted) return id;
  }
  return null;
}

function workerIsFree(guildId, id) {
  if (id === WORKER_ID) return !stateFor(guildId).voiceId;
  const payload = peerMap(guildId).get(id);
  return Boolean(payload && isFreshStatus(payload) && !payload.voice_id);
}

function firstFreeWorker(guildId) {
  return ['1', '2', '3'].find((id) => workerIsFree(guildId, id)) || null;
}

function fallbackWorkerForVoice(voiceId) {
  try {
    return String((BigInt(String(voiceId)) % 3n) + 1n);
  } catch {
    return '1';
  }
}

function pendingKey(message) {
  return `${message.guildId}:${message.author.id}:${message.channelId}`;
}

function markPending(message) {
  pendingQueries.set(pendingKey(message), Date.now() + PROMPT_TTL_MS);
}

function takePending(message) {
  const key = pendingKey(message);
  const expiresAt = pendingQueries.get(key) || 0;
  if (!expiresAt) return false;
  pendingQueries.delete(key);
  return Date.now() <= expiresAt;
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

async function ensureVoice(state, guild, voiceChannel) {
  const voiceId = String(voiceChannel.id);
  let connection = getVoiceConnection(guild.id);

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

  if (!connection.__neverlessMusicErrorHook) {
    connection.__neverlessMusicErrorHook = true;
    connection.on('error', (error) => {
      console.warn(`[music-direct ${WORKER_ID}] Voice connection error:`, error?.message || error);
    });
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (error) {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try { connection.destroy(); } catch {}
    }
    state.connection = null;
    state.subscription = null;
    state.voiceId = null;
    throw new Error(`VOICE_NOT_READY: ${error.message}`);
  }

  return connection;
}

async function resolveTrack(query) {
  const wanted = clean(query, MAX_QUERY_LENGTH);
  if (!wanted) return null;

  let url = null;
  let title = wanted;
  const validation = play.yt_validate(wanted);
  if (validation === 'video') {
    const info = await play.video_basic_info(wanted);
    url = info?.video_details?.url || wanted;
    title = clean(info?.video_details?.title || wanted, 180);
  } else {
    const results = await play.search(wanted, { limit: 1, source: { youtube: 'video' } });
    const first = results?.[0];
    if (!first?.url) return null;
    url = first.url;
    title = clean(first.title || wanted, 180);
  }

  return { url, title, query: wanted };
}

async function createTrackResource(track, volume) {
  const source = await play.stream(track.url);
  const resource = createAudioResource(source.stream, {
    inputType: source.type,
    inlineVolume: true,
    metadata: track,
  });
  resource.volume?.setVolume(Math.max(0, Math.min(2, Number(volume) / 100)));
  return resource;
}

async function playNext(state, guild) {
  if (state.advancing) return;
  state.advancing = true;
  try {
    const next = state.queue.shift() || null;
    if (!next) {
      state.current = null;
      await publishStatus(guild).catch(() => {});
      return;
    }

    state.current = next;
    const resource = await createTrackResource(next, state.volume);
    state.player.play(resource);
    await publishStatus(guild).catch(() => {});
  } catch (error) {
    const failed = state.current;
    state.current = null;
    console.warn(`[music-direct ${WORKER_ID}] Stream failed for ${failed?.title || 'track'}:`, error?.message || error);
    const textChannel = state.textId ? guild.channels.cache.get(state.textId) : null;
    if (textChannel?.isTextBased?.()) {
      await textChannel.send({
        content: `تعذر تشغيل **${clean(failed?.title || 'الأغنية', 120)}**. بجرب اللي بعدها إن وجدت.`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
    if (state.queue.length) setImmediate(() => playNext(state, guild).catch(() => {}));
    else await publishStatus(guild).catch(() => {});
  } finally {
    state.advancing = false;
  }
}

function installPlayerEvents(state) {
  state.player.on(AudioPlayerStatus.Playing, () => {
    const guild = client.guilds.cache.get(state.guildId);
    if (guild) publishStatus(guild).catch(() => {});
  });

  state.player.on(AudioPlayerStatus.Idle, () => {
    const guild = client.guilds.cache.get(state.guildId);
    if (!guild) return;
    state.current = null;
    playNext(state, guild).catch(() => {});
  });

  state.player.on('error', (error) => {
    const guild = client.guilds.cache.get(state.guildId);
    console.warn(`[music-direct ${WORKER_ID}] Audio player error:`, error?.message || error);
    state.current = null;
    if (guild) playNext(state, guild).catch(() => {});
  });
}

async function handlePlay(message, voice, query) {
  const state = stateFor(message.guildId);
  state.textId = message.channelId;

  try {
    await ensureVoice(state, message.guild, voice);
    await publishStatus(message.guild).catch(() => {});
  } catch (error) {
    state.voiceId = null;
    await publishStatus(message.guild).catch(() => {});
    await reply(message, `دخلت محاولة الاتصال لكن Discord ما جهز الصوت: \`${clean(error.message, 120)}\``);
    return;
  }

  let track;
  try {
    track = await resolveTrack(query);
  } catch (error) {
    console.warn(`[music-direct ${WORKER_ID}] Search failed:`, error?.message || error);
    await reply(message, 'ما قدرت أجيب الأغنية من YouTube الآن. جرّب اسم أو رابط ثاني.');
    return;
  }

  if (!track) {
    await reply(message, 'ما لقيت نتيجة للأغنية.');
    return;
  }

  const busy = Boolean(state.current)
    || state.player.state.status === AudioPlayerStatus.Playing
    || state.player.state.status === AudioPlayerStatus.Buffering;
  state.queue.push(track);

  if (busy) {
    await reply(message, `انضافت للانتظار: **${track.title}**`);
    await publishStatus(message.guild).catch(() => {});
    return;
  }

  await reply(message, `جاري التشغيل: **${track.title}**`);
  await playNext(state, message.guild);
}

async function handleBoundCommand(message, voice, command) {
  const owner = ownerForVoice(message.guildId, voice.id);
  if (owner !== WORKER_ID) return false;
  const state = stateFor(message.guildId);
  state.textId = message.channelId;

  if (command.action === 'skip') {
    if (!state.current && !state.queue.length) {
      await reply(message, 'ما في أغنية شغالة حاليًا.');
      return true;
    }
    state.player.stop(true);
    await reply(message, state.queue.length ? 'تم التخطي.' : 'تم التخطي، والانتظار فاضي.');
    return true;
  }

  if (command.action === 'stop') {
    state.queue = [];
    state.player.stop(true);
    state.current = null;
    await publishStatus(message.guild).catch(() => {});
    await reply(message, 'تم إيقاف التشغيل ومسح الانتظار. البوت بيبقى في الروم.');
    return true;
  }

  if (command.action === 'volume') {
    state.volume = Math.max(0, Math.min(200, Number(command.value) || 0));
    state.player.state.resource?.volume?.setVolume(state.volume / 100);
    await publishStatus(message.guild).catch(() => {});
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
  const owner = ownerForVoice(message.guildId, voice.id);
  if (owner !== WORKER_ID) return false;
  const state = stateFor(message.guildId);
  state.queue = [];
  state.player.stop(true);
  const connection = getVoiceConnection(message.guildId);
  if (connection) {
    try { connection.destroy(); } catch {}
  }
  state.connection = null;
  state.subscription = null;
  state.current = null;
  state.voiceId = null;
  await publishStatus(message.guild).catch(() => {});
  await reply(message, 'تم الخروج من الروم الصوتي.');
  return true;
}

async function claimVoiceOnly(message, voice) {
  const currentOwner = ownerForVoice(message.guildId, voice.id);
  if (currentOwner) {
    if (currentOwner !== WORKER_ID) return false;
    const state = stateFor(message.guildId);
    state.textId = message.channelId;
    await ensureVoice(state, message.guild, voice);
    await publishStatus(message.guild).catch(() => {});
    return true;
  }

  await sleep((Number(WORKER_ID) - 1) * CLAIM_STAGGER_MS);
  const coordinationReady = await refreshPeerStatuses(message.guild).catch(() => false);
  if (!coordinationReady) {
    if (fallbackWorkerForVoice(voice.id) !== WORKER_ID) return false;
    const state = stateFor(message.guildId);
    state.voiceId = String(voice.id);
    state.textId = message.channelId;
    await ensureVoice(state, message.guild, voice);
    return true;
  }

  const ownerAfterWait = ownerForVoice(message.guildId, voice.id);
  if (ownerAfterWait) {
    if (ownerAfterWait !== WORKER_ID) return false;
    const state = stateFor(message.guildId);
    state.textId = message.channelId;
    await ensureVoice(state, message.guild, voice);
    return true;
  }

  const winner = firstFreeWorker(message.guildId);
  if (!winner || winner !== WORKER_ID) return false;
  const state = stateFor(message.guildId);
  state.voiceId = String(voice.id);
  state.textId = message.channelId;
  await publishStatus(message.guild).catch(() => {});
  try {
    await ensureVoice(state, message.guild, voice);
    await publishStatus(message.guild).catch(() => {});
    return true;
  } catch (error) {
    state.voiceId = null;
    await publishStatus(message.guild).catch(() => {});
    throw error;
  }
}

async function claimAndPlay(message, voice, query) {
  const currentOwner = ownerForVoice(message.guildId, voice.id);
  if (currentOwner) {
    if (currentOwner === WORKER_ID) await handlePlay(message, voice, query);
    return;
  }

  await sleep((Number(WORKER_ID) - 1) * CLAIM_STAGGER_MS);
  const coordinationReady = await refreshPeerStatuses(message.guild).catch(() => false);
  if (!coordinationReady) {
    if (fallbackWorkerForVoice(voice.id) === WORKER_ID) await handlePlay(message, voice, query);
    return;
  }

  const ownerAfterWait = ownerForVoice(message.guildId, voice.id);
  if (ownerAfterWait) {
    if (ownerAfterWait === WORKER_ID) await handlePlay(message, voice, query);
    return;
  }

  const winner = firstFreeWorker(message.guildId);
  if (!winner) {
    if (WORKER_ID === '1') await reply(message, 'كل بوتات الموسيقى الثلاثة مستخدمة حاليًا.');
    return;
  }
  if (winner !== WORKER_ID) return;

  const state = stateFor(message.guildId);
  state.voiceId = String(voice.id);
  state.textId = message.channelId;
  await publishStatus(message.guild).catch(() => {});
  await handlePlay(message, voice, query);
}

async function handleMessage(message) {
  if (!message?.guildId || message.author?.bot) return;
  if (message.channel?.name === DATA_CHANNEL_NAME) {
    ingestStatus(message);
    return;
  }

  if (handledMessages.has(message.id)) return;
  handledMessages.add(message.id);
  if (handledMessages.size > 1000) {
    for (const id of [...handledMessages].slice(0, 500)) handledMessages.delete(id);
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
    markPending(message);
    try {
      const claimed = await claimVoiceOnly(message, voice);
      if (claimed) await reply(message, 'دخلت الروم. اكتب اسم الأغنية أو رابط YouTube في الرسالة التالية.');
    } catch (error) {
      console.warn(`[music-direct ${WORKER_ID}] Join-on-prompt failed:`, error?.message || error);
    }
    return;
  }

  let command = parseMusicCommand(text);
  if (!command && takePending(message)) {
    command = { action: 'play', query: text.slice(0, MAX_QUERY_LENGTH) };
  }
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
  console.log(`[music-direct ${WORKER_ID}] ${client.user.tag} online. Backend=@discordjs/voice + play-dl.`);
  for (const guild of client.guilds.cache.values()) await initializeGuild(guild);
  const timer = setInterval(() => {
    for (const guild of client.guilds.cache.values()) publishStatus(guild).catch(() => false);
  }, HEARTBEAT_MS);
  timer.unref?.();
});

client.on('messageCreate', (message) => {
  handleMessage(message).catch((error) => {
    console.error(`[music-direct ${WORKER_ID}] message handler failed:`, error);
  });
});

client.on('guildCreate', (guild) => initializeGuild(guild).catch(() => {}));

client.on('voiceStateUpdate', (oldState, newState) => {
  if (String(oldState.id || '') !== String(client.user?.id || '') && String(newState.id || '') !== String(client.user?.id || '')) return;
  const state = guildStates.get(String(oldState.guild.id));
  if (!state) return;
  const nextVoiceId = newState.channelId ? String(newState.channelId) : null;
  state.voiceId = nextVoiceId;
  if (!nextVoiceId) {
    state.connection = null;
    state.subscription = null;
    state.current = null;
    state.queue = [];
  }
  publishStatus(oldState.guild).catch(() => false);
});

client.login(TOKEN).catch((error) => {
  console.error(`[music-direct ${WORKER_ID}] Login failed:`, error);
  process.exitCode = 1;
});
