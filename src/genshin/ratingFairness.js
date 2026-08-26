'use strict';

const { usefulRvScore } = require('./buildEvaluator');

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function topPercent(value) {
  const number = Number(value?.topPercent ?? value?.top_percent ?? value);
  return Number.isFinite(number) && number > 0 && number <= 100 ? number : null;
}

function akashaBenchmarkScore(value) {
  const percent = topPercent(value);
  if (!Number.isFinite(percent)) return null;
  if (percent <= 0.01) return 100;
  if (percent <= 0.05) return 99.5;
  if (percent <= 0.1) return 99;
  if (percent <= 0.5) return 98;
  if (percent <= 1) return 97;
  if (percent <= 2) return 96;
  if (percent <= 5) return 94;
  if (percent <= 10) return 91;
  if (percent <= 20) return 87;
  if (percent <= 35) return 82;
  if (percent <= 50) return 77;
  if (percent <= 75) return 70;
  return 62;
}

function akashaTrust(value) {
  const percent = topPercent(value);
  if (!Number.isFinite(percent) || percent > 35) return 0;
  if (percent <= 0.1) return 0.82;
  if (percent <= 1) return 0.76;
  if (percent <= 2) return 0.72;
  if (percent <= 5) return 0.66;
  if (percent <= 10) return 0.58;
  if (percent <= 20) return 0.46;
  return 0.32;
}

function structuralScore(evaluation, artifactQuality) {
  const completion = clamp(Number(evaluation?.artifactCompletionScore) / 100) * 100;
  const mains = clamp(Number(evaluation?.mainStatScore) / 100) * 100;
  const set = clamp(Number(evaluation?.artifactSetScore) / 100) * 100;
  const weapon = clamp(Number(evaluation?.weaponScore) / 100) * 100;
  const rv = usefulRvScore(Number(artifactQuality)) * 100;
  return completion * 0.20
    + mains * 0.17
    + set * 0.13
    + weapon * 0.15
    + rv * 0.35;
}

function akashaValidatedScore(evaluation, snapshot, akasha, artifactQuality) {
  const benchmark = akashaBenchmarkScore(akasha);
  const trust = akashaTrust(akasha);
  if (!Number.isFinite(benchmark) || trust <= 0) return null;

  if (Number(evaluation?.artifactCount) !== 5
    || Number(evaluation?.artifactAvgLevel) < 18
    || !snapshot?.weapon?.name) return null;

  const structure = structuralScore(evaluation, artifactQuality);
  let validated = benchmark * trust + structure * (1 - trust);

  if (Number(evaluation?.mainStatScore) < 34) validated = Math.min(validated, 92);
  else if (Number(evaluation?.mainStatScore) < 67) validated = Math.min(validated, 95);
  if (Number(evaluation?.artifactSetScore) < 50) validated = Math.min(validated, 93);
  if (Number(evaluation?.weaponScore) < 60) validated = Math.min(validated, 92);
  if (Number(evaluation?.artifactAvgLevel) < 19.5) validated = Math.min(validated, 94);

  return { score: validated, benchmark, trust, structural: structure };
}

function qualityGate(score) {
  return clamp((Number(score) - 72) / 20);
}

function constellationImpact(description) {
  const text = String(description || '');
  if (!text) return 0.15;

  let impact = 0.18;
  if (/increases?\s+the\s+level\s+of|level\s+is\s+increased\s+by\s+3/i.test(text)) impact = Math.max(impact, 0.45);
  if (/\b(?:dmg|damage|crit|elemental mastery|\bem\b|\batk\b|attack|\bhp\b|def(?:ense)?|res(?:istance)?|reaction)\b/i.test(text)) impact = Math.max(impact, 0.70);
  if (/\b(?:dealing|deals|increased by|increase(?:s)? .* by|decreased by|additional|bonus|multiplier|ignore|shred)\b/i.test(text)) impact = Math.max(impact, 0.82);
  if (/\b(?:crit rate|crit dmg|def(?:ense)? is decreased|res(?:istance)? is decreased|damage dealt|dmg dealt)\b/i.test(text)) impact = Math.max(impact, 1);

  const utilityOnly = /\b(?:movement|stamina|interruption resistance|cooldown|duration|healing)\b/i.test(text)
    && !/\b(?:dmg|damage|crit|elemental mastery|\batk\b|attack|def(?:ense)? is decreased|res(?:istance)? is decreased)\b/i.test(text);
  if (utilityOnly) impact = Math.min(impact, 0.35);
  return clamp(impact, 0.1, 1);
}

function constellationEvidence(snapshot, constellationData = null) {
  const count = Math.max(0, Math.min(6, Number(snapshot?.constellation) || 0));
  if (!count) return { count: 0, impact: 0, documented: 0 };

  let impact = 0;
  let documented = 0;
  for (let index = 1; index <= count; index += 1) {
    const row = constellationData?.[`c${index}`];
    if (row?.description || row?.descriptionRaw) {
      documented += 1;
      impact += constellationImpact(row.description || row.descriptionRaw);
    } else {
      impact += 0.35;
    }
  }
  return { count, impact, documented };
}

function constellationBonus(snapshot, baseScore, constellationData = null) {
  const evidence = constellationEvidence(snapshot, constellationData);
  if (!evidence.count) return 0;
  // The total constellation influence remains a small tie-breaker. Actual documented
  // combat constellations gain more weight than utility-only nodes, but even C6 is
  // capped so investment cannot replace artifact/build quality.
  const raw = Math.min(1.2, evidence.impact * 0.22);
  return raw * qualityGate(baseScore);
}

function refinementBonus(snapshot, evaluation, baseScore) {
  if (Number(evaluation?.weaponScore) < 70) return 0;
  const refinement = Math.max(1, Math.min(5, Number(snapshot?.weapon?.refinement) || 1));
  const table = [0, 0.08, 0.16, 0.24, 0.32];
  return table[refinement - 1] * qualityGate(baseScore);
}

function applyRatingFairness(evaluation, snapshot, options = {}) {
  if (!evaluation || !Number.isFinite(Number(evaluation.score))) return evaluation;

  const originalScore = Number(evaluation.score);
  const validation = akashaValidatedScore(evaluation, snapshot, options.akashaPercentile, options.artifactQuality);
  const validatedBase = Math.max(originalScore, Number(validation?.score) || 0);

  const constellation = constellationEvidence(snapshot, options.constellationData || null);
  const cBonus = constellationBonus(snapshot, validatedBase, options.constellationData || null);
  const rBonus = refinementBonus(snapshot, evaluation, validatedBase);
  const precise = Math.min(100, validatedBase + cBonus + rBonus);

  return {
    ...evaluation,
    score: Math.round(precise),
    rankingScore: round(precise),
    preFairnessScore: originalScore,
    structuralScore: round(structuralScore(evaluation, options.artifactQuality), 1),
    akashaValidationScore: validation ? round(validation.score, 1) : null,
    akashaBenchmarkScore: validation ? validation.benchmark : null,
    akashaValidationTrust: validation ? round(validation.trust, 2) : 0,
    constellationBonus: round(cBonus, 2),
    constellationImpact: round(constellation.impact, 2),
    constellationDocumented: constellation.documented,
    refinementBonus: round(rBonus, 2),
  };
}

module.exports = {
  applyRatingFairness,
  akashaBenchmarkScore,
  akashaTrust,
  structuralScore,
  akashaValidatedScore,
  constellationImpact,
  constellationEvidence,
  constellationBonus,
  refinementBonus,
};
