'use strict';

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const LABELS = {
  hp: 'HP', atk: 'ATK', def: 'DEF', critRate: 'CRIT Rate', critDmg: 'CRIT DMG', er: 'ER', em: 'EM',
};

function parseTarget(line) {
  const text = String(line || '').replace(/,/g, '');
  let key = null;
  if (/CRIT Rate/i.test(text)) key = 'critRate';
  else if (/CRIT DMG/i.test(text)) key = 'critDmg';
  else if (/Energy Recharge|\bER\b/i.test(text)) key = 'er';
  else if (/Elemental Mastery|\bEM\b/i.test(text)) key = 'em';
  else if (/\bATK\b/i.test(text)) key = 'atk';
  else if (/\bHP\b/i.test(text)) key = 'hp';
  else if (/\bDEF\b/i.test(text)) key = 'def';
  if (!key) return null;
  const values = [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (!values.length) return null;
  const min = values[0];
  const max = values[1] ?? values[0];
  return { key, min: Math.min(min, max), max: Math.max(min, max), text: line };
}

function targetScore(value, target) {
  if (!Number.isFinite(value)) return null;
  if (value >= target.min && value <= target.max) return 1;
  if (target.max === target.min && value >= target.min) return 1;
  if (value < target.min) return Math.max(0, value / target.min);
  if (target.key === 'er') return Math.max(0.7, target.max / value);
  return 1;
}

function recommendedSetMatch(snapshot, guide) {
  const current = Object.entries(snapshot.setCounts || {}).sort((a, b) => b[1] - a[1]);
  if (!current.length || !guide.artifacts?.length) return 0.5;
  for (const [setName, count] of current) {
    if (count >= 4 && guide.artifacts.some((item) => normalize(item).includes(normalize(setName)))) return 1;
  }
  return 0.55;
}

function mainStatMatch(snapshot, guide) {
  const expected = guide.stats?.main || [];
  if (!expected.length) return 0.7;
  const slots = ['sands', 'goblet', 'circlet'];
  let matched = 0;
  let checked = 0;
  for (const slot of slots) {
    const actual = snapshot.artifacts?.find((item) => item.slot === slot);
    const target = expected.find((item) => String(item).toLowerCase().startsWith(`${slot}:`));
    if (!actual || !target) continue;
    checked += 1;
    const actualKey = normalize(actual.mainStat);
    const options = target.split(':').slice(1).join(':').split(/\/|>|\bor\b/i).map(normalize).filter(Boolean);
    if (options.some((option) => option && (actualKey.includes(option) || option.includes(actualKey)))) matched += 1;
  }
  return checked ? matched / checked : 0.7;
}

function evaluateBuild(snapshot, guide) {
  const parsed = (guide.stats?.targets || []).map(parseTarget).filter(Boolean);
  const counts = parsed.reduce((acc, target) => ({ ...acc, [target.key]: (acc[target.key] || 0) + 1 }), {});
  const uniqueTargets = parsed.filter((target) => counts[target.key] === 1);

  const weights = { critRate: 18, critDmg: 18, atk: 14, hp: 14, def: 12, er: 12, em: 10 };
  let statWeight = 0;
  let statPoints = 0;
  const notes = [];

  for (const target of uniqueTargets) {
    const value = snapshot.stats?.[target.key];
    if (!Number.isFinite(value)) continue;
    const weight = weights[target.key] || 10;
    const ratio = targetScore(value, target);
    statWeight += weight;
    statPoints += weight * ratio;
    if (value < target.min) {
      notes.push({ type: 'down', key: target.key, text: `${LABELS[target.key]} ${value} < ${target.min}` });
    } else if (target.key === 'er' && value > target.max * 1.12) {
      notes.push({ type: 'warn', key: target.key, text: `${LABELS[target.key]} ${value}% أعلى من الرينج المعتاد ${target.min}-${target.max}%` });
    } else {
      notes.push({ type: 'ok', key: target.key, text: `${LABELS[target.key]} ${value} ضمن/فوق الهدف` });
    }
  }

  const statScore = statWeight ? statPoints / statWeight : 0.72;
  const setScore = recommendedSetMatch(snapshot, guide);
  const mainsScore = mainStatMatch(snapshot, guide);
  const score = Math.round(Math.max(0, Math.min(1, statScore * 0.72 + mainsScore * 0.18 + setScore * 0.10)) * 100);

  return {
    score,
    statScore: Math.round(statScore * 100),
    mainStatScore: Math.round(mainsScore * 100),
    artifactSetScore: Math.round(setScore * 100),
    notes,
  };
}

function compareSnapshots(previous, current) {
  if (!previous) return null;
  const fields = ['hp', 'atk', 'def', 'critRate', 'critDmg', 'er', 'em'];
  const deltas = {};
  for (const key of fields) {
    const before = previous.snapshot?.stats?.[key];
    const after = current.snapshot?.stats?.[key];
    if (Number.isFinite(before) && Number.isFinite(after)) deltas[key] = Math.round((after - before) * 10) / 10;
  }
  return {
    scoreDelta: current.evaluation.score - previous.evaluation.score,
    deltas,
    previousScore: previous.evaluation.score,
    currentScore: current.evaluation.score,
  };
}

module.exports = { evaluateBuild, compareSnapshots, parseTarget, LABELS };
