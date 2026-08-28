'use strict';

const MAX_NICKNAME_LENGTH = 32;

function parseNicknameCommand(content) {
  const match = String(content || '').match(/^\s*-نك(?:\s+([\s\S]*?))?\s*$/u);
  if (!match) return null;
  const raw = String(match[1] || '').replace(/\s+/g, ' ').trim();
  return { nickname: raw || null };
}

async function handleNicknameCommand(message) {
  const parsed = parseNicknameCommand(message?.content);
  if (!parsed || !message?.guildId || message.author?.bot) return false;

  if (parsed.nickname && parsed.nickname.length > MAX_NICKNAME_LENGTH) {
    await message.reply({
      content: `النيكنيم لازم يكون ${MAX_NICKNAME_LENGTH} حرف أو أقل.`,
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
    return true;
  }

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) {
    await message.reply({ content: 'ما قدرت أوصل لعضويتك داخل السيرفر.', allowedMentions: { repliedUser: false } }).catch(() => {});
    return true;
  }

  try {
    await member.setNickname(parsed.nickname, `Neverless self nickname command by ${message.author.id}`);
    await message.reply({
      content: parsed.nickname ? `تم تغيير النيكنيم إلى **${parsed.nickname}**.` : 'تم حذف النيكنيم ورجعت لاسم حسابك.',
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    console.warn('[nickname] Failed to update nickname:', error.message);
    await message.reply({
      content: 'ما قدرت أغير النيكنيم. تأكد أن رتبة Neverless Bot أعلى من رتبتك وعنده صلاحية **Manage Nicknames**.',
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
  }
  return true;
}

function installNicknameCommand(client) {
  if (client.__neverlessNicknameCommandInstalled) return;
  client.__neverlessNicknameCommandInstalled = true;

  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot) return;
    if (!parseNicknameCommand(message.content)) return;
    handleNicknameCommand(message).catch((error) => console.error('[nickname] Command failed:', error));
  });
}

module.exports = {
  installNicknameCommand,
  handleNicknameCommand,
  parseNicknameCommand,
  MAX_NICKNAME_LENGTH,
};
