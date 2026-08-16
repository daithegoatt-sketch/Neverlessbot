'use strict';

const { getCharacterNames } = require('./dataClient');
const { matchedCharacters, normalize: aliasNormalize } = require('./characterAliases');

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function compact(value) {
  return normalize(value).replace(/\s+/g, '');
}

function levenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = old;
    }
  }
  return row[right.length];
}

function similarity(a, b) {
  const left = compact(a);
  const right = compact(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (right.includes(left) && left.length >= 4) return Math.min(0.96, 0.72 + left.length / Math.max(20, right.length * 2));
  if (left.includes(right) && right.length >= 4) return 0.9;
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length);
}

function tokenCandidates(text) {
  const value = normalize(text);
  const raw = value.split(/\s+/).filter(Boolean);
  const out = [...raw];
  for (let size = 2; size <= 3; size += 1) {
    for (let i = 0; i + size <= raw.length; i += 1) out.push(raw.slice(i, i + size).join(' '));
  }
  return [...new Set(out)].filter((item) => compact(item).length >= 3);
}

async function resolveCharacterMentions(text, limit = 6) {
  let names = [];
  try { names = await getCharacterNames(); } catch { names = []; }
  const source = normalize(text);
  const results = [];
  const seen = new Set();

  function add(name, index = Number.MAX_SAFE_INTEGER, confidence = 1) {
    const key = compact(name);
    if (!name || seen.has(key)) return;
    seen.add(key);
    results.push({ name, index, confidence });
  }

  for (const name of matchedCharacters(text)) {
    const index = source.indexOf(normalize(name));
    add(name, index >= 0 ? index : Number.MAX_SAFE_INTEGER - 100, 1);
  }

  const ordered = [...names].sort((a, b) => b.length - a.length);
  for (const name of ordered) {
    const needle = normalize(name);
    const index = source.indexOf(needle);
    if (index >= 0) add(name, index, 1);
  }

  const tokens = tokenCandidates(text);
  for (const token of tokens) {
    let best = null;
    for (const name of names) {
      const score = similarity(token, name);
      if (score < 0.72) continue;
      if (!best || score > best.score) best = { name, score };
    }
    if (best) {
      const index = source.indexOf(normalize(token));
      add(best.name, index >= 0 ? index : Number.MAX_SAFE_INTEGER, best.score);
    }
  }

  results.sort((a, b) => a.index - b.index || b.confidence - a.confidence);
  return results.slice(0, limit).map((item) => item.name);
}

async function resolveCharacter(text) {
  return (await resolveCharacterMentions(text, 1))[0] || null;
}

module.exports = { resolveCharacter, resolveCharacterMentions, similarity, normalize, compact };
