'use strict';

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function statKeyFromTarget(line) {
  const text = String(line || '');
  if (/CRIT\s*Rate/i.test(text)) return 'critRate';
  if (/CRIT\s*(?:DMG|Damage)/i.test(text)) return 'critDmg';
  if (/Energy\s*Recharge|\bER\b/i.test(text)) return 'er';
  if (/Elemental\s*Mastery|\bEM\b/i.test(text)) return 'em';
  if (/\bATK\b|Attack/i.test(text)) return 'atk';
  if (/\bHP\b/i.test(text)) return 'hp';
  if (/\bDEF\b|Defense/i.test(text)) return 'def';
  return null;
}

function cloneWithStats(guide, stats) {
  return guide ? { ...guide, stats: { ...(guide.stats || {}), ...stats } } : guide;
}

function isRaiden(name) {
  const key = normalize(name);
  return key === 'raidenshogun' || key === 'raiden';
}

function artifactMainIsEm(item) {
  const prop = String(item?.mainStatKey || '').toUpperCase();
  return prop === 'FIGHT_PROP_ELEMENT_MASTERY' || /elemental\s*mastery|\bEM\b/i.test(String(item?.mainStat || ''));
}

function raidenReactionBuild(snapshot) {
  if (!snapshot || !isRaiden(snapshot.name)) return false;
  const core = (snapshot.artifacts || []).filter((item) => ['sands', 'goblet', 'circlet'].includes(item?.slot));
  const emMains = core.filter(artifactMainIsEm).length;
  if (emMains >= 2) return true;

  const em = Number(snapshot?.stats?.em) || 0;
  const weapon = normalize(snapshot?.weapon?.name);
  const reactionWeapons = new Set([
    'dragonsbane',
    'moonpiercer',
    'kitaincrossspear',
    'balladofthefjords',
  ]);
  const reactionSet = Object.entries(snapshot?.setCounts || {}).some(([name, count]) => {
    const key = normalize(name);
    return Number(count) >= 4 && (key.includes('flowerofparadiselost') || key.includes('gildeddreams'));
  });

  return em >= 650 && (reactionWeapons.has(weapon) || reactionSet);
}

function defaultRaidenGuide(guide) {
  const sourceTargets = Array.isArray(guide?.stats?.targets) ? guide.stats.targets : [];
  // EM is conditional for on-field Raiden. Do not present a generic EM target as a
  // universal requirement. ER stays priority-first but remains team/rotation dependent.
  const targets = sourceTargets.filter((line) => statKeyFromTarget(line) !== 'em');

  return cloneWithStats(guide, {
    main: [
      'Sands: ATK% / Energy Recharge',
      'Goblet: Electro DMG Bonus / ATK%',
      'Circlet: CRIT Rate / CRIT DMG',
    ],
    priority: 'Energy Recharge (until requirement) > CRIT Rate / CRIT DMG > ATK% > Elemental Mastery (Quicken/Quickbloom only)',
    targets,
    buildVariant: 'on-field-dps',
    erContextual: true,
  });
}

function reactionRaidenGuide(guide) {
  return cloneWithStats(guide, {
    main: [
      'Sands: Elemental Mastery',
      'Goblet: Elemental Mastery',
      'Circlet: Elemental Mastery',
    ],
    priority: 'Elemental Mastery',
    // A reaction-trigger build should not inherit Burst-DPS CRIT/ATK goal tables.
    // Exact EM ceilings are optimizer/team dependent, so artifact quality + main stats
    // are safer than inventing a hard numeric threshold here.
    targets: [],
    buildVariant: 'reaction-trigger',
    erContextual: false,
  });
}

function applyDefaultBuildLogic(guide) {
  if (!guide) return guide;
  if (isRaiden(guide.name)) return defaultRaidenGuide(guide);
  return guide;
}

function applySnapshotBuildLogic(guide, snapshot) {
  const base = applyDefaultBuildLogic(guide);
  if (!base || !snapshot) return base;
  if (isRaiden(snapshot.name) && raidenReactionBuild(snapshot)) return reactionRaidenGuide(base);
  return base;
}

function hasErRequirementPriority(guide) {
  const priority = String(guide?.stats?.priority || '');
  return /(?:Energy\s*Recharge|\bER\b)[^>]{0,50}(?:until|requirement|needed|enough)/i.test(priority)
    || /(?:until|requirement|needed|enough)[^>]{0,50}(?:Energy\s*Recharge|\bER\b)/i.test(priority);
}

function buildPriorityNote(guide, lang = 'ar') {
  if (!hasErRequirementPriority(guide)) return null;
  return lang === 'ar'
    ? 'ER أولًا إلى احتياج التيم/الروتيشن، وبعدها انتقل للستات الهجومية حسب ترتيب البيلد.'
    : 'Reach the team/rotation ER requirement first, then invest into the offensive stats in the listed priority.';
}

module.exports = {
  applyDefaultBuildLogic,
  applySnapshotBuildLogic,
  raidenReactionBuild,
  hasErRequirementPriority,
  buildPriorityNote,
};
