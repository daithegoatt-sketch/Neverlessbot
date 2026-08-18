'use strict';

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function rounded(value, digits = 1) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function artifactEmTotal(artifactRows = []) {
  let total = 0;
  let sawValue = false;

  for (const artifact of artifactRows || []) {
    if (String(artifact?.mainStatKey || '').toUpperCase() === 'FIGHT_PROP_ELEMENT_MASTERY') {
      const mainValue = Number(String(artifact?.mainValue || '').replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(mainValue)) {
        total += mainValue;
        sawValue = true;
      }
    }

    for (const sub of artifact?.substats || []) {
      if (String(sub?.fightProp || '').toUpperCase() !== 'FIGHT_PROP_ELEMENT_MASTERY') continue;
      const value = Number(sub?.numericValue);
      if (!Number.isFinite(value)) continue;
      total += value;
      sawValue = true;
    }
  }

  return sawValue ? total : 0;
}

/**
 * Enka's raw fightPropMap does not always include character passives that the
 * rendered Enka card calculates separately. Keep corrections narrow and only
 * apply a passive when we know its formula.
 */
function applyKnownComputedStats(characterName, stats, artifactRows = []) {
  const next = { ...(stats || {}) };

  if (normalize(characterName) === 'sandrone' && Number.isFinite(next.atk) && Number.isFinite(next.em)) {
    // A Lady's Code of Conduct: +8 EM per 100 ATK, capped at +160 EM.
    const passiveEm = Math.min(160, Math.max(0, next.atk * 0.08));
    const artifactEm = artifactEmTotal(artifactRows);
    const minimumComputedEm = artifactEm + passiveEm;

    // If fightPropMap already contains the passive, do not add it twice.
    if (next.em < minimumComputedEm - 1) next.em = rounded(next.em + passiveEm, 0);
  }

  return next;
}

module.exports = { applyKnownComputedStats, artifactEmTotal };
