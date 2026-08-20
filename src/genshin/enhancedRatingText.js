'use strict';

const { accountEvaluationText } = require('./responses');
const { akashaImprovementAdvice } = require('./ratingCopyV2');

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
}

function cleanSetName(value) {
  return String(value || '')
    .replace(/\([^)]*(?:pc|piece)[^)]*\)/ig, '')
    .replace(/\b[24]\s*(?:pc|piece)(?:\s*set)?\b/ig, '')
    .replace(/^\s*[24]\s*(?:pc|piece)\s*/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function requestedPieces(value) {
  const text = String(value || '');
  const match = text.match(/\b([24])\s*(?:pc|piece)/i);
  return match ? Number(match[1]) : 4;
}

function currentSetEntries(snapshot) {
  return Object.entries(snapshot?.setCounts || {})
    .filter(([name, count]) => name && Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
}

function currentSetText(snapshot) {
  const entries = currentSetEntries(snapshot);
  if (!entries.length) return null;
  const meaningful = entries.filter(([, count]) => Number(count) >= 2);
  const shown = meaningful.length ? meaningful : entries.slice(0, 2);
  return shown.map(([name, count]) => `${name} ${count}pc`).join(' + ');
}

function setUpgrade(snapshot, guide) {
  const recommendations = (guide?.artifacts || [])
    .map((raw) => ({ raw: String(raw || '').trim(), name: cleanSetName(raw), pieces: requestedPieces(raw) }))
    .filter((row) => row.name);
  if (!recommendations.length) return null;

  const current = currentSetEntries(snapshot);
  if (!current.length) return null;

  const valid = recommendations.some((recommended) => {
    const wanted = normalize(recommended.name);
    return current.some(([name, count]) => {
      const actual = normalize(name);
      const nameMatches = wanted && actual && (wanted.includes(actual) || actual.includes(wanted));
      return nameMatches && Number(count) >= recommended.pieces;
    });
  });
  if (valid) return null;

  const dominant = current[0];
  if (!dominant || Number(dominant[1]) < 2) return null;
  return {
    current: currentSetText(snapshot) || dominant[0],
    recommended: recommendations[0].raw,
  };
}

function addSetNameToArtifactLine(text, setText) {
  if (!setText || !text) return text;
  return text.replace(
    /(\*\*Artifacts:\*\*\s*\d+\/5)(\s*•)/,
    `$1 • **Set:** ${setText}$2`,
  );
}

function removeGenericSetWarnings(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !/^•\s*Artifact set match\s+\d+%/i.test(line.trim()))
    .join('\n');
}

function injectSetUpgrade(text, issue, lang) {
  if (!issue) return text;
  const ar = lang === 'ar';
  const heading = ar ? '**الأولوية للتحسين:**' : '**Improvement priority:**';
  const line = ar
    ? `• الـSet: ${issue.current} → ${issue.recommended}`
    : `• Set: ${issue.current} → ${issue.recommended}`;
  if (text.includes(heading)) return text.replace(heading, `${heading}\n${line}`);
  return `${text}\n${heading}\n${line}`;
}

function stripSetAdviceFromAkasha(text) {
  if (!text) return text;
  return String(text)
    .split('\n')
    .filter((line) => !/^•\s*(?:الـSet|Set):/i.test(line.trim()))
    .join('\n')
    .trim();
}

function enhancedAccountEvaluationText(snapshot, evaluation, comparison, guide, lang, akashaRanking = null) {
  const setText = currentSetText(snapshot);
  const issue = setUpgrade(snapshot, guide);
  let base = accountEvaluationText(snapshot, evaluation, comparison, guide, lang, akashaRanking);
  base = addSetNameToArtifactLine(base, setText);
  base = removeGenericSetWarnings(base);
  base = injectSetUpgrade(base, issue, lang);

  const advice = stripSetAdviceFromAkasha(
    akashaImprovementAdvice(snapshot, guide, evaluation, akashaRanking, lang),
  );
  return advice ? `${base}\n\n${advice}` : base;
}

module.exports = {
  enhancedAccountEvaluationText,
  currentSetText,
  setUpgrade,
  cleanSetName,
};
