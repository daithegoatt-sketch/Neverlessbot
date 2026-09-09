'use strict';

const {
  getLinkedUid,
  isUidLocked,
  setUidLocked,
  whenAccountStoreReady,
} = require('./accountStore');

let installed = false;

function normalizeCommand(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '')
    .replace(/\u0640/gu, '')
    .replace(/[إأآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stripBotMention(message, client) {
  const botId = client.user?.id;
  let value = String(message?.content || '');
  if (botId) value = value.replace(new RegExp(`<@!?${botId}>`, 'g'), ' ');
  return value.replace(/\s+/g, ' ').trim();
}

function hasBotMention(message, client) {
  const botId = client.user?.id;
  if (!botId) return false;
  if (message?.mentions?.users?.has?.(botId)) return true;
  return new RegExp(`<@!?${botId}>`).test(String(message?.content || ''));
}

function parseUidCommand(message, client) {
  if (!message?.guildId || message.author?.bot || !hasBotMention(message, client)) return null;

  const raw = stripBotMention(message, client);
  const text = normalizeCommand(raw);
  if (!text) return null;

  const isUidWord = (token) => ['uid', 'id', 'ايدي', 'ايد'].includes(token);
  const tokens = text.split(' ').filter(Boolean);

  const lockRequested = (
    (tokens[0] === 'lock' && tokens.some(isUidWord))
    || (tokens[0] === 'قفل' && tokens.some(isUidWord))
    || /^قفل (?:ال )?(?:ايدي|ايد)$/u.test(text)
  );
  if (lockRequested) return { type: 'lock' };

  const unlockRequested = (
    (tokens[0] === 'unlock' && tokens.some(isUidWord))
    || (tokens[0] === 'فتح' && tokens.some(isUidWord))
    || /^فتح (?:ال )?(?:ايدي|ايد)$/u.test(text)
  );
  if (unlockRequested) return { type: 'unlock' };

  if (tokens.some(isUidWord)) return { type: 'lookup' };
  return null;
}

function mentionedTarget(message, client) {
  const botId = client.user?.id;
  return message.mentions?.users?.find?.((user) => user.id !== botId && !user.bot) || null;
}

async function sendPlain(message, content, mentionedUserIds = []) {
  if (!message.channel?.isSendable?.()) return;
  await message.channel.send({
    content,
    allowedMentions: { users: mentionedUserIds, roles: [], repliedUser: false },
  });
}

async function handleUidLookupMessage(message, client) {
  const command = parseUidCommand(message, client);
  if (!command) return false;

  await whenAccountStoreReady().catch(() => {});
  const actorId = message.author.id;

  if (command.type === 'lock' || command.type === 'unlock') {
    const uid = getLinkedUid(actorId);
    if (!uid) {
      await sendPlain(message, 'ما عندك UID مربوط حاليًا. اربطه أولًا من روم التقييم.');
      return true;
    }

    const locked = command.type === 'lock';
    await setUidLocked(actorId, locked);
    await sendPlain(
      message,
      locked
        ? 'تم إخفاء UID الخاص بك. الأعضاء لن يستطيعوا جلبه عبر أمر UID.'
        : 'تم إلغاء إخفاء UID الخاص بك. أصبح بإمكان الأعضاء جلبه عبر أمر UID.',
    );
    return true;
  }

  const target = mentionedTarget(message, client) || message.author;
  const uid = getLinkedUid(target.id);
  if (!uid) {
    await sendPlain(
      message,
      target.id === actorId
        ? 'ما عندك UID مربوط حاليًا. اربطه أولًا من روم التقييم.'
        : `<@${target.id}> ما ربط UID بحسابه حتى الآن.`,
      target.id === actorId ? [] : [target.id],
    );
    return true;
  }

  if (target.id !== actorId && isUidLocked(target.id)) {
    await sendPlain(message, `قام <@${target.id}> بإخفاء الايدي الخاص به.`, [target.id]);
    return true;
  }

  await sendPlain(
    message,
    target.id === actorId
      ? `UID الخاص بك: **${uid}**`
      : `UID الخاص بـ <@${target.id}>: **${uid}**`,
    target.id === actorId ? [] : [target.id],
  );
  return true;
}

function isUidLookupCommand(message, client) {
  return Boolean(parseUidCommand(message, client));
}

function installUidLookup(client) {
  if (installed) return;
  installed = true;
  client.on('messageCreate', (message) => {
    handleUidLookupMessage(message, client).catch((error) => {
      console.error('[uid-lookup] message error:', error);
    });
  });
}

module.exports = {
  installUidLookup,
  handleUidLookupMessage,
  isUidLookupCommand,
  parseUidCommand,
  normalizeCommand,
};
