'use strict';
const { Client } = require('discord.js');
const { handleGenshinMessage } = require('./assistantV3');
const { handleRatingMessage } = require('./ratingV4');
const { handleAdvancedMessage } = require('./advancedFeatures');
const { handleArtifactReviewMessage } = require('./artifactRouter');
const { handleUidMessage } = require('./uidRouter');
const { handleHelpMessage } = require('./helpRouter');
const { rewriteCharacterAliases } = require('./characterAliases');
const { initDiscordPersistence, whenAccountStoreReady } = require('./accountStore');
const { installModeration } = require('../moderation');
const { installActivity } = require('../activityV2');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';
const TEST_CHANNEL_ID = process.env.GENSHIN_TEST_CHANNEL_ID || '1539226931319545936';
const ALLOWED_CHANNELS = new Set([CHANNEL_ID, TEST_CHANNEL_ID]);
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

function replyPayload(message, payload) {
  if (typeof payload === 'string') return { content: payload, allowedMentions: { repliedUser: false } };
  const next = { ...(payload || {}) };
  if (typeof next.content === 'string') {
    const authorId = message.author?.id;
    if (authorId) next.content = next.content.replace(new RegExp(`^<@!?${authorId}>\\s*`), '');
  }
  next.allowedMentions = { ...(next.allowedMentions || {}), repliedUser: false };
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
      // Older Genshin handlers keep their own primary-channel guard. In the private
      // test room only, expose the primary ID to those handlers while replies still
      // go to the real test channel above. No production-room behavior changes.
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

    installModeration(this);
    installActivity(this);

    this.on('messageCreate', (message) => {
      if (!message?.guildId || message.author?.bot || !ALLOWED_CHANNELS.has(message.channelId)) return;
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
        .then((handled) => handled ? true : handleAdvancedMessage(wrapped))
        .then((handled) => handled ? true : handleRatingMessage(wrapped))
        .then((handled) => handled ? true : handleGenshinMessage(wrapped))
        .catch((error) => {
          console.error('[genshin] Unhandled message error:', error);
        });
    });
    console.log('[genshin] Neverless Genshin advanced mention-only reply mode installed.');
  }
  return originalLogin.call(this, token);
};
