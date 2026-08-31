'use strict';

const {
  recordTopNeverless,
  handleHallOfFameMessage,
  handleNeverlessFlex,
  isHallCommand,
} = require('./achievementHall');
const { buildNeverlessLeaderboard, getCachedNeverlessLeaderboard } = require('./leaderboard');

const NEVERLESS_ROLE = 'Top Neverless';
const syncTimers = new Map();
let installed = false;

function stripBotMention(text, client) {
  const id = client?.user?.id;
  let value = String(text || '').trim();
  if (id) value = value.replace(new RegExp(`<@!?${id}>`, 'g'), ' ');
  return value.replace(/\s+/g, ' ').trim();
}

function hasBotMention(message, client) {
  const id = client?.user?.id;
  if (!id) return false;
  if (message.mentions?.users?.has?.(id)) return true;
  return new RegExp(`<@!?${id}>`).test(String(message.content || ''));
}

function isNeverlessFlexCommand(text) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  return /^[-–—]\s*(?:flex|فلكس|فليكس)\s+neverless$/iu.test(value);
}

function isHallMentionCommand(message, client) {
  if (!hasBotMention(message, client)) return false;
  return isHallCommand(stripBotMention(message.content, client));
}

function isAchievementHallCommand(message, client) {
  return isNeverlessFlexCommand(message?.content) || isHallMentionCommand(message, client);
}

function roleMembershipChanged(oldMember, newMember) {
  const oldHas = oldMember?.roles?.cache?.some?.((role) => role.name === NEVERLESS_ROLE) || false;
  const newHas = newMember?.roles?.cache?.some?.((role) => role.name === NEVERLESS_ROLE) || false;
  return oldHas !== newHas;
}

async function topRoleHolder(guild) {
  await guild.members.fetch().catch(() => null);
  const role = guild.roles.cache.find((item) => item.name === NEVERLESS_ROLE) || null;
  if (!role) return null;
  return role.members.first?.() || [...role.members.values()][0] || null;
}

async function boardRowForHolder(guild, userId) {
  let board = getCachedNeverlessLeaderboard(guild);
  let row = board?.rows?.find((item) => String(item.discordUserId) === String(userId)) || null;
  if (row) return row;
  board = await buildNeverlessLeaderboard(guild).catch((error) => {
    console.warn(`[genshin-hall] Could not refresh Neverless leaderboard: ${error.message}`);
    return null;
  });
  return board?.rows?.find((item) => String(item.discordUserId) === String(userId)) || null;
}

async function syncFromTopRole(guild, options = {}) {
  if (!guild?.id) return false;
  const holder = await topRoleHolder(guild);
  if (!holder) {
    await recordTopNeverless(guild, null, { announce: false });
    return true;
  }

  const row = await boardRowForHolder(guild, holder.id);
  if (!row) return false;
  await recordTopNeverless(guild, row, { announce: options.announce !== false });
  return true;
}

function scheduleRoleSync(guild, options = {}) {
  if (!guild?.id) return;
  const previous = syncTimers.get(guild.id);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    syncTimers.delete(guild.id);
    syncFromTopRole(guild, options).catch((error) => {
      console.warn(`[genshin-hall] Role sync failed in ${guild.name}: ${error.message}`);
    });
  }, Number.isFinite(options.delay) ? Math.max(0, options.delay) : 2500);
  timer.unref?.();
  syncTimers.set(guild.id, timer);
}

function hallMessageProxy(message, client) {
  const clean = stripBotMention(message.content, client);
  const channel = new Proxy(message.channel, {
    get(target, prop) {
      if (prop === 'send') return (payload) => message.reply({
        ...(typeof payload === 'string' ? { content: payload } : payload),
        allowedMentions: {
          ...((typeof payload === 'object' && payload?.allowedMentions) || {}),
          repliedUser: false,
        },
      });
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(message, {
    get(target, prop) {
      if (prop === 'content') return clean;
      if (prop === 'channel') return channel;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function language(text) {
  return /[\u0600-\u06ff]/u.test(String(text || '')) ? 'ar' : 'en';
}

function installAchievementHall(client) {
  if (installed) return;
  installed = true;

  client.once('ready', () => {
    for (const guild of client.guilds.cache.values()) {
      // Seed/reconcile silently after a restart. A restart must never look like a new champion announcement.
      scheduleRoleSync(guild, { delay: 10_000, announce: false });
    }
  });

  client.on('guildCreate', (guild) => scheduleRoleSync(guild, { delay: 15_000, announce: false }));

  client.on('guildMemberUpdate', (oldMember, newMember) => {
    if (!roleMembershipChanged(oldMember, newMember)) return;
    // Achievement transfer removes the old owner and then adds the new owner. Debounce both events.
    scheduleRoleSync(newMember.guild, { delay: 2500, announce: true });
  });

  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot) return;

    if (isNeverlessFlexCommand(message.content)) {
      handleNeverlessFlex(message, language(message.content)).catch((error) => {
        console.error('[genshin-hall] Neverless flex failed:', error);
        message.reply({ content: 'صار خطأ أثناء تجهيز Top Neverless.', allowedMentions: { repliedUser: false } }).catch(() => {});
      });
      return;
    }

    if (isHallMentionCommand(message, client)) {
      handleHallOfFameMessage(hallMessageProxy(message, client)).catch((error) => {
        console.error('[genshin-hall] Hall of Fame failed:', error);
        message.reply({ content: 'صار خطأ أثناء قراءة قاعة الأبطال.', allowedMentions: { repliedUser: false } }).catch(() => {});
      });
    }
  });
}

module.exports = {
  installAchievementHall,
  isNeverlessFlexCommand,
  isHallMentionCommand,
  isAchievementHallCommand,
  roleMembershipChanged,
  stripBotMention,
};
