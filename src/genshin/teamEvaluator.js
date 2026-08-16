'use strict';

const { getGuide, normalizeTeams } = require('./guideClient');
const { fetchAkashaPercentile } = require('./akashaClient');
const { evaluateBuild } = require('./buildEvaluator');
const { findCharacter, getBuildSnapshot, listCharacters } = require('./enkaClient');

const SOURCE_BACKED_PREMIUM = {
  sandrone: [
    ['Sandrone', 'Yae Miko', 'Qiqi', 'Escoffier'],
    ['Sandrone', 'Yae Miko', 'Qiqi', 'Nicole'],
    ['Sandrone', 'Yae Miko', 'Qiqi', 'Beidou'],
    ['Sandrone', 'Yae Miko', 'Qiqi', 'Diona'],
    ['Sandrone', 'Yae Miko', 'Escoffier', 'Nicole'],
    ['Sandrone', 'Beidou', 'Diona', 'Sucrose'],
    ['Sandrone', 'Beidou', 'Diona', 'Xilonen'],
    ['Sandrone', 'Columbina', 'Ineffa', 'Yae Miko'],
  ],
};

function key(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sameName(a, b) {
  return key(a) === key(b);
}

function uniqueNames(values) {
  const out = [];
  for (const value of values || []) {
    if (!value || out.some((item) => sameName(item, value))) continue;
    out.push(value);
  }
  return out;
}

function overlapCount(a, b) {
  return uniqueNames(a).filter((name) => uniqueNames(b).some((item) => sameName(name, item))).length;
}

function exactTeam(a, b) {
  return uniqueNames(a).length === 4 && uniqueNames(b).length === 4 && overlapCount(a, b) === 4;
}

function dedupeTeams(teams) {
  const out = [];
  for (const team of teams || []) {
    const clean = uniqueNames(team).slice(0, 4);
    if (clean.length !== 4) continue;
    if (!out.some((existing) => exactTeam(existing, clean))) out.push(clean);
  }
  return out;
}

function premiumTeamsFor(mainName, guide) {
  return dedupeTeams([
    ...normalizeTeams(guide?.teams).premium,
    ...(SOURCE_BACKED_PREMIUM[key(mainName)] || []),
  ]);
}

function visibleMap(account) {
  const map = new Map();
  for (const row of listCharacters(account)) map.set(key(row.name), row);
  return map;
}

function constellationFor(account, name) {
  const row = visibleMap(account).get(key(name));
  return Number.isFinite(row?.constellation) ? row.constellation : null;
}

function teamConstellationIssues(mainName, team, account) {
  const issues = [];
  if (key(mainName) === 'sandrone') {
    if (team.some((name) => sameName(name, 'Beidou'))) {
      const constellation = constellationFor(account, 'Beidou');
      if (constellation != null && constellation < 6) issues.push(`Beidou C${constellation}: تحتاج C6 حتى تكون Stellar-Conduct support موصى بها`);
    }
    if (team.some((name) => sameName(name, 'Diona'))) {
      const constellation = constellationFor(account, 'Diona');
      if (constellation != null && constellation < 6) issues.push(`Diona C${constellation}: تحتاج C6 حتى تعطي قيمة البافر المطلوبة لهذا الدور`);
    }
  }
  return issues;
}

function replacementRule(mainName, missingName, candidateName, account) {
  const main = key(mainName);
  const missing = key(missingName);
  const candidate = key(candidateName);

  // KQM Sandrone guide: C6 Beidou is a viable Electro replacement; pre-C6 is
  // explicitly not recommended as a Stellar-Conduct support. C6 Diona has the
  // same published constellation gate for her support slot.
  if (main === 'sandrone' && missing === 'yaemiko' && candidate === 'beidou') {
    const constellation = constellationFor(account, candidateName);
    return constellation != null && constellation >= 6
      ? { allowed: true, note: 'C6 Beidou', sourceBacked: true }
      : { allowed: false, note: 'Beidou تحتاج C6 لهذا الدور', sourceBacked: true };
  }
  if (main === 'sandrone' && candidate === 'diona') {
    const constellation = constellationFor(account, candidateName);
    return constellation != null && constellation >= 6
      ? { allowed: true, note: 'C6 Diona', sourceBacked: true }
      : { allowed: false, note: 'Diona تحتاج C6 لهذا الدور', sourceBacked: true };
  }
  return null;
}

function publishedReplacement(mainName, currentTeam, missingName, candidateName, premiumTeams, account) {
  const special = replacementRule(mainName, missingName, candidateName, account);
  if (special) return special;

  const altered = currentTeam.map((name) => sameName(name, missingName) ? candidateName : name);
  const exact = premiumTeams.some((team) => exactTeam(team, altered));
  if (exact) return { allowed: true, note: 'بديل موجود ضمن Premium team منشور', sourceBacked: true };

  const related = premiumTeams.some((team) =>
    team.some((name) => sameName(name, mainName))
    && team.some((name) => sameName(name, candidateName))
    && overlapCount(team, altered) >= 3,
  );
  return related ? { allowed: true, note: 'بديل من Premium variant منشور', sourceBacked: true } : null;
}

function findReplacement(mainName, team, missingName, account, premiumTeams) {
  const visible = listCharacters(account).map((row) => row.name);
  const candidates = visible.filter((name) => !team.some((member) => sameName(member, name)));
  for (const candidate of candidates) {
    const rule = publishedReplacement(mainName, team, missingName, candidate, premiumTeams, account);
    if (rule?.allowed) return { name: candidate, ...rule };
  }
  return null;
}

async function evaluateCharacter(uid, account, name) {
  const character = findCharacter(account, name);
  if (!character) return { name, visible: false, score: null, evaluation: null, akasha: null, snapshot: null };
  const snapshot = getBuildSnapshot(character);
  const guide = await getGuide(name);
  if (!guide) return { name, visible: true, score: null, evaluation: null, akasha: null, snapshot };
  const akasha = await fetchAkashaPercentile(uid, name).catch(() => null);
  const evaluation = evaluateBuild(snapshot, guide, { akashaPercentile: akasha });
  return { name, visible: true, score: evaluation.score, evaluation, akasha, snapshot };
}

function bestPublishedMatch(team, premiumTeams) {
  let best = null;
  for (const published of premiumTeams) {
    const overlap = overlapCount(team, published);
    if (!best || overlap > best.overlap) best = { team: published, overlap, exact: overlap === 4 };
  }
  return best;
}

function synergyScore(team, premiumTeams, replacementUsed = false, constraintIssues = []) {
  const match = bestPublishedMatch(team, premiumTeams);
  let score;
  if (match?.exact) score = 100;
  else if (replacementUsed && (match?.overlap || 0) >= 3) score = 92;
  else if ((match?.overlap || 0) >= 3) score = 86;
  else if ((match?.overlap || 0) === 2) score = 68;
  else score = 45;
  if (constraintIssues.length) score = Math.min(score, 72);
  return score;
}

function qualityLabel(score, ar) {
  if (!Number.isFinite(score)) return ar ? 'غير مكتمل' : 'Incomplete';
  if (score >= 92) return ar ? 'نخبوي' : 'Elite';
  if (score >= 85) return ar ? 'ممتاز' : 'Excellent';
  if (score >= 75) return ar ? 'قوي' : 'Strong';
  if (score >= 60) return ar ? 'جيد' : 'Good';
  return ar ? 'يحتاج تحسين' : 'Needs work';
}

function akashaText(row) {
  const top = Number(row?.akasha?.topPercent ?? row?.akasha);
  return Number.isFinite(top) ? ` • Akasha Top ${top}%` : '';
}

function buildIssueText(row, ar) {
  if (!row.visible) return ar ? 'غير ظاهرة في Showcase' : 'not visible in Showcase';
  if (!row.evaluation) return ar ? 'لا يوجد تقييم موثوق للبيلد' : 'no reliable build rating';
  const notes = row.evaluation.notes
    .filter((note) => ['down', 'warn'].includes(note.type))
    .slice(0, 2)
    .map((note) => note.text);
  return notes.length ? notes.join('؛ ') : (ar ? 'البيلد متوازن حاليًا' : 'build is currently balanced');
}

async function reviewTeam(uid, account, mainName, team, options = {}) {
  const guide = await getGuide(mainName);
  const premiumTeams = premiumTeamsFor(mainName, guide);
  const members = uniqueNames(team).slice(0, 4);
  const rows = [];
  for (const name of members) rows.push(await evaluateCharacter(uid, account, name));
  const rated = rows.filter((row) => Number.isFinite(row.score));
  const buildAverage = rated.length ? rated.reduce((sum, row) => sum + row.score, 0) / rated.length : null;
  const constraintIssues = teamConstellationIssues(mainName, members, account);
  const synergy = synergyScore(members, premiumTeams, Boolean(options.replacementUsed), constraintIssues);
  const total = Number.isFinite(buildAverage) ? Math.round(buildAverage * 0.75 + synergy * 0.25) : null;
  return {
    mainName,
    team: members,
    rows,
    guide,
    premiumTeams,
    synergy,
    buildAverage: Number.isFinite(buildAverage) ? Math.round(buildAverage * 10) / 10 : null,
    score: total,
    match: bestPublishedMatch(members, premiumTeams),
    replacementUsed: options.replacementUsed || null,
    constraintIssues,
  };
}

async function accountTeamCandidates(uid, account, mainName, limit = 3) {
  const guide = await getGuide(mainName);
  const premiumTeams = premiumTeamsFor(mainName, guide);
  if (!premiumTeams.length) return { guide, candidates: [] };
  const visible = visibleMap(account);
  const scored = [];

  for (const published of premiumTeams) {
    const original = uniqueNames(published).slice(0, 4);
    if (original.length !== 4 || !original.some((name) => sameName(name, mainName))) continue;
    let team = [...original];
    const missing = team.filter((name) => !visible.has(key(name)));
    let replacementUsed = null;

    if (missing.length === 1) {
      const replacement = findReplacement(mainName, team, missing[0], account, premiumTeams);
      if (replacement) {
        team = team.map((name) => sameName(name, missing[0]) ? replacement.name : name);
        replacementUsed = { missing: missing[0], replacement: replacement.name, note: replacement.note };
      }
    }

    const finalMissing = team.filter((name) => !visible.has(key(name)));
    const coverage = 4 - finalMissing.length;
    const review = await reviewTeam(uid, account, mainName, team, { replacementUsed });
    scored.push({ ...review, original, finalMissing, coverage, replacementUsed });
  }

  scored.sort((a, b) =>
    b.coverage - a.coverage
    || Number(Boolean(b.replacementUsed)) - Number(Boolean(a.replacementUsed))
    || (b.score ?? 0) - (a.score ?? 0),
  );
  return { guide, candidates: scored.slice(0, limit) };
}

function formatReview(review, lang = 'ar', options = {}) {
  const ar = lang === 'ar';
  const lines = [];
  lines.push(`**${review.mainName} — ${ar ? 'تقييم التيم' : 'Team Review'}${Number.isFinite(review.score) ? `: ${review.score}% (${qualityLabel(review.score, ar)})` : ''}**`);
  lines.push(review.team.join(' • '));
  lines.push(`${ar ? 'توافق التشكيلة مع Premium المنشور' : 'Published Premium compatibility'}: ${review.synergy}%`);
  if (review.match?.team) lines.push(`${ar ? 'أقرب Premium team منشور' : 'Closest published Premium team'}: ${review.match.team.join(' • ')}`);
  if (review.replacementUsed) {
    lines.push(`${ar ? 'البديل المستخدم' : 'Replacement used'}: ${review.replacementUsed.missing} → **${review.replacementUsed.replacement}**${review.replacementUsed.note ? ` (${review.replacementUsed.note})` : ''}`);
  }
  if (review.constraintIssues?.length) {
    lines.push(`\n**${ar ? 'شروط مهمة' : 'Important requirements'}:**`);
    review.constraintIssues.forEach((item) => lines.push(`• ${item}`));
  }

  lines.push(`\n**${ar ? 'فحص الشخصيات الظاهرة' : 'Visible build checks'}:**`);
  for (const row of review.rows) {
    const rating = Number.isFinite(row.score) ? `${row.score}%` : (ar ? 'بدون نسبة' : 'unrated');
    lines.push(`• **${row.name}** — ${rating}${akashaText(row)} — ${buildIssueText(row, ar)}`);
  }

  const missing = review.rows.filter((row) => !row.visible).map((row) => row.name);
  if (missing.length) lines.push(`\n${ar ? 'ملاحظة' : 'Note'}: ${ar ? 'ما أقدر أدقق بيلد' : 'I cannot inspect the build for'} **${missing.join(', ')}** ${ar ? 'لأنها غير ظاهرة في الـShowcase.' : 'because they are not visible in Showcase.'}`);

  const problems = review.rows
    .filter((row) => row.visible && row.evaluation)
    .flatMap((row) => row.evaluation.notes.filter((note) => ['down', 'warn'].includes(note.type)).slice(0, 2).map((note) => `${row.name}: ${note.text}`))
    .slice(0, 6);
  if (problems.length) {
    lines.push(`\n**${ar ? 'أولوية التحسين للتيم' : 'Team improvement priority'}:**`);
    problems.forEach((item) => lines.push(`• ${item}`));
  }

  if (options.partial) lines.push(ar ? '\nالتقييم جزئي لأنه يعتمد فقط على الشخصيات الظاهرة في Showcase.' : '\nThis is a partial rating because only visible Showcase characters can be inspected.');
  return lines.join('\n');
}

function formatAccountCandidates(result, mainName, lang = 'ar') {
  const ar = lang === 'ar';
  if (!result.candidates.length) return ar
    ? `ما لقيت Premium teams منشورة كفاية لـ **${mainName}** حتى أقيم تيم حسابك بدون تخمين.`
    : `I could not find enough published Premium teams for **${mainName}** to rate your account team without guessing.`;

  const lines = [`**${mainName} — ${ar ? 'أفضل احتمالات Premium من الـShowcase' : 'Best Premium options from Showcase'}**`];
  result.candidates.forEach((candidate, index) => {
    lines.push(`\n**${index + 1}. ${candidate.team.join(' • ')}**`);
    lines.push(`${ar ? 'المتوفر' : 'Available'}: ${candidate.coverage}/4${Number.isFinite(candidate.score) ? ` • ${ar ? 'تقييم التيم' : 'Team score'} ${candidate.score}%` : ''}`);
    if (candidate.replacementUsed) lines.push(`${ar ? 'بديل منطقي منشور' : 'Published replacement'}: ${candidate.replacementUsed.missing} → ${candidate.replacementUsed.replacement}${candidate.replacementUsed.note ? ` (${candidate.replacementUsed.note})` : ''}`);
    if (candidate.finalMissing.length) lines.push(`${ar ? 'الناقص من الـShowcase' : 'Missing from Showcase'}: ${candidate.finalMissing.join(', ')}`);
    if (candidate.constraintIssues?.length) lines.push(`${ar ? 'شروط' : 'Requirements'}: ${candidate.constraintIssues.join(' • ')}`);
    const issues = candidate.rows
      .filter((row) => row.visible && row.evaluation)
      .flatMap((row) => row.evaluation.notes.filter((note) => note.type === 'down').slice(0, 1).map((note) => `${row.name}: ${note.text}`))
      .slice(0, 3);
    if (issues.length) lines.push(`${ar ? 'أبرز النواقص' : 'Main build gaps'}: ${issues.join(' • ')}`);
  });
  return lines.join('\n');
}

module.exports = {
  reviewTeam,
  accountTeamCandidates,
  formatReview,
  formatAccountCandidates,
  publishedReplacement,
  bestPublishedMatch,
  overlapCount,
  premiumTeamsFor,
};
