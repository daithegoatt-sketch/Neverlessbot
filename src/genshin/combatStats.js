'use strict';

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
}

function hasFourPiece(snapshot, setName) {
  const wanted = normalize(setName);
  return Object.entries(snapshot?.setCounts || {}).some(([name, count]) => normalize(name) === wanted && Number(count) >= 4);
}

function guideRecommendsSet(guide, setName) {
  const wanted = normalize(setName);
  return (guide?.artifacts || []).some((name) => {
    const current = normalize(String(name || '').replace(/^\s*[24]\s*(?:pc|piece)\s*/i, ''));
    return current === wanted || current.includes(wanted) || wanted.includes(current);
  });
}

const SELF_HP_MARECHAUSSEE_USERS = new Set(['neuvillette', 'wriothesley', 'lyney', 'gaming']);

function artifactCombatBonuses(snapshot, guide) {
  const bonuses = {};
  const character = normalize(snapshot?.name);
  if (SELF_HP_MARECHAUSSEE_USERS.has(character) && hasFourPiece(snapshot, 'Marechaussee Hunter') && guideRecommendsSet(guide, 'Marechaussee Hunter')) bonuses.critRate = 36;
  if (hasFourPiece(snapshot, 'Obsidian Codex') && guideRecommendsSet(guide, 'Obsidian Codex')) bonuses.critRate = (bonuses.critRate || 0) + 40;
  return bonuses;
}

function effectiveStatsForRating(snapshot, guide) {
  const raw = { ...(snapshot?.stats || {}) };
  const bonuses = artifactCombatBonuses(snapshot, guide);
  const effective = { ...raw };
  for (const [key, bonus] of Object.entries(bonuses)) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && Number.isFinite(bonus)) effective[key] = value + bonus;
  }
  return { raw, effective, bonuses };
}

module.exports = { artifactCombatBonuses, effectiveStatsForRating, hasFourPiece, guideRecommendsSet };
