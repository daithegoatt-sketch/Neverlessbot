'use strict';

const {
  parsePublicFunCommand,
  handlePublicFunCommand,
  isPublicFunCommand,
} = require('./publicFun');
const { handleQuizCommand, installQuizEngine } = require('./quizEngine');

let installed = false;

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

async function handlePublicFunV2Command(message, parsed = parsePublicFunCommand(message?.content)) {
  if (!parsed) return false;
  if (parsed.type === 'quiz') return handleQuizCommand(message, language(message.content));
  return handlePublicFunCommand(message, parsed);
}

function installPublicFunV2(client) {
  if (installed) return;
  installed = true;
  installQuizEngine(client);

  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot) return;
    const parsed = parsePublicFunCommand(message.content);
    if (!parsed) return;
    handlePublicFunV2Command(message, parsed).catch((error) => {
      console.error('[genshin-public-fun-v2] command failed:', error);
      message.reply({
        content: 'صار خطأ أثناء تنفيذ الأمر. جرّب بعد شوي.',
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
    });
  });
}

module.exports = {
  installPublicFunV2,
  handlePublicFunV2Command,
  isPublicFunCommand,
};
