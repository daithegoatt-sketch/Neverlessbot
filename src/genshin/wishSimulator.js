'use strict';

const { initWishStore } = require('./wishStore');
const { showWish, showInventory, showBanner } = require('./wishCommands');
const { handleTrade } = require('./wishTrade');

const WISH_CHANNEL_ID = process.env.GENSHIN_WISH_CHANNEL_ID || '1547237991834198016';
let installed = false;

function commandType(content) {
  const text = String(content || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (/^wish\s*10$/i.test(text)) return { type: 'wish', count: 10 };
  if (/^wish(?:\s*1)?$/i.test(text) || /^wish1$/i.test(text)) return { type: 'wish', count: 1 };
  if (text === 'characters') return { type: 'characters' };
  if (text === 'weapons') return { type: 'weapons' };
  if (/^banner(?:\s+(flins|ineffa))?$/i.test(text)) return { type: 'banner', banner: text.split(' ')[1] || null };
  if (/^trade\b/i.test(text)) return { type: 'trade' };
  return null;
}

async function handleWishMessage(message) {
  if (!message?.guildId || message.author?.bot || message.channelId !== WISH_CHANNEL_ID) return false;
  const command = commandType(message.content);
  if (!command) return false;
  try {
    if (command.type === 'wish') await showWish(message, command.count);
    else if (command.type === 'characters') await showInventory(message, 'characters');
    else if (command.type === 'weapons') await showInventory(message, 'weapons');
    else if (command.type === 'banner') await showBanner(message, command.banner);
    else if (command.type === 'trade') await handleTrade(message);
  } catch (error) {
    console.error('[wish] command failed:', error);
    await message.reply({ content: 'تعذر تنفيذ أمر الـWish حاليًا.', allowedMentions: { repliedUser: false } }).catch(() => {});
  }
  return true;
}

function installWishSimulator(client) {
  if (installed) return;
  installed = true;
  client.once('ready', () => {
    initWishStore(client, WISH_CHANNEL_ID).catch((error) => console.warn(`[wish] store init failed: ${error.message}`));
  });
  client.on('messageCreate', (message) => {
    handleWishMessage(message).catch((error) => console.error('[wish] message error:', error));
  });
  console.log(`[wish] Isolated simulator installed for channel ${WISH_CHANNEL_ID}.`);
}

module.exports = { WISH_CHANNEL_ID, installWishSimulator, handleWishMessage, commandType };
