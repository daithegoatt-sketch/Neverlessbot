'use strict';

// Production command room is intentionally pinned so stale Railway config cannot move Activity commands.
process.env.ACTIVITY_CHANNEL_ID = '1538570405617598505';

const { Client } = require('discord.js');
const { handleGenshinMessage } = require('./assistantV3');
const { handleRatingMessage } = require('./ratingV4');
const { handleAdvancedMessage } = require('./advancedFeatures');
const { handleAccountAdvisorMessage } = require('./accountAdvisor');
const { handleProfileMessage } = require('./profileRouter');
const { handleArtifactReviewMessage } = require('./artifactRouter');
const { handleUidMessage } = require('./uidRouter');
const { handleHelpMessage } = require('./helpRouter');
const { handleGenshinExtrasMessage, installGenshinExtras } = require('./genshinExtras');
const { handleExtrasCorrectionsMessage } = require('./extrasCorrections');
const { installPublicFunV2, isPublicFunCommand } = require('./publicFunV2');
const { installAchievementTriggers } = require('./achievementTriggers');
const { rewriteCharacterAliases } = require('./characterAliases');
const { initDiscordPersistence, whenAccountStoreReady } = require('./accountStore');
const { installPublicGenshinCommands, isPublicGenshinCommand } = require('./publicCommands');
const { installModeration } = require('../moderation');
const { installActivity } = require('../activityV2');
const { installServerTools } = require('../serverTools');
const { installTempVoicePersistence } = require('../tempVoicePersistence');
const { installAutoMod } = require('../autoMod');
const { installAntiRaid } = require('../antiRaid');
const { installGameLobby } = require('../gameLobby');
const { installNicknameCommand } = require('../nicknameCommand');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';
const TEST_CHANNEL_ID = process.env.GENSHIN_TEST_CHANNEL_ID || '1539226931319545936';
const ALLOWED_CHANNELS = new Set([CHANNEL_ID, TEST_CHANNEL_ID]);
const SUPPRESS_NOTIFICATIONS_FLAG = 4096;
const originalLogin = Client.prototype.login;

function hasBotMention(message, client) {
  const id = client.user?.id;
  if (!id) return false;
  if (message.mentions?.users?.has?.(id)) return true;
  return new RegExp(`<@!?${id}>`).test(String(message.content || ''));
}

function cleanContent(message, client) {
  const id = client.user?.id;
  let value = String(message.content || '');
  if (id) value = value.replace(new RegExp(`<@!?${id}>`, 'g'), ' ');
  return rewriteCharacterAliases(value.replace(/\s+/g, ' ').trim());
}

function sanitizeLegacyExamples(content) {
  return String(content || '')
    .replace(/ربط\s+UID\s+729663359/giu, 'ربط UID 7XXXXXXXXX')
    .replace(/link\s+UID\s+729663359/giu, 'link UID 7XXXXXXXXX');
}

function leaderboardMentionIds(content) {
  const value = String(content || '');
  if (!/^\*\*(?:ترتيب|Leaderboard|Neverless Account Leaderboard)/u.test(value)) return [];
  return [...new Set([...value.matchAll(/<@!?(\d{15,22})>/g)].map((match) => match[1]))].slice(0, 100);
}

function replyPayload(message, payload) {
  if (typeof payload === 'string') return { content: sanitizeLegacyExamples(payload), allowedMentions: { repliedUser: false } };
  const next = { ...(payload || {}) };
  if (typeof next.content === 'string') {
    const authorId = message.author?.id;
    if (authorId) next.content = next.content.replace(new RegExp(`^<@!?${authorId}>\\s*`), '');
    next.content = sanitizeLegacyExamples(next.content);
  }
  const rankingUsers = leaderboardMentionIds(next.content);
  next.allowedMentions = {
    ...(next.allowedMentions || {}),
    ...(rankingUsers.length ? { users: rankingUsers } : {}),
    repliedUser: false,
  };
  if (rankingUsers.length) next.flags = (Number(next.flags) || 0) | SUPPRESS_NOTIFICATIONS_FLAG;
  return next;
}

function wrappedMessage(message, client) {
  const content = cleanContent(message, client);
  const channel = new Proxy(message.channel, {
    get(target, prop) {
      if (prop === 'send') return (payload) => message.reply(replyPayload(message, payload));
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(message, {
    get(target, prop) {
      if (prop === 'content') return content;
      if (prop === 'channel') return channel;
      if (prop === 'channelId' && target.channelId === TEST_CHANNEL_ID) return CHANNEL_ID;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

Client.prototype.login = function neverlessGenshinLogin(token) {
  if (!this.__neverlessGenshinInstalled) {
    this.__neverlessGenshinInstalled = true;
    this.once('ready', () => {
      initDiscordPersistence(this, CHANNEL_ID).catch((error) => {
        console.warn('[genshin-store] Persistent store initialization failed:', error.message);
      });
    });

    installServerTools(this);
    installModeration(this);
    installActivity(this);
    installNicknameCommand(this);
    installTempVoicePersistence(this);
    installAutoMod(this);
    installAntiRaid(this);
    installGameLobby(this);
    installAchievementTriggers(this);
    installGenshinExtras(this);
    installPublicFunV2(this);
    installPublicGenshinCommands(this, ALLOWED_CHANNELS);

    this.on('messageCreate', (message) => {
      if (!message?.guildId || message.author?.bot || !ALLOWED_CHANNELS.has(message.channelId)) return;
      // Public prefix tools have their own server-wide handlers and do not need a mention.
      if (isPublicGenshinCommand(message.content) || isPublicFunCommand(message.content)) return;
      if (!hasBotMention(message, this)) return;

      const wrapped = wrappedMessage(message, this);
      if (!String(wrapped.content || '').trim()) {
        message.reply({
          content: 'اسألني عن قينشن بعد المنشن، مثال: `بيلد Alyosha` أو `تقييم Skirk بحسابي` أو `Help`.',
          allowedMentions: { repliedUser: false },
        }).catch(() => {});
        return;
      }

      Promise.resolve()
        .then(() => whenAccountStoreReady())
        .then(() => handleUidMessage(wrapped))
        .then((handled) => handled ? true : handleHelpMessage(wrapped))
        .then((handled) => handled ? true : handleArtifactReviewMessage(wrapped))
        .then((handled) => handled ? true : handleProfileMessage(wrapped))
        .then((handled) => handled ? true : handleExtrasCorrectionsMessage(wrapped))
        .then((handled) => handled ? true : handleGenshinExtrasMessage(wrapped))
        .then((handled) => handled ? true : handleAccountAdvisorMessage(wrapped))
        .then((handled) => handled ? true : handleAdvancedMessage(wrapped))
        .then((handled) => handled ? true : handleRatingMessage(wrapped))
        .then((handled) => handled ? true : handleGenshinMessage(wrapped))
        .catch((error) => console.error('[genshin] Unhandled message error:', error));
    });
    console.log('[genshin] Neverless Genshin advanced mention-only reply mode installed.');
  }
  return originalLogin.call(this, token);
};
