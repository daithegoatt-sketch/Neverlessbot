'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { getAllLinkedUsers } = require('./accountStore');
const { fetchAccount } = require('./enkaClient');
const { rateVisibleAccount } = require('./liveAccountRating');
const { accountScoreFromRated } = require('./leaderboard');
const { getCharacterNames } = require('./dataClient');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';
const ROLE_PREFIX = 'Top ';
const NEVERLESS_ROLE = 'Top Neverless';
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const PERIODIC_REFRESH_MS = 60 * 60 * 1000;

const scheduled = new Map();
const refreshQueues = new Map();
const lastRefresh = new Map();
let installed = false;

function topPercent(value) {
  const number = Number(value?.topPercent ?? value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function characterCompare(a, b) {
  return Number(b?.score || 0) - Number(a?.score || 0)
    || (topPercent(a?.akasha) ?? 999) - (topPercent(b?.akasha) ?? 999)
    || Number(b?.artifactQuality || 0) - Number(a?.artifactQuality || 0);
}

function accountCompare(a, b) {
  return Number(b?.accountScore || 0) - Number(a?.accountScore || 0)
    || Number(b?.averageBuild || 0) - Number(a?.averageBuild || 0);
}

function chooseCharacterWinner(rows) {
  return [...(rows || [])]
    .filter((row) => Number.isFinite(Number(row?.score)) && Number(row.score) > 0)
    .sort(characterCompare)[0] || null;
}

function chooseAccountWinner(rows) {
  return [...(rows || [])]
    .filter((row) => Number.isFinite(Number(row?.accountScore)) && Number(row.accountScore) > 0)
    .sort(accountCompare)[0] || null;
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try { out[index] = await mapper(items[index], index); } catch { out[index] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return out;
}

function safeRoleName(name) {
  return `${ROLE_PREFIX}${String(name || '').trim()}`.slice(0, 100);
}

async function ensureTopRole(guild, roleName, create = true) {
  let role = guild.roles.cache.find((item) => item.name === roleName) || null;
  if (!role && create) {
    role = await guild.roles.create({
      name: roleName,
      permissions: [],
      reason: 'Neverless Genshin leaderboard achievement',
    }).catch((error) => {
      console.warn(`[genshin-achievements] Could not create ${roleName}: ${error.message}`);
      return null;
    });
  }
  return role;
}

async function syncRoleOwner(guild, roleName, winnerId, options = {}) {
  const me = guild.members.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    console.warn('[genshin-achievements] Missing Manage Roles permission.');
    return false;
  }

  const role = await ensureTopRole(guild, roleName, Boolean(winnerId) || options.createEmpty);
  if (!role) return false;
  if (!role.editable) {
    console.warn(`[genshin-achievements] Role ${roleName} is above the bot or otherwise not editable.`);
    return false;
  }

  const winner = winnerId
    ? guild.members.cache.get(String(winnerId)) || await guild.members.fetch(String(winnerId)).catch(() => null)
    : null;

  const remove = [...role.members.values()].filter((member) => !winner || member.id !== winner.id);
  await mapLimit(remove, 3, (member) => member.roles.remove(role, 'Neverless top achievement transferred'));
  if (winner && !winner.roles.cache.has(role.id)) {
    await winner.roles.add(role, 'Neverless top achievement earned').catch((error) => {
      console.warn(`[genshin-achievements] Could not add ${roleName} to ${winner.user?.tag || winner.id}: ${error.message}`);
    });
  }
  return true;
}

async function linkedGuildUsers(guild) {
  const links = getAllLinkedUsers();
  const rows = await mapLimit(links, 5, async (link) => {
    const member = guild.members.cache.get(String(link.discordUserId))
      || await guild.members.fetch(String(link.discordUserId)).catch(() => null);
    return member ? { ...link, member } : null;
  });
  return rows.filter(Boolean);
}

async function collectState(guild) {
  const users = await linkedGuildUsers(guild);
  const accounts = await mapLimit(users, 2, async (link) => {
    const account = await fetchAccount(link.uid);
    const current = await rateVisibleAccount(link.uid, account);
    const rated = current.rated || [];
    const scored = accountScoreFromRated(rated);
    return {
      discordUserId: link.discordUserId,
      uid: link.uid,
      rated,
      accountScore: scored.accountScore,
      averageBuild: scored.topAverage,
    };
  });

  const topByCharacter = new Map();
  const accountRows = [];
  for (const row of accounts.filter(Boolean)) {
    if (row.accountScore > 0) accountRows.push(row);
    for (const build of row.rated) {
      if (!Number.isFinite(Number(build?.score)) || Number(build.score) <= 0 || !build.name) continue;
      const candidate = {
        discordUserId: row.discordUserId,
        name: build.name,
        score: build.score,
        akasha: build.akasha,
        artifactQuality: build.artifactQuality,
      };
      const current = topByCharacter.get(build.name);
      if (!current || characterCompare(candidate, current) < 0) topByCharacter.set(build.name, candidate);
    }
  }

  return {
    topByCharacter,
    accountWinner: chooseAccountWinner(accountRows),
  };
}

async function cleanupStaleCharacterRoles(guild, activeNames) {
  let names = [];
  try { names = await getCharacterNames(); } catch { return; }
  const validRoleNames = new Set(names.map((name) => safeRoleName(name)));
  const active = new Set([...activeNames].map((name) => safeRoleName(name)));
  const stale = [...guild.roles.cache.values()].filter((role) =>
    validRoleNames.has(role.name) && !active.has(role.name),
  );
  await mapLimit(stale, 3, (role) => syncRoleOwner(guild, role.name, null, { createEmpty: false }));
}

async function refreshAchievementRolesUnlocked(guild) {
  if (!guild) return false;
  await guild.members.fetch().catch(() => null);
  const state = await collectState(guild);

  const characterRows = [...state.topByCharacter.values()];
  await mapLimit(characterRows, 3, (winner) =>
    syncRoleOwner(guild, safeRoleName(winner.name), winner.discordUserId));

  await cleanupStaleCharacterRoles(guild, state.topByCharacter.keys());
  await syncRoleOwner(
    guild,
    NEVERLESS_ROLE,
    state.accountWinner?.discordUserId || null,
    { createEmpty: Boolean(state.accountWinner) },
  );

  lastRefresh.set(guild.id, Date.now());
  console.log(`[genshin-achievements] Refreshed ${characterRows.length} character Top roles in ${guild.name}.`);
  return true;
}

function refreshAchievementRoles(guild, options = {}) {
  if (!guild?.id) return Promise.resolve(false);
  const force = Boolean(options.force);
  if (!force && Date.now() - (lastRefresh.get(guild.id) || 0) < REFRESH_COOLDOWN_MS) {
    return Promise.resolve(false);
  }

  const previous = refreshQueues.get(guild.id) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => refreshAchievementRolesUnlocked(guild));
  const queued = task.finally(() => {
    if (refreshQueues.get(guild.id) === queued) refreshQueues.delete(guild.id);
  });
  refreshQueues.set(guild.id, queued);
  return task;
}

function scheduleAchievementRefresh(guild, options = {}) {
  if (!guild?.id) return;
  const key = guild.id;
  const old = scheduled.get(key);
  if (old) clearTimeout(old);
  const delay = Number.isFinite(options.delay) ? Math.max(0, options.delay) : 12_000;
  const timer = setTimeout(() => {
    scheduled.delete(key);
    refreshAchievementRoles(guild, { force: Boolean(options.force) }).catch((error) => {
      console.warn(`[genshin-achievements] Refresh failed in ${guild.name}: ${error.message}`);
    });
  }, delay);
  timer.unref?.();
  scheduled.set(key, timer);
}

async function syncCharacterAchievement(guild, board) {
  const winner = chooseCharacterWinner(board?.rows || []);
  if (!board?.characterName) return false;
  return syncRoleOwner(guild, safeRoleName(board.characterName), winner?.discordUserId || null, {
    createEmpty: Boolean(winner),
  });
}

async function syncNeverlessAchievement(guild, board) {
  const winner = chooseAccountWinner(board?.rows || []);
  return syncRoleOwner(guild, NEVERLESS_ROLE, winner?.discordUserId || null, {
    createEmpty: Boolean(winner),
  });
}

function shouldRefreshFromMessage(content) {
  const text = String(content || '');
  return /(?:ربط\s+UID|فك\s+ربط|unlink\s+UID|link\s+UID|تقييم|rate\b|rating\b|ترتيب|leaderboard|ranking|قارن.*بالسيرفر|هل.*خلص.*بيلد|أضعف\s+(?:قطعة|قطعه|شخصية)|قيم\s+(?:إحصائيات|احصائيات)|شنو\s+يمنع|وش\s+يمنع|فلكس|فليكس|flix\s+build|flex\s+build)/iu.test(text);
}

function isLinkMutation(content) {
  return /(?:ربط\s+UID|فك\s+ربط|unlink\s+UID|link\s+UID)/iu.test(String(content || ''));
}

function installAchievementRoles(client) {
  if (installed) return;
  installed = true;

  client.once('ready', () => {
    for (const guild of client.guilds.cache.values()) {
      scheduleAchievementRefresh(guild, { delay: 20_000, force: true });
    }
    const timer = setInterval(() => {
      for (const guild of client.guilds.cache.values()) scheduleAchievementRefresh(guild, { delay: 1_000, force: false });
    }, PERIODIC_REFRESH_MS);
    timer.unref?.();
  });

  client.on('guildCreate', (guild) => scheduleAchievementRefresh(guild, { delay: 20_000, force: true }));
  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot || message.channelId !== CHANNEL_ID) return;
    if (!shouldRefreshFromMessage(message.content)) return;
    scheduleAchievementRefresh(message.guild, {
      delay: isLinkMutation(message.content) ? 15_000 : 12_000,
      force: isLinkMutation(message.content),
    });
  });
}

module.exports = {
  installAchievementRoles,
  refreshAchievementRoles,
  scheduleAchievementRefresh,
  syncCharacterAchievement,
  syncNeverlessAchievement,
  chooseCharacterWinner,
  chooseAccountWinner,
  characterCompare,
  accountCompare,
  safeRoleName,
};
