'use strict';

const GENERAL_CHAT_ID = '1537605789521543251';

const GREETINGS = new Map([
  ['السلام عليكم', 'وعليكم السلام ورحمة الله وبركاته'],
  ['صباح الخير', 'صباح النور'],
  ['تصبحون علي خير', 'وانت من أهل الخير'],
  ['مساء الخير', 'مساء النور'],
]);

let installed = false;

function normalizeGreeting(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '')
    .replace(/\u0640/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function greetingReply(content) {
  return GREETINGS.get(normalizeGreeting(content)) || null;
}

async function handleGreetingMessage(message) {
  if (!message?.guildId || message.author?.bot || message.channelId !== GENERAL_CHAT_ID) return false;
  const reply = greetingReply(message.content);
  if (!reply) return false;

  await message.channel.send({
    content: `<@${message.author.id}> ${reply}`,
    allowedMentions: { users: [message.author.id] },
  });
  return true;
}

async function handleGeneralWelcome(member) {
  if (!member?.guild || member.user?.bot) return false;
  const channel = member.guild.channels.cache.get(GENERAL_CHAT_ID)
    || await member.guild.channels.fetch(GENERAL_CHAT_ID).catch(() => null);
  if (!channel?.isSendable?.()) return false;

  await channel.send({
    content: `<@${member.id}> نورتوا سيرفر Neverless`,
    allowedMentions: { users: [member.id] },
  });
  return true;
}

function installGeneralChatGreetings(client) {
  if (installed) return;
  installed = true;

  client.on('messageCreate', (message) => {
    handleGreetingMessage(message).catch((error) => {
      console.warn(`[general-greetings] Reply failed: ${error.message}`);
    });
  });

  client.on('guildMemberAdd', (member) => {
    handleGeneralWelcome(member).catch((error) => {
      console.warn(`[general-greetings] Welcome failed: ${error.message}`);
    });
  });
}

module.exports = {
  GENERAL_CHAT_ID,
  normalizeGreeting,
  greetingReply,
  handleGreetingMessage,
  handleGeneralWelcome,
  installGeneralChatGreetings,
};
