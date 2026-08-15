'use strict';

const { getGuideByText } = require('./guides');
const { getCharacterNames, getWeaponNames, getArtifactNames } = require('./dataClient');

const CACHE_TTL = 12 * 60 * 60 * 1000;
const cache = new Map();

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function htmlToLines(html) {
  const text = decodeEntities(String(html || ''))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|li|h1|h2|h3|h4|tr|td|div|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '');

  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function findIndex(lines, patterns, from = 0) {
  for (let i = from; i < lines.length; i += 1) {
    const lower = lines[i].toLowerCase();
    if (patterns.some((p) => lower.includes(p.toLowerCase()))) return i;
  }
  return -1;
}

function section(lines, startPatterns, endPatterns) {
  const start = findIndex(lines, startPatterns);
  if (start < 0) return [];
  const end = findIndex(lines, endPatterns, start + 1);
  return lines.slice(start + 1, end < 0 ? Math.min(lines.length, start + 120) : end);
}

function orderedMatches(text, candidates, limit = 6) {
  const lower = text.toLowerCase();
  const found = [];
  for (const name of candidates) {
    const index = lower.indexOf(String(name).toLowerCase());
    if (index >= 0) found.push({ name, index });
  }
  found.sort((a, b) => a.index - b.index);
  const unique = [];
  const seen = new Set();
  for (const item of found) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item.name);
    if (unique.length >= limit) break;
  }
  return unique;
}

function cleanStatLine(line, label) {
  const regex = new RegExp(`${label}\\s*:?\\s*`, 'i');
  const value = String(line || '').replace(regex, '').trim();
  return value || null;
}

function parseMainStats(lines) {
  const joined = lines.join(' | ');
  const pick = (label, aliases) => {
    for (const alias of aliases) {
      const re = new RegExp(`${alias}\\s*:?\\s*([^|]{1,100})`, 'i');
      const match = joined.match(re);
      if (match) return `${label}: ${match[1].replace(/Image\s*:?/gi, '').trim()}`;
    }
    return null;
  };

  const main = [
    pick('Sands', ['Sands of Eon', 'Sands']),
    pick('Goblet', ['Goblet of Eonothem', 'Goblet']),
    pick('Circlet', ['Circlet of Logos', 'Circlet']),
  ].filter(Boolean);

  let priority = null;
  const sub = joined.match(/Substats?\s*:?\s*([^|]{1,180})/i);
  if (sub) priority = sub[1].trim();
  return { main, priority };
}

function parseTargets(lines) {
  const targets = [];
  const patterns = [
    /^(HP|ATK|DEF|CRIT Rate|CRIT DMG|Energy Recharge|Elemental Mastery|EM)\s*:\s*(.+)$/i,
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const label = match[1].replace(/^Energy Recharge$/i, 'ER');
        targets.push(`${label}: ${match[2].trim()}`);
        break;
      }
    }
  }
  return targets.slice(0, 8);
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 NeverlessBot/2.0 (+Discord Genshin helper)',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error(`guide source HTTP ${response.status}`);
  return response.text();
}

function parseTeams(lines, mainName, characterNames) {
  let start = findIndex(lines, ['listed below are a range of team compositions', 'best team compositions']);
  if (start < 0) start = 0;
  const end = findIndex(lines, ['changelog', 'about the author'], start + 1);
  const text = lines.slice(start, end < 0 ? lines.length : end).join(' ');
  const candidates = [...characterNames].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const occurrences = [];

  for (const name of candidates) {
    const needle = name.toLowerCase();
    let offset = 0;
    while (offset < lower.length) {
      const index = lower.indexOf(needle, offset);
      if (index < 0) break;
      occurrences.push({ name, index });
      offset = index + needle.length;
    }
  }
  occurrences.sort((a, b) => a.index - b.index || b.name.length - a.name.length);

  const sequence = [];
  for (const item of occurrences) {
    const previous = sequence.at(-1);
    if (previous?.name.toLowerCase() === item.name.toLowerCase() && item.index - previous.index < item.name.length + 40) continue;
    sequence.push(item);
  }

  const teams = [];
  const mainKey = mainName.toLowerCase();
  for (let i = 0; i < sequence.length; i += 1) {
    if (sequence[i].name.toLowerCase() !== mainKey) continue;
    const members = [mainName];
    for (let j = i + 1; j < sequence.length && members.length < 4; j += 1) {
      const candidate = sequence[j].name;
      if (candidate.toLowerCase() === mainKey && members.length < 4) break;
      if (!members.some((m) => m.toLowerCase() === candidate.toLowerCase())) members.push(candidate);
    }
    if (members.length === 4 && !teams.some((t) => t.join('|').toLowerCase() === members.join('|').toLowerCase())) teams.push(members);
    if (teams.length >= 8) break;
  }
  return teams;
}

async function fetchIcyVeinsGuide(name) {
  const slug = slugify(name);
  const buildUrl = `https://www.icy-veins.com/genshin-impact/${slug}-guide-best-builds`;
  const teamUrl = `https://www.icy-veins.com/genshin-impact/${slug}-team-guide`;
  const [weaponNames, artifactNames, characterNames] = await Promise.all([
    getWeaponNames(),
    getArtifactNames(),
    getCharacterNames(),
  ]);

  const buildHtml = await fetchPage(buildUrl);
  const buildLines = htmlToLines(buildHtml);
  if (!buildLines.some((line) => line.toLowerCase().includes(name.toLowerCase()))) throw new Error('guide page did not match character');

  const weaponLines = section(buildLines, [`best weapons for ${name}`, `best weapons for`], [`best artifacts for ${name}`, 'best artifacts for']);
  const artifactLines = section(buildLines, [`best artifacts for ${name}`, 'best artifacts for'], [`${name}'s stat priority`, 'stat priority']);
  const statLines = section(buildLines, [`${name}'s stat priority`, 'stat priority'], [`recommended stats for ${name}`, 'recommended stats']);
  const targetLines = section(buildLines, [`recommended stats for ${name}`, 'recommended stats'], [`${name}'s talent priority`, 'talent priority', 'how to play']);
  const parsedStats = parseMainStats(statLines);
  const weapons = orderedMatches(weaponLines.join(' '), weaponNames, 5);
  const artifacts = orderedMatches(artifactLines.join(' '), artifactNames, 4);
  const targets = parseTargets(targetLines);

  let teams = [];
  try {
    const teamHtml = await fetchPage(teamUrl);
    teams = parseTeams(htmlToLines(teamHtml), name, characterNames);
  } catch (error) {
    console.warn(`[genshin] Team guide unavailable for ${name}: ${error.message}`);
  }

  if (!weapons.length && !artifacts.length && !parsedStats.main.length && !targets.length && !teams.length) {
    throw new Error('guide parser found no structured recommendations');
  }

  return {
    name,
    aliases: [name],
    status: 'live',
    role: null,
    sources: [{ name: 'Icy Veins', url: buildUrl }, { name: 'Icy Veins Team Guide', url: teamUrl }],
    stats: {
      main: parsedStats.main,
      priority: parsedStats.priority,
      targets,
      note: null,
    },
    weapons,
    artifacts,
    teams,
    talentPriority: null,
  };
}

function mergeGuide(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    ...secondary,
    ...primary,
    stats: {
      ...(secondary.stats || {}),
      ...(primary.stats || {}),
      main: primary.stats?.main?.length ? primary.stats.main : secondary.stats?.main,
      targets: primary.stats?.targets?.length ? primary.stats.targets : secondary.stats?.targets,
    },
    weapons: primary.weapons?.length ? primary.weapons : secondary.weapons,
    artifacts: primary.artifacts?.length ? primary.artifacts : secondary.artifacts,
    teams: primary.teams?.length ? primary.teams : secondary.teams,
  };
}

async function getGuide(name) {
  const key = String(name || '').toLowerCase();
  const cached = cache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.value;

  const curated = getGuideByText(name);
  let live = null;
  try {
    live = await fetchIcyVeinsGuide(name);
  } catch (error) {
    if (!curated) console.warn(`[genshin] No live guide for ${name}: ${error.message}`);
  }

  const value = mergeGuide(curated, live);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

module.exports = { getGuide, fetchIcyVeinsGuide, htmlToLines, parseTeams, slugify };
