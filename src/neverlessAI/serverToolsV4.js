'use strict';

const fs = require('node:fs');
const path = require('node:path');
const base = require('./serverToolsV2');
const { DATA_DIR } = require('../store');
const { levelFromXp, xpRemainingForNextLevel, periodScore } = require('../activityV2');
const {
  buildCharacterLeaderboard,
  buildNeverlessLeaderboard,
  getCachedNeverlessLeaderboard,
} = require('../genshin/leaderboard');
const { getGuide } = require('../genshin/guideClient');
const { resolveCharacter } = require('../genshin/characterResolver');
const { getCurrentTheaterSeason, resolveDifficulty, DIFFICULTIES } = require('../genshin/theaterClient');
const { buildTeam, curatedNames } = require('../genshin/theaterPlanner');
const { searchCommandCatalog } = require('./commandCatalog');

const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');

const KNOWLEDGE_TOOLS = [
  {
    type: 'function',
    name: 'search_neverless_commands',
    description: 'Search the verified current Neverless command catalog. MUST be used before naming or recommending an exact Neverless command syntax. If no verified command is returned, do not invent one.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of what the user wants the command to do.' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_server_members',
    description: 'Read Neverless server members without changing anything. Use for requests to list, search, count, or randomly choose actual server members. Bots are excluded by default.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional name filter.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        random: { type: 'boolean', description: 'Randomly choose from matching human members.' },
        include_bots: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_activity_leaderboard',
    description: 'Read the real Neverless Activity ranking from the same persisted Activity V2 data. Use for who is most active/top activity, including daily, weekly, monthly or all-time.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['all', 'daily', 'weekly', 'monthly'] },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_invite_leaderboard',
    description: 'Read the real Neverless invite ranking from Activity V2 persisted data.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_character_ranking',
    description: 'Read the official Neverless ranking for a Genshin character. For a simple question like who has the best Skirk, use full=false to read the current Top <Character> achievement role quickly. Use full=true only when the user explicitly asks for the full ranking/list; that runs the existing Neverless leaderboard system and may take longer.',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string' },
        full: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['character'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_neverless_account_ranking',
    description: 'Read Top Neverless/account ranking. With full=false, return the current Top Neverless role holder quickly. With full=true, use the latest cached official account leaderboard when available, or rebuild it if explicitly requested.',
    parameters: {
      type: 'object',
      properties: {
        full: { type: 'boolean' },
        refresh: { type: 'boolean', description: 'Only true when the user explicitly asks for a fresh/full ranking.' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_genshin_guide',
    description: 'Read Neverless source-backed Genshin guide data for one character: role, stat targets/priority, weapons, artifacts, combos and verified team options. Use for general build/team questions instead of inventing teams.',
    parameters: {
      type: 'object',
      properties: { character: { type: 'string' } },
      required: ['character'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_current_theater_knowledge',
    description: 'Read the same current Imaginarium Theater season and route used by Neverless. Optionally build the existing theoretical route for a difficulty using the Theater planner logic.',
    parameters: {
      type: 'object',
      properties: {
        difficulty: { type: 'string', description: 'Optional Easy, Normal, Hard, Visionary, Lunar, or Arabic equivalent.' },
      },
      additionalProperties: false,
    },
  },
];

const TOOL_DEFINITIONS = [...base.TOOL_DEFINITIONS, ...KNOWLEDGE_TOOLS];

function readActivity() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function shuffle(values) {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const j = Math.floor(Math.random() * (index + 1));
    [out[index], out[j]] = [out[j], out[index]];
  }
  return out;
}

function compactMember(member) {
  return {
    id: member.id,
    name: member.displayName || member.user?.globalName || member.user?.username || member.id,
    username: member.user?.username || null,
    bot: Boolean(member.user?.bot),
  };
}

async function activityRows(guild, period = 'all', limit = 10) {
  const parsed = readActivity();
  const users = parsed?.guilds?.[guild.id]?.users || {};
  const rows = Object.entries(users).map(([userId, record]) => ({
    userId,
    record,
    score: periodScore(record, period),
  })).filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.record?.allXp || 0) - Number(a.record?.allXp || 0))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 10)));

  const output = [];
  for (const row of rows) {
    const member = guild.members.cache.get(row.userId) || await guild.members.fetch(row.userId).catch(() => null);
    if (!member || member.user?.bot) continue;
    const totalXp = Number(row.record?.allXp) || 0;
    output.push({
      member: compactMember(member),
      period,
      period_xp: row.score,
      total_xp: totalXp,
      level: levelFromXp(totalXp),
      xp_to_next_level: xpRemainingForNextLevel(totalXp),
      invites: Number(row.record?.invites) || 0,
    });
  }
  return output;
}

async function inviteRows(guild, limit = 10) {
  const parsed = readActivity();
  const users = parsed?.guilds?.[guild.id]?.users || {};
  const rows = Object.entries(users)
    .map(([userId, record]) => ({ userId, invites: Number(record?.invites) || 0, allXp: Number(record?.allXp) || 0 }))
    .filter((row) => row.invites > 0)
    .sort((a, b) => b.invites - a.invites || b.allXp - a.allXp)
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 10)));
  const output = [];
  for (const row of rows) {
    const member = guild.members.cache.get(row.userId) || await guild.members.fetch(row.userId).catch(() => null);
    if (!member || member.user?.bot) continue;
    output.push({ member: compactMember(member), invites: row.invites });
  }
  return output;
}

function compactCharacterRow(row) {
  const stats = row?.snapshot?.stats || {};
  return {
    member_id: row.discordUserId,
    name: row.displayName,
    score: Number(row.score) || 0,
    ranking_score: Number(row.rankingScore ?? row.evaluation?.rankingScore ?? row.score) || 0,
    akasha_top_percent: Number(row.akasha?.topPercent ?? row.akasha) || null,
    weapon: row.snapshot?.weapon?.name || null,
    stats: {
      atk: Number(stats.atk) || null,
      hp: Number(stats.hp) || null,
      crit_rate: Number(stats.critRate) || null,
      crit_dmg: Number(stats.critDmg) || null,
      er: Number(stats.er) || null,
      em: Number(stats.em) || null,
    },
    strengths: Array.isArray(row.strengths) ? row.strengths.slice(0, 3) : [],
  };
}

function compactGuide(guide) {
  if (!guide) return null;
  const teams = guide.teams || {};
  return {
    name: guide.name || null,
    source: guide.source || 'Neverless guide sources',
    role: guide.role || null,
    stats: {
      main: (guide.stats?.main || []).slice(0, 8),
      targets: (guide.stats?.targets || []).slice(0, 8),
      priority: guide.stats?.priority || null,
    },
    weapons: (guide.weapons || []).slice(0, 8),
    f2p_weapons: (guide.f2pWeapons || []).slice(0, 5),
    artifacts: (guide.artifacts || []).slice(0, 6),
    combos: (guide.combos || []).slice(0, 6),
    teams: {
      premium: (teams.premium || []).slice(0, 10),
      f2p: (teams.f2p || []).slice(0, 6),
    },
    team_groups: (guide.teamGroups || []).slice(0, 8).map((group) => ({
      category: group.category || 'Team',
      role: group.role || '',
      kind: group.kind || 'premium',
      slot_teams: (group.slotTeams || []).slice(0, 5),
      requirements: group.requirements || {},
    })),
  };
}

async function theaterKnowledge(difficultyText) {
  const season = await getCurrentTheaterSeason();
  const overview = {
    key: season.key,
    label: season.label,
    elements: season.elements,
    opening: season.opening,
    guests: season.guests,
    source: season.source,
    route_verified: Boolean(season.routeVerified),
  };
  if (!difficultyText) return { season: overview, difficulties: DIFFICULTIES };
  const difficulty = resolveDifficulty(difficultyText);
  if (!difficulty) return { season: overview, error: difficulty === undefined ? 'UNKNOWN_DIFFICULTY' : 'DIFFICULTY_REQUIRED' };
  const simulated = {
    difficulty,
    currentAct: 1,
    used: new Map(),
    unavailable: new Set(),
    notDrawn: new Set(),
    pool: new Set(),
  };
  const names = curatedNames(season);
  const acts = [];
  for (let act = 1; act <= difficulty.acts; act += 1) {
    const { team, actInfo } = await buildTeam(names, act, simulated, season);
    acts.push({
      act,
      boss: actInfo.boss || null,
      title: actInfo.title || null,
      reaction: actInfo.reaction || null,
      note: actInfo.note || null,
      team: team.map((row) => ({ name: row.name, remaining_before: row.remaining })),
    });
    for (const row of team) simulated.used.set(row.name, (simulated.used.get(row.name) || 0) + 1);
  }
  return { season: overview, difficulty, acts };
}

function createServerToolExecutor(context) {
  const baseExecutor = base.createServerToolExecutor(context);
  const { guild, requester } = context;

  return async function execute(name, args = {}) {
    if (!guild || !requester) return { error: 'NO_GUILD_CONTEXT' };

    if (name === 'search_neverless_commands') {
      const results = searchCommandCatalog(args.query || '', args.limit || 12);
      return {
        verified: true,
        results,
        rule: 'Only these returned syntaxes are verified matches. If the requested command is not here, say you could not verify one instead of inventing a command.',
      };
    }

    if (name === 'list_server_members') {
      await guild.members.fetch().catch(() => null);
      const query = String(args.query || '').trim().toLowerCase();
      let members = [...guild.members.cache.values()].filter((member) => args.include_bots ? true : !member.user?.bot);
      if (query) members = members.filter((member) => [member.displayName, member.user?.username, member.user?.globalName]
        .some((value) => String(value || '').toLowerCase().includes(query)));
      if (args.random) members = shuffle(members);
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      return { total_matching: members.length, members: members.slice(0, limit).map(compactMember) };
    }

    if (name === 'get_activity_leaderboard') {
      const period = ['daily', 'weekly', 'monthly'].includes(args.period) ? args.period : 'all';
      return { period, rows: await activityRows(guild, period, args.limit || 10), source: 'Neverless Activity V2 persisted data' };
    }

    if (name === 'get_invite_leaderboard') {
      return { rows: await inviteRows(guild, args.limit || 10), source: 'Neverless Activity V2 invite data' };
    }

    if (name === 'get_character_ranking') {
      const character = await resolveCharacter(args.character).catch(() => null) || String(args.character || '').trim();
      if (!character) return { error: 'CHARACTER_NOT_FOUND' };
      const role = guild.roles.cache.find((item) => item.name.toLowerCase() === `top ${character}`.toLowerCase()) || null;
      const holders = role ? [...role.members.values()].filter((member) => !member.user?.bot).map(compactMember) : [];
      if (!args.full) {
        return {
          character,
          current_top_role: role?.name || null,
          holders,
          source: 'Neverless Top <Character> achievement role maintained by the official character ranking',
        };
      }
      const board = await buildCharacterLeaderboard(guild, character);
      return {
        character: board.characterName || character,
        rows: (board.rows || []).slice(0, Math.max(1, Math.min(10, Number(args.limit) || 10))).map(compactCharacterRow),
        source: 'Neverless official live character leaderboard',
      };
    }

    if (name === 'get_neverless_account_ranking') {
      const role = guild.roles.cache.find((item) => item.name === 'Top Neverless') || null;
      const holders = role ? [...role.members.values()].filter((member) => !member.user?.bot).map(compactMember) : [];
      if (!args.full) return { holders, role: role?.name || null, source: 'Top Neverless achievement role' };
      let board = getCachedNeverlessLeaderboard(guild);
      if (!board && args.refresh) board = await buildNeverlessLeaderboard(guild);
      if (!board) return { holders, rows: [], cache_available: false, note: 'No recent full account leaderboard cache is available. The current Top Neverless holder is still authoritative.' };
      return {
        holders,
        cache_available: true,
        rows: (board.rows || []).slice(0, Math.max(1, Math.min(10, Number(args.limit) || 10))).map((row) => ({
          member_id: row.discordUserId,
          name: row.displayName,
          account_score: row.accountScore,
          average_build: row.averageBuild,
          top_builds: (row.topBuilds || []).slice(0, 3).map((build) => ({ name: build.name, score: build.score })),
        })),
        source: 'Neverless official account leaderboard',
      };
    }

    if (name === 'get_genshin_guide') {
      const character = await resolveCharacter(args.character).catch(() => null) || String(args.character || '').trim();
      if (!character) return { error: 'CHARACTER_NOT_FOUND' };
      const guide = await getGuide(character).catch(() => null);
      return guide ? compactGuide(guide) : { error: 'GUIDE_NOT_AVAILABLE', character };
    }

    if (name === 'get_current_theater_knowledge') return theaterKnowledge(args.difficulty || null);

    return baseExecutor(name, args);
  };
}

module.exports = {
  ...base,
  TOOL_DEFINITIONS,
  createServerToolExecutor,
  compactGuide,
  activityRows,
  inviteRows,
  theaterKnowledge,
};
