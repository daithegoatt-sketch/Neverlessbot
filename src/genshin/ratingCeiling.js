'use strict';

const ELIGIBLE_KEYS = new Set(['critRate', 'critDmg', 'atk', 'hp', 'def', 'em']);
const MAX_COMPETITIVE_BONUS = 5;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function softCapFor(row) {
  const floor = Number(row?.target?.min);
  const publishedMax = Number(row?.target?.max);
  if (!Number.isFinite(floor) || floor <= 0) return null;

  if (row.key === 'critRate') {
    return Math.min(100, Math.max(
      Number.isFinite(publishedMax) ? publishedMax : floor,
      floor * 1.3,
    ));
  }

  const multiplier = ['atk', 'hp', 'def'].includes(row.key) ? 1.25 : 1.3;
  return Math.max(
    Number.isFinite(publishedMax) ? publishedMax : floor,
    floor * multiplier,
  );
}

function competitiveRows(evaluation) {
  const relevant = Array.isArray(evaluation?.relevantStats) ? evaluation.relevantStats : [];
  return relevant
    .filter((row) => ELIGIBLE_KEYS.has(row.key) && Number.isFinite(Number(row.effectiveValue)))
    .map((row) => {
      const floor = Number(row.target?.min);
      const softCap = softCapFor(row);
      if (!Number.isFinite(floor) || !Number.isFinite(softCap) || softCap <= floor) return null;
      const effectiveValue = row.key === 'critRate'
        ? Math.min(100, Number(row.effectiveValue))
        : Number(row.effectiveValue);
      const progress = clamp((effectiveValue - floor) / (softCap - floor));
      return {
        key: row.key,
        label: row.label,
        value: Number(row.value),
        effectiveValue,
        floor,
        publishedMax: Number(row.target?.max),
        softCap,
        progress,
        headroom: 1 - progress,
        weight: Number(row.weight) || 1,
      };
    })
    .filter(Boolean);
}

function competitiveCeilingScore(evaluation) {
  const relevant = Array.isArray(evaluation?.relevantStats) ? evaluation.relevantStats : [];
  if (!relevant.length || relevant.some((row) => row.status === 'down')) {
    return { score: 0, rows: competitiveRows(evaluation), eligible: false };
  }

  // This upper-band bonus is deliberately restricted to genuinely complete builds.
  // It must not let raw stats bypass the existing artifact/main-stat/set completion rules.
  const complete = Number(evaluation.artifactCount) === 5
    && Number(evaluation.artifactAvgLevel) >= 19.5
    && Number(evaluation.mainStatScore) >= 100
    && Number(evaluation.artifactSetScore) >= 100;
  const rows = competitiveRows(evaluation);
  if (!complete || !rows.length) return { score: 0, rows, eligible: false };

  let points = 0;
  let weights = 0;
  for (const row of rows) {
    points += row.progress * row.weight;
    weights += row.weight;
  }
  return {
    score: weights ? clamp(points / weights) : 0,
    rows,
    eligible: true,
  };
}

function applyCompetitiveCeiling(evaluation) {
  if (!evaluation || !Number.isFinite(Number(evaluation.score))) return evaluation;
  const baseScore = Number(evaluation.score);
  const ceiling = competitiveCeilingScore(evaluation);
  const bonus = ceiling.eligible
    ? Math.min(MAX_COMPETITIVE_BONUS, Math.max(0, Math.round(ceiling.score * MAX_COMPETITIVE_BONUS)))
    : 0;
  const score = Math.min(100, baseScore + bonus);

  return {
    ...evaluation,
    score,
    baseScore,
    competitiveBonus: score - baseScore,
    competitiveCeilingScore: Math.round(ceiling.score * 100),
    competitiveCeilingEligible: ceiling.eligible,
    competitiveCeilingRows: ceiling.rows,
  };
}

function competitiveAdviceRows(evaluation, max = 3) {
  return [...(evaluation?.competitiveCeilingRows || [])]
    .filter((row) => row.headroom > 0.02)
    .sort((a, b) => (b.headroom * b.weight) - (a.headroom * a.weight))
    .slice(0, max);
}

module.exports = {
  MAX_COMPETITIVE_BONUS,
  softCapFor,
  competitiveRows,
  competitiveCeilingScore,
  applyCompetitiveCeiling,
  competitiveAdviceRows,
};
