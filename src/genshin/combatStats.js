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

// Only count conditional combat stats when the condition is reliably part of the
// character's normal build/play pattern. Do not assume team-dependent buffs here.
const SELF_HP_MARECHAUSSEE_USERS = new Set([
  'neuvillette',
  'wriothesley',
  'lyney',
  'gaming',
]);

function artifactCombatBonuses(snapshot, guide) {
  const bonuses = {};
  const character = normalize(snapshot?.name);

  if (
    SELF_HP_MARECHAUSSEE_USERS.has(character)
    && hasFourPiece(snapshot, 'Marechaussee Hunter')
    && guideRecommendsSet(guide, 'Marechaussee Hunter')
  ) {
    // 4pc: +12% CRIT Rate per HP change, max 3 stacks. These characters can
    // maintain the stacks through their own normal combat mechanics.
    bonuses.critRate = (bonuses.critRate || 0) + 36;
  }

  if (
    hasFourPiece(snapshot, 'Obsidian Codex')
    && guideRecommendsSet(guide, 'Obsidian Codex')
  ) {
    // Game8 only recommends this 4pc on builds that can consume Nightsoul points
    // on-field, where the +40% CRIT Rate condition is part of normal uptime.
    bonuses.critRate = (bonuses.critRate || 0) + 40;
  }

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

module.exports = {
  artifactCombatBonuses,
  effectiveStatsForRating,
  hasFourPiece,
  guideRecommendsSet,
};
