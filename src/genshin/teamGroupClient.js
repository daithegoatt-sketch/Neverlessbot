'use strict';

const cheerio = require('cheerio');
const { discoverCharacterUrl } = require('./game8Client');
const { getCharacterNames } = require('./dataClient');

const CACHE_TTL = 12 * 60 * 60 * 1000;
const cache = new Map();

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
      'user-agent': 'Mozilla/5.0 NeverlessBot/11.0 (+Discord Genshin team parser)',
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
  return $(table).find('tr').toArray().map((tr) => ({
    node: tr,
    cells: $(tr).children('th,td').toArray(),
    text: $(tr).children('th,td').map((_, td) => cleanText($(td).text())).get(),
  }));
}

function namesInCell(cell, $, characterNames) {
  return orderedMatches(cleanText($(cell).text()), characterNames);
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

    output.push({ grid, inherited, explicitSlots, rawText: row.text });
  }
  return output;
}

function expandSlots(slots, limit = 24) {
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
  if (/notable teammates?|team summary|character explanation/i.test(text)) return false;
  return /team|team comps?|team compositions?|best team/i.test(text);
}

function parseTable(table, $, scope, characterNames, mainName) {
  if (!usefulTeamContext(scope)) return null;
  const rows = rawRows(table, $);
  if (!rows.length) return null;

  const headerIndex = rows.findIndex((row) => row.text.length >= 4 && roleHeaderScore(row.text) >= 2);
  if (headerIndex < 0) return null;

  const preHeaderTitle = rows.slice(0, headerIndex)
    .map((row) => row.text.join(' '))
    .find((value) => /team|comp/i.test(value)) || null;

  const gridRows = buildGridRows(rows, headerIndex + 1, $, characterNames)
    .filter((row) => row.grid.some((slot) => (slot || []).some((name) => sameName(name, mainName))));
  if (!gridRows.length) return null;

  const hasRowspanAlternatives = gridRows.length > 1 && gridRows.some((row) => row.inherited.some(Boolean) || row.explicitSlots < 4);
  const slotTeams = [];

  if (hasRowspanAlternatives) {
    const slots = Array.from({ length: 4 }, () => []);
    for (const row of gridRows) {
      for (let col = 0; col < 4; col += 1) slots[col].push(...(row.grid[col] || []));
    }
    const cleaned = slots.map(unique);
    if (cleaned.every((slot) => slot.length)) slotTeams.push(cleaned);
  } else {
    for (const row of gridRows) {
      const slots = row.grid.map((slot) => unique(slot || []));
      if (slots.every((slot) => slot.length)) slotTeams.push(slots);
    }
  }

  if (!slotTeams.length) return null;

  const teams = dedupeTeams(slotTeams.flatMap((slots) => expandSlots(slots)));
  if (!teams.length) return null;

  const category = cleanText(preHeaderTitle || deepestTeamHeading(scope));
  return {
    kind: groupKind(scope, preHeaderTitle),
    category,
    role: cleanText(roleScope(scope) || ''),
    slotTeams,
    teams,
  };
}

function mergeGroups(groups) {
  const out = [];
  for (const group of groups) {
    const key = [group.kind, normalize(group.role), normalize(group.category)].join('|');
    const existing = out.find((item) => item.key === key);
    if (!existing) {
      out.push({ ...group, key, slotTeams: [...group.slotTeams], teams: [...group.teams] });
      continue;
    }
    existing.slotTeams.push(...group.slotTeams);
    existing.teams.push(...group.teams);
    existing.teams = dedupeTeams(existing.teams);
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
    const parsed = parseTable(node, $, scope, characterNames, name);
    if (parsed) groups.push(parsed);
  });

  return mergeGroups(groups);
}

module.exports = {
  fetchGame8TeamGroups,
  parseTable,
  expandSlots,
  dedupeTeams,
  normalize,
};
