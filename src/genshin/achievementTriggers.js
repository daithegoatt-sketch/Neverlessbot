'use strict';

const { scheduleAchievementRefresh } = require('./achievementRoles');
const { whenAccountStoreReady } = require('./accountStore');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';
const PERIODIC_REFRESH_MS = 60 * 60 * 1000;
let installed = false;

function hasBotMention(message, client) {
  const id = client.user?.id;
  if (!id) return false;
  if (message.mentions?.users?.has?.(id)) return true;
  return new RegExp(`<@!?${id}>`).test(String(message.content || ''));
}

function shouldRefreshFromMessage(content) {
  const text = String(content || '');
  return /(?:ربط\s+UID|فك\s+ربط|unlink\s+UID|link\s+UID|تقييم|rate\b|rating\b|ترتيب|leaderboard|ranking|قارن.*بالسيرفر|هل.*خلص.*بيلد|أضعف\s+(?:قطعة|قطعه|شخصية)|قيم\s+(?:إحصائيات|احصائيات)|شنو\s+يمنع|وش\s+يمنع|فلكس|فليكس|flix\s+build|flex\s+build)/iu.test(text);
}

function isLinkMutation(content) {
  return /(?:ربط\s+UID|فك\s+ربط|unlink\s+UID|link\s+UID)/iu.test(String(content || ''));
}

function isRankingRequest(content) {
  return /(?:ترتيب|leaderboard|ranking)/iu.test(String(content || ''));
}

function installAchievementTriggers(client) {
  if (installed) return;
  installed = true;

  client.once('ready', async () => {
    await whenAccountStoreReady().catch(() => {});
    for (const guild of client.guilds.cache.values()) {
      scheduleAchievementRefresh(guild, { delay: 5_000, force: true });
    }
    const timer = setInterval(() => {
      for (const guild of client.guilds.cache.values()) {
        scheduleAchievementRefresh(guild, { delay: 1_000, force: false });
      }
    }, PERIODIC_REFRESH_MS);
    timer.unref?.();
  });

  client.on('guildCreate', (guild) => {
    scheduleAchievementRefresh(guild, { delay: 20_000, force: true });
  });

  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot || message.channelId !== CHANNEL_ID) return;
    if (!hasBotMention(message, client) || !shouldRefreshFromMessage(message.content)) return;
    const mutation = isLinkMutation(message.content);
    const ranking = isRankingRequest(message.content);
    scheduleAchievementRefresh(message.guild, {
      delay: mutation ? 25_000 : 12_000,
      force: mutation || ranking,
    });
  });
}

module.exports = {
  installAchievementTriggers,
  hasBotMention,
  shouldRefreshFromMessage,
  isLinkMutation,
  isRankingRequest,
};
