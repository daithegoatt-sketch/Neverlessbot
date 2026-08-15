'use strict';

const STAT_KEYS = ['hp', 'atk', 'def', 'critRate', 'critDmg', 'er', 'em'];
const LABELS = {
  hp: 'HP',
  atk: 'ATK',
  def: 'DEF',
  critRate: 'CRIT Rate',
  critDmg: 'CRIT DMG',
  er: 'ER',
  em: 'EM',
};

function keyFromText(text) {
  const value = String(text || '');
  if (/CRIT\s*Rate/i.test(value)) return 'critRate';
  if (/CRIT\s*(?:DMG|Damage)/i.test(value)) return 'critDmg';
  if (/Energy\s*Recharge|\bER\b/i.test(value)) return 'er';
  if (/Elemental\s*Mastery|\bEM\b/i.test(value)) return 'em';
  if (/\bHP\b/i.test(value)) return 'hp';
  if (/\bATK\b|Attack/i.test(value)) return 'atk';
  if (/\bDEF\b|Defense/i.test(value)) return 'def';
  return null;
}

function parseTarget(line) {
  const text = String(line || '').replace(/,/g, '');
  const key = keyFromText(text);
  if (!key) return null;
  const values = [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter(Number.isFinite);
  if (!values.length) return null;
  const min = values[0];
  const max = values[1] ?? values[0];
  return { key, min: Math.min(min, max), max: Math.max(min, max), text: line };
}

function guideProfile(guide) {
  const targets = [];
  const seen = new Set();
  for (const line of guide?.stats?.targets || []) {
    const target = parseTarget(line);
    if (!target || seen.has(target.key)) continue;
    seen.add(target.key);
    targets.push(target);
  }

  const priority = [];
  const priorityText = [guide?.stats?.priority, ...(guide?.stats?.main || [])].filter(Boolean).join(' > ');
  for (const chunk of priorityText.split(/>|=|,|\/|\bor\b/gi)) {
    const key = keyFromText(chunk);
    if (key && !priority.includes(key)) priority.push(key);
  }

  const ordered = [];
  for (const key of priority) if (seen.has(key) && !ordered.includes(key)) ordered.push(key);
  for (const target of targets) if (!ordered.includes(target.key)) ordered.push(target.key);
  for (const key of ['critRate', 'critDmg']) {
    if ((priority.includes(key) || targets.some((t) => t.key === key)) && !ordered.includes(key)) ordered.push(key);
  }

  return {
    targets,
    targetMap: Object.fromEntries(targets.map((target) => [target.key, target])),
    priority,
    ordered: ordered.filter((key) => STAT_KEYS.includes(key)),
  };
}

function formatStat(key, value) {
  if (!Number.isFinite(value)) return '?';
  if (['critRate', 'critDmg', 'er'].includes(key)) return `${Math.round(value * 10) / 10}%`;
  return Math.round(value).toLocaleString('en-US');
}

function formatTarget(target) {
  if (!target) return null;
  const suffix = ['critRate', 'critDmg', 'er'].includes(target.key) ? '%' : '';
  if (target.min === target.max) return `${target.min.toLocaleString('en-US')}${suffix}+`;
  return `${target.min.toLocaleString('en-US')}–${target.max.toLocaleString('en-US')}${suffix}`;
}

module.exports = { STAT_KEYS, LABELS, keyFromText, parseTarget, guideProfile, formatStat, formatTarget };
