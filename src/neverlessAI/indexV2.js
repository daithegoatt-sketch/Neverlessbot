'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { captureMessage, removeMessage, startBackfill } = require('./messageIndex');
const { initLongTermMemory, getTurns, appendTurn, getLearningContext } = require('./memory');
const { processCorrection, learningNote } = require('./learning');
const { TOOL_DEFINITIONS, createServerToolExecutor } = require('./serverTools');
const { configured, providerLabel, runWithTools } = require('./aiProvider');
const { getRelevantRatingContext, formatRatingContext } = require('./genshinRatingContext');
const { splitResponse, shouldHandle, buildInstructions } = require('./index');

const ASK_CHANNEL_ID = '1546282420851179621';
const ADMIN_CHANNEL_ID = '1546282473988685864';
const AI_CHANNELS = new Set([ASK_CHANNEL_ID, ADMIN_CHANNEL_ID]);
const queues = new Map();
const missingKeyNotices = new Map();
let installed = false;
let readyGuildId = null;

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isAdminMember(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
}

function queueKey(message) {
  return `${message.guildId}:${message.author.id}`;
}

function enqueue(message, task) {
  const key = queueKey(message);
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const queued = current.finally(() => {
    if (queues.get(key) === queued) queues.delete(key);
  });
  queues.set(key, queued);
  return current;
}

async function sendAnswer(message, text) {
  const chunks = splitResponse(text);
  if (!chunks.length) return;
  await message.reply({ content: chunks[0], allowedMentions: { parse: [], repliedUser: false } });
  for (const chunk of chunks.slice(1)) {
    await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

function friendlyAIError(error) {
  const status = Number(error?.status) || 0;
  const message = String(error?.message || '');
  if (status === 429) return 'Gemini عليه ضغط أو وصل حد الطلبات المؤقت لهذا المشروع. انتظر شوي وجرب مرة ثانية.';
  if (status === 403) return 'Gemini رفض الطلب من المشروع الحالي. راجع حالة الـAPI/Free Tier في Google AI Studio.';
  if (status === 401 || (status === 400 && /key|api/i.test(message))) return 'مفتاح Gemini غير صالح أو غير مقبول من Google. حدّث `GEMINI_API_KEY` في Railway.';
  if (error?.code === 'AI_TIMEOUT' || /TIMEOUT/i.test(message)) return 'الرد أخذ وقت أطول من الحد، فوقفته حتى ما تتكدس طلبات البوت. جرّب مرة ثانية.';
  return 'صار خطأ أثناء تجهيز الرد. جرّب بعد شوي.';
}

async function handleAIMessage(message) {
  if (!configured()) {
    const now = Date.now();
    const last = missingKeyNotices.get(message.channelId) || 0;
    if (now - last > 15 * 60_000) {
      missingKeyNotices.set(message.channelId, now);
      await message.reply({
        content: 'Neverless AI جاهز، لكن ما فيه مفتاح AI في متغيرات الاستضافة. أضف `GEMINI_API_KEY`، أو `OPENAI_API_KEY` كخيار بديل.',
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
    }
    return;
  }

  const userId = message.author.id;
  const text = clean(message.content) || '[The user sent an attachment without text.]';
  const turns = getTurns(userId);
  const correction = await processCorrection(message.guild, userId, text);
  const learned = getLearningContext(userId, text);
  const adminMode = message.channelId === ADMIN_CHANNEL_ID && isAdminMember(message.member);
  const ratingContext = await getRelevantRatingContext(message.guild, message.member, text, turns).catch((error) => {
    console.warn('[neverless-ai] Rating context lookup failed:', error.message);
    return null;
  });
  const note = learningNote(learned, correction);
  const ratingNote = formatRatingContext(ratingContext);
  const instructions = [
    buildInstructions(message, learned, correction, adminMode),
    'For Genshin build questions and natural follow-ups such as شرايك ببيلدي or وش أغير, use the verified Discord rating exchange below when it exists. It is the real prior Neverless rating reply and is more authoritative than an empty local build-history file.',
    ratingNote || '',
    note ? `Learning context: ${note}` : '',
  ].filter(Boolean).join('\n\n');
  const executeTool = createServerToolExecutor({ guild: message.guild, requester: message.member, adminMode });

  await message.channel.sendTyping().catch(() => {});
  const result = await runWithTools({
    turns,
    userText: text,
    instructions,
    toolDefinitions: TOOL_DEFINITIONS,
    executeTool,
    admin: adminMode,
    allowWeb: true,
  });

  appendTurn(userId, 'user', text);
  appendTurn(userId, 'assistant', result.text);
  await sendAnswer(message, result.text);
}

async function initialize(client) {
  const ask = client.channels.cache.get(ASK_CHANNEL_ID) || await client.channels.fetch(ASK_CHANNEL_ID).catch(() => null);
  const admin = client.channels.cache.get(ADMIN_CHANNEL_ID) || await client.channels.fetch(ADMIN_CHANNEL_ID).catch(() => null);
  const guild = ask?.guild || admin?.guild || null;
  if (!guild) return console.warn('[neverless-ai] AI channels were not found.');
  readyGuildId = guild.id;
  await initLongTermMemory(guild, client.user.id).catch((error) => console.warn('[neverless-ai] Long-term memory init failed:', error.message));
  startBackfill(guild);
  console.log(`[neverless-ai] Ready. Provider=${providerLabel()} key=${configured() ? 'configured' : 'missing'}.`);
}

function installNeverlessAI(client) {
  if (installed) return;
  installed = true;
  client.once('ready', () => initialize(client).catch((error) => console.error('[neverless-ai] Initialization failed:', error)));
  client.on('messageCreate', (message) => {
    if (message?.guildId) captureMessage(message);
    if (!AI_CHANNELS.has(message?.channelId)) return;
    Promise.resolve(shouldHandle(message, client)).then((handled) => {
      if (!handled) return;
      enqueue(message, () => handleAIMessage(message)).catch((error) => {
        console.error('[neverless-ai] Conversation failed:', error);
        message.reply({ content: friendlyAIError(error), allowedMentions: { repliedUser: false } }).catch(() => {});
      });
    }).catch(() => {});
  });
  client.on('messageUpdate', (_oldMessage, newMessage) => { if (newMessage?.guildId) captureMessage(newMessage); });
  client.on('messageDelete', (message) => { if (message?.guildId) removeMessage(message); });
  client.on('guildCreate', (guild) => { if (!readyGuildId || guild.id === readyGuildId) startBackfill(guild); });
}

module.exports = { installNeverlessAI, friendlyAIError, ASK_CHANNEL_ID, ADMIN_CHANNEL_ID };
