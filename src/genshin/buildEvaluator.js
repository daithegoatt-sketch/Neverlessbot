'use strict';

const { LABELS, parseTarget, guideProfile, formatTarget } = require('./statProfile');

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function targetScore(value, target) {
  if (!Number.isFinite(value) || !target) return 0;
  if (value >= target.min && (target.max === target.min || value <= target.max)) return 1;
  if (value < target.min) {
    const ratio = Math.max(0, value / Math.max(1, target.min));
    return ratio * ratio;
  }
  if (target.key === 'er') return Math.max(0.55, target.max / value);
  return 1;
}

function cleanSetName(value) {
  return normalize(String(value || '').replace(/^\s*[24]\s*(?:pc|piece)\s*/i, ''));
}

function artifactCompletion(snapshot) {
  const artifacts = Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : [];
  if (!artifacts.length) return { score: 0, count: 0, avgLevel: 0 };
  const count = Math.min(5, artifacts.length);
  const levels = artifacts.map((item) => Number.isFinite(item.level) ? Math.max(0, Math.min(20, item.level)) : 0);
  const avgLevel = levels.reduce((a, b) => a + b, 0) / Math.max(1, artifacts.length);
  const countScore = count / 5;
  const levelScore = levels.reduce((sum, level) => sum + (level / 20), 0) / 5;
  return { score: countScore * 0.35 + levelScore * 0.65, count, avgLevel };
}

function recommendedSetMatch(snapshot, guide) {
  const current = Object.entries(snapshot?.setCounts || {}).sort((a, b) => b[1] - a[1]);
  if (!current.length) return 0;
  const recommendations = (guide?.artifacts || []).map(cleanSetName).filter(Boolean);
  if (!recommendations.length) return 0.7;

  for (const [setName, count] of current) {
    const currentName = cleanSetName(setName);
    if (!currentName) continue;
    const matches = recommendations.some((recommended) => recommended.includes(currentName) || currentName.includes(recommended));
    if (matches && count >= 4) return 1;
    if (matches && count >= 2) return 0.65;
  }
  return 0.2;
}

function mainStatMatch(snapshot, guide) {
  const expected = guide?.stats?.main || [];
  if (!expected.length) return 0.65;
  const slots = ['sands', 'goblet', 'circlet'];
  let total = 0;
  let matched = 0;

  for (const slot of slots) {
    const target = expected.find((item) => String(item).toLowerCase().startsWith(`${slot}:`));
    if (!target) continue;
    total += 1;
    const actual = snapshot?.artifacts?.find((item) => item.slot === slot);
    if (!actual) continue;
    const actualKey = normalize(actual.mainStat);
    const options = target.split(':').slice(1).join(':').split(/\/|>|\bor\b/i).map(normalize).filter(Boolean);
    if (options.some((option) => option && (actualKey.includes(option) || option.includes(actualKey)))) matched += 1;
  }
  return total ? matched / total : 0.65;
}

function weaponMatch(snapshot, guide) {
  const name = normalize(snapshot?.weapon?.name);
  if (!name) return 0;
  const weapons = guide?.weapons || [];
  if (!weapons.length) return 0.7;
  const index = weapons.findIndex((item) => {
    const recommended = normalize(item);
    return recommended && (recommended.includes(name) || name.includes(recommended));
  });
  if (index < 0) return 0.5;
  return [1, 0.93, 0.88, 0.84, 0.8, 0.76][Math.min(index, 5)];
}

function akashaScore(percentile) {
  if (!Number.isFinite(percentile)) return 0.5;
  if (percentile <= 1) return 1;
  if (percentile <= 2) return 0.97;
  if (percentile <= 5) return 0.93;
  if (percentile <= 10) return 0.88;
  if (percentile <= 20) return 0.78;
  if (percentile <= 35) return 0.68;
  if (percentile <= 50) return 0.57;
  if (percentile <= 75) return 0.43;
  return 0.3;
}

function statWeight(key, profile) {
  const priorityIndex = profile.priority.indexOf(key);
  const priorityBonus = priorityIndex < 0 ? 0 : Math.max(0, 0.35 - priorityIndex * 0.06);
  const base = ['critRate', 'critDmg'].includes(key) ? 1.15 : ['atk', 'hp', 'def'].includes(key) ? 1.1 : 1;
  return base + priorityBonus;
}

function evaluateBuild(snapshot, guide, options = {}) {
  const profile = guideProfile(guide);
  const completion = artifactCompletion(snapshot);
  const setScore = recommendedSetMatch(snapshot, guide);
  const mainsScore = mainStatMatch(snapshot, guide);
  const weaponScore = weaponMatch(snapshot, guide);
  const notes = [];
  const relevantStats = [];

  let statWeightTotal = 0;
  let statPoints = 0;
  for (const key of profile.ordered) {
    const target = profile.targetMap[key];
    const value = snapshot?.stats?.[key];
    if (!target || !Number.isFinite(value)) continue;
    const ratio = targetScore(value, target);
    const weight = statWeight(key, profile);
    statWeightTotal += weight;
    statPoints += weight * ratio;
    const status = value < target.min ? 'down' : (key === 'er' && value > target.max * 1.12 ? 'warn' : 'ok');
    const suffix = ['critRate', 'critDmg', 'er'].includes(key) ? '%' : '';
    if (status === 'down') notes.push({ type: 'down', key, text: `${LABELS[key]} ${value}${suffix} < ${target.min}${suffix}` });
    else if (status === 'warn') notes.push({ type: 'warn', key, text: `${LABELS[key]} ${value}% أعلى من الهدف ${formatTarget(target)}` });
    relevantStats.push({ key, label: LABELS[key], value, target, ratio, status, weight });
  }

  // If a source does not publish numeric targets, don't invent them. The rest of the build still matters.
  const statScore = statWeightTotal ? statPoints / statWeightTotal : 0.5;
  const akasha = akashaScore(options.akashaPercentile);
  let raw = statScore * 0.40
    + completion.score * 0.20
    + mainsScore * 0.15
    + setScore * 0.10
    + weaponScore * 0.10
    + akasha * 0.05;

  let score = Math.round(Math.max(0, Math.min(1, raw)) * 100);

  // Hard caps prevent incomplete characters from receiving flattering ratings.
  if (completion.count === 0) score = Math.min(score, 25);
  else if (completion.count < 3) score = Math.min(score, 42);
  else if (completion.count < 5) score = Math.min(score, 62);
  if (completion.count === 5 && completion.avgLevel < 12) score = Math.min(score, 68);
  else if (completion.count === 5 && completion.avgLevel < 18) score = Math.min(score, 82);
  if (mainsScore < 0.34) score = Math.min(score, 62);
  else if (mainsScore < 0.67) score = Math.min(score, 80);
  if (setScore < 0.5 && guide?.artifacts?.length) score = Math.min(score, 86);
  if (!snapshot?.weapon?.name) score = Math.min(score, 68);

  if (completion.count < 5) notes.unshift({ type: 'down', key: 'artifacts', text: `Artifacts ${completion.count}/5` });
  else if (completion.avgLevel < 20) notes.unshift({ type: 'warn', key: 'artifacts', text: `متوسط مستوى الآرتيفاكت +${Math.round(completion.avgLevel)}/20` });
  if (mainsScore < 1) notes.push({ type: mainsScore < 0.34 ? 'down' : 'warn', key: 'mainStats', text: `Main Stats ${Math.round(mainsScore * 100)}% مطابقة` });
  if (setScore < 1 && guide?.artifacts?.length) notes.push({ type: 'warn', key: 'set', text: `Artifact set match ${Math.round(setScore * 100)}%` });

  return {
    score,
    statScore: Math.round(statScore * 100),
    artifactCompletionScore: Math.round(completion.score * 100),
    mainStatScore: Math.round(mainsScore * 100),
    artifactSetScore: Math.round(setScore * 100),
    weaponScore: Math.round(weaponScore * 100),
    akashaComponent: Math.round(akasha * 100),
    artifactCount: completion.count,
    artifactAvgLevel: Math.round(completion.avgLevel * 10) / 10,
    relevantStats,
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
