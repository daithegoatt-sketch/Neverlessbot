'use strict';

const cheerio = require('cheerio');
const { discoverCharacterUrl } = require('./game8Client');
const { getCharacterNames } = require('./dataClient');

const CACHE_TTL = 12 * 60 * 60 * 1000;
const cache = new Map();

const REACTIONS = [
  ['Stellar-Conduct', /stellar[ -]?conduct/ig],
  ['Vaporize', /\bvapori[sz]e\b/ig],
  ['Melt', /\bmelt\b/ig],
  ['Overload', /\boverload(?:ed)?\b/ig],
  ['Burning', /\bburning\b|\bburn team\b/ig],
  ['Mono-Pyro', /\bmono[ -]?pyro\b/ig],
  ['Freeze', /\bfreeze\b|\bfrozen\b/ig],
  ['Electro-Charged', /\belectro[ -]?charged\b/ig],
  ['Aggravate', /\baggravate\b/ig],
  ['Spread', /\bspread\b/ig],
  ['Hyperbloom', /\bhyperbloom\b/ig],
  ['Burgeon', /\bburgeon\b/ig],
  ['Bloom', /\bbloom\b/ig],
  ['Superconduct', /\bsuperconduct\b/ig],
  ['Double-Geo', /\bdouble[ -]?geo\b/ig],
  ['Hypercarry', /\bhypercarry\b/ig],
];

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sameName(a, b) {
  return normalize(a) === normalize(b);
}

function unique(values) {
  const out = [];
  for (const value of values || []) {
    if (!value || out.some((item) => sameName(item, value))) continue;
    out.push(value);
  }
  return out;
}

function dedupeTeams(teams) {
  const out = [];
  for (const team of teams || []) {
    if (!Array.isArray(team) || team.length !== 4) continue;
    const key = team.map(normalize).join('|');
    if (!key || out.some((item) => item.map(normalize).join('|') === key)) continue;
    out.push(team);
  }
  return out;
}

async function fetchHtml(url) {
  const cached = cache.get(url);
  if (cached?.expiresAt > Date.now()) return cached.html;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 NeverlessBot/12.0 (+Discord Genshin team slot parser)',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Game8 HTTP ${response.status}`);
  const html = await response.text();
  cache.set(url, { html, expiresAt: Date.now() + CACHE_TTL });
  return html;
}

function orderedMatches(text, names) {
  const lower = String(text || '').toLowerCase();
  const found = [];
  for (const name of names) {
    const index = lower.indexOf(String(name).toLowerCase());
    if (index >= 0) found.push({ name, index });
  }
  found.sort((a, b) => a.index - b.index || b.name.length - a.name.length);
  return unique(found.map((item) => item.name));
}

function roleHeaderScore(cells) {
  return cells.reduce((score, value) => score + (/(?:main\s*-?\s*dps|sub\s*-?\s*dps|support|healer|dps)/i.test(value) ? 1 : 0), 0);
}

function rawRows(table, $) {
  return $(table).find('tr').toArray().map((tr, index) => ({
    index,
    node: tr,
    cells: $(tr).children('th,td').toArray(),
    text: $(tr).children('th,td').map((_, td) => cleanText($(td).text())).get(),
  }));
}

function namesInCell(cell, $, characterNames) {
  return orderedMatches(cleanText($(cell).text()), characterNames);
}

function requirementForName(text, name) {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return null;
  const match = String(text || '').match(new RegExp(`${escaped}\\s*(?:\\(|\\[)?\\s*C\\s*(\\d+)`, 'i'));
  const constellation = Number(match?.[1]);
  return Number.isInteger(constellation) && constellation >= 0 && constellation <= 6 ? { constellation } : null;
}

function collectRequirements(rows, characterNames) {
  const requirements = {};
  for (const row of rows) {
    for (const text of row.text) {
      const names = orderedMatches(text, characterNames);
      for (const name of names) {
        const requirement = requirementForName(text, name);
        if (requirement) requirements[normalize(name)] = requirement;
      }
    }
  }
  return requirements;
}

function buildGridRows(rows, startIndex, $, characterNames) {
  const pending = Array(4).fill(null);
  const output = [];

  for (let r = startIndex; r < rows.length; r += 1) {
    const row = rows[r];
    const grid = Array(4).fill(null);
    const inherited = Array(4).fill(false);

    for (let col = 0; col < 4; col += 1) {
      const hold = pending[col];
      if (!hold) continue;
      grid[col] = hold.names;
      inherited[col] = true;
      hold.remaining -= 1;
      if (hold.remaining <= 0) pending[col] = null;
    }

    let col = 0;
    let explicitSlots = 0;
    for (const cell of row.cells) {
      while (col < 4 && grid[col]) col += 1;
      if (col >= 4) break;
      const colspan = Math.max(1, Number($(cell).attr('colspan')) || 1);
      const rowspan = Math.max(1, Number($(cell).attr('rowspan')) || 1);
      const names = namesInCell(cell, $, characterNames);
      explicitSlots += 1;

      for (let offset = 0; offset < colspan && col + offset < 4; offset += 1) {
        grid[col + offset] = names;
        if (rowspan > 1) pending[col + offset] = { names, remaining: rowspan - 1 };
      }
      col += colspan;
    }

    output.push({ rowIndex: row.index, grid, inherited, explicitSlots, rawText: row.text });
  }
  return output;
}

function expandSlots(slots, limit = 32) {
  const clean = slots.map((slot) => unique(slot));
  if (clean.some((slot) => !slot.length)) return [];
  let teams = [[]];
  for (const slot of clean) {
    const next = [];
    for (const team of teams) {
      for (const name of slot) {
        next.push([...team, name]);
        if (next.length >= limit) break;
      }
      if (next.length >= limit) break;
    }
    teams = next;
  }
  return dedupeTeams(teams);
}

function deepestTeamHeading(scope) {
  const values = [scope.h4, scope.h3, scope.h2].filter(Boolean);
  return values.find((value) => /team|comp/i.test(value)) || values[0] || 'Team';
}

function roleScope(scope) {
  const values = [scope.h3, scope.h2].filter(Boolean);
  return values.find((value) => /main\s*dps\s*teams?|sub\s*-?dps\s*teams?|support\s*teams?/i.test(value)) || null;
}

function groupKind(scope, title) {
  const text = [scope.h2, scope.h3, scope.h4, title].filter(Boolean).join(' | ');
  return /\bf2p\b|free\s*-?\s*to\s*-?\s*play|free team/i.test(text) ? 'f2p' : 'premium';
}

function usefulTeamContext(scope) {
  const text = [scope.h2, scope.h3, scope.h4].filter(Boolean).join(' | ');
  if (/notable teammates?|character explanation/i.test(text)) return false;
  return /team|team comps?|team compositions?|best team/i.test(text);
}

function reactionMentions(text) {
  const found = [];
  for (const [name, regex] of REACTIONS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(String(text || '')))) found.push({ name, index: match.index });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set();
  return found.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  }).map((item) => item.name);
}

function specificCategory(category) {
  return reactionMentions(category).length > 0 || /double[ -]?geo|mono[ -]?\w+|hypercarry/i.test(String(category || ''));
}

function summaryPairNames(summaryText, reactionName, characterNames) {
  const text = String(summaryText || '');
  const lower = text.toLowerCase();
  const needle = reactionName.toLowerCase().replace('-', ' ');
  const variants = [needle, needle.replace('stellar conduct', 'stellar-conduct'), needle.replace('mono pyro', 'mono-pyro')];
  let index = -1;
  for (const variant of variants) {
    const next = lower.indexOf(variant);
    if (next >= 0 && (index < 0 || next < index)) index = next;
  }
  if (index < 0) return [];
  const before = text.slice(Math.max(0, index - 170), index);
  const names = orderedMatches(before, characterNames);
  return names.slice(-3);
}

function finalizeGroup(group) {
  const teams = [...(group.teams || [])];
  const canExpand = specificCategory(group.category);
  for (const slots of group.slotTeams || []) {
    const singleton = slots.every((slot) => unique(slot).length === 1);
    if (singleton || canExpand) teams.push(...expandSlots(slots));
  }
  return { ...group, teams: dedupeTeams(teams) };
}

function splitGenericGroup(group, summaryText, characterNames) {
  if (specificCategory(group.category) || group.slotTeams.length !== 1) return [finalizeGroup(group)];
  const reactions = reactionMentions(summaryText);
  if (reactions.length < 2) return [finalizeGroup(group)];

  const baseSlots = group.slotTeams[0].map((slot) => unique(slot));
  const split = [];

  reactions.forEach((reaction, reactionIndex) => {
    const slots = baseSlots.map((slot) => [...slot]);
    let changed = 0;
    const pairNames = summaryPairNames(summaryText, reaction, characterNames);

    if (pairNames.length) {
      for (let i = 0; i < slots.length; i += 1) {
        const selected = slots[i].filter((name) => pairNames.some((pair) => sameName(pair, name)));
        if (selected.length && selected.length < slots[i].length) {
          slots[i] = selected;
          changed += 1;
        }
      }
    }

    if (changed < 2) {
      const aligned = [];
      for (let i = 0; i < slots.length; i += 1) if (slots[i].length === reactions.length) aligned.push(i);
      if (aligned.length >= 2) {
        for (const index of aligned) slots[index] = [slots[index][reactionIndex]];
        changed = aligned.length;
      }
    }

    if (changed < 2 || slots.some((slot) => !slot.length)) return;
    split.push(finalizeGroup({
      ...group,
      category: reaction,
      slotTeams: [slots],
      teams: [],
    }));
  });

  return split.length >= 2 ? split : [finalizeGroup(group)];
}

function parseTable(table, $, scope, characterNames, mainName) {
  if (!usefulTeamContext(scope)) return [];
  const rows = rawRows(table, $);
  if (!rows.length) return [];

  const headerIndex = rows.findIndex((row) => row.text.length >= 4 && roleHeaderScore(row.text) >= 2);
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;
  const allGridRows = buildGridRows(rows, startIndex, $, characterNames);
  const gridRows = allGridRows.filter((row) =>
    row.explicitSlots >= 2
    && row.grid.every((slot) => Array.isArray(slot) && slot.length)
    && row.grid.some((slot) => slot.some((name) => sameName(name, mainName))),
  );
  if (!gridRows.length) return [];

  const firstData = Math.min(...gridRows.map((row) => row.rowIndex));
  const lastData = Math.max(...gridRows.map((row) => row.rowIndex));
  const titleRows = rows.slice(0, firstData).map((row) => row.text.join(' ')).filter(Boolean);
  const preHeaderTitle = [...titleRows].reverse().find((value) => /team|comp/i.test(value)) || null;
  const summaryText = rows.slice(lastData + 1).map((row) => row.text.join(' ')).join(' ');

  const slotTeams = [];
  const exactTeams = [];
  for (const row of gridRows) {
    const slots = row.grid.map((slot) => unique(slot || []));
    if (!slots.every((slot) => slot.length)) continue;
    slotTeams.push(slots);
    if (slots.every((slot) => slot.length === 1)) exactTeams.push(slots.map((slot) => slot[0]));
  }
  if (!slotTeams.length) return [];

  const category = cleanText(preHeaderTitle || deepestTeamHeading(scope));
  const baseGroup = {
    kind: groupKind(scope, preHeaderTitle),
    category,
    role: cleanText(roleScope(scope) || ''),
    slotTeams,
    teams: dedupeTeams(exactTeams),
    requirements: collectRequirements(rows, characterNames),
  };

  return splitGenericGroup(baseGroup, summaryText, characterNames);
}

function mergeGroups(groups) {
  const out = [];
  for (const group of groups) {
    const key = [group.kind, normalize(group.role), normalize(group.category)].join('|');
    const existing = out.find((item) => item.key === key);
    if (!existing) {
      out.push({
        ...group,
        key,
        slotTeams: [...group.slotTeams],
        teams: [...group.teams],
        requirements: { ...(group.requirements || {}) },
      });
      continue;
    }
    existing.slotTeams.push(...group.slotTeams);
    existing.teams.push(...group.teams);
    existing.teams = dedupeTeams(existing.teams);
    existing.requirements = { ...existing.requirements, ...(group.requirements || {}) };
  }
  return out.map(({ key, ...group }) => ({
    ...group,
    slotTeams: group.slotTeams.filter((slots, index, all) => {
      const id = slots.map((slot) => unique(slot).map(normalize).join('/')).join('|');
      return all.findIndex((candidate) => candidate.map((slot) => unique(slot).map(normalize).join('/')).join('|') === id) === index;
    }),
  }));
}

async function fetchGame8TeamGroups(name) {
  const url = await discoverCharacterUrl(name);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const characterNames = await getCharacterNames();
  const scope = { h2: null, h3: null, h4: null };
  const groups = [];

  $('h2,h3,h4,table').each((_, node) => {
    const tag = node.tagName?.toLowerCase();
    if (/^h[234]$/.test(tag || '')) {
      const level = Number(tag[1]);
      const text = cleanText($(node).text());
      scope[`h${level}`] = text;
      for (let deeper = level + 1; deeper <= 4; deeper += 1) scope[`h${deeper}`] = null;
      return;
    }
    if (tag !== 'table') return;
    groups.push(...parseTable(node, $, scope, characterNames, name));
  });

  return mergeGroups(groups);
}

module.exports = {
  fetchGame8TeamGroups,
  parseTable,
  expandSlots,
  dedupeTeams,
  normalize,
  reactionMentions,
};
