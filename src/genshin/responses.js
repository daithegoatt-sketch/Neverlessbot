'use strict';

const { LABELS } = require('./buildEvaluator');
const { formatStat, formatTarget } = require('./statProfile');

function ar(lang) { return lang === 'ar'; }
function pctDelta(value) { return `${value > 0 ? '+' : ''}${value}`; }

function normalizeTeams(guide, type = 'premium') {
  if (!guide?.teams) return [];
  if (Array.isArray(guide.teams)) return guide.teams;
  if (type === 'f2p') return guide.teams.f2p || [];
  if (type === 'all') return [...(guide.teams.premium || []), ...(guide.teams.f2p || [])];
  return guide.teams.premium || [];
}

function buildText(guide, lang, f2p = false) {
  const A = ar(lang);
  const lines = [`**${guide.name} — ${A ? (f2p ? 'بيلد F2P' : 'البيلد') : (f2p ? 'F2P Build' : 'Build')}**`];
  if (guide.artifacts?.length) lines.push(`**${A ? 'الآرتيفاكت' : 'Artifacts'}:** ${guide.artifacts.slice(0, 3).join(' / ')}`);
  if (guide.stats?.main?.length) { lines.push(`**${A ? 'تقسيم القطع' : 'Main Stats'}:**`); guide.stats.main.forEach((item) => lines.push(`• ${item}`)); }
  if (guide.stats?.priority) lines.push(`**${A ? 'السب ستات' : 'Substats'}:** ${guide.stats.priority}`);
  const weapons = f2p && guide.f2pWeapons?.length ? guide.f2pWeapons : guide.weapons;
  if (weapons?.length) lines.push(`**${A ? (f2p ? 'أسلحة F2P' : 'أفضل الأسلحة') : (f2p ? 'F2P Weapons' : 'Best Weapons')}**: ${weapons.slice(0, 6).join(' / ')}`);
  if (guide.stats?.targets?.length) { lines.push(`**${A ? 'الأرقام اللي تستهدفها' : 'Stat Targets'}:**`); guide.stats.targets.slice(0, 7).forEach((item) => lines.push(`• ${item}`)); }
  return lines.join('\n');
}

function artifactsText(guide, lang) {
  const A = ar(lang), lines = [`**${guide.name} — ${A ? 'الآرتيفاكت' : 'Artifacts'}**`];
  if (guide.artifacts?.length) guide.artifacts.slice(0, 5).forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  if (guide.stats?.main?.length) { lines.push(`**${A ? 'تقسيم القطع' : 'Main Stats'}:**`); guide.stats.main.forEach((item) => lines.push(`• ${item}`)); }
  if (guide.stats?.priority) lines.push(`**${A ? 'السب ستات' : 'Substats'}:** ${guide.stats.priority}`);
  return lines.join('\n');
}

function weaponsText(guide, lang, f2p = false) {
  const A = ar(lang), weapons = f2p && guide.f2pWeapons?.length ? guide.f2pWeapons : guide.weapons || [];
  const title = f2p ? (A ? 'أسلحة F2P' : 'F2P Weapons') : (A ? 'أفضل الأسلحة' : 'Best Weapons');
  const lines = [`**${guide.name} — ${title}**`];
  if (!weapons.length) lines.push(A ? 'ما عندي ترتيب موثوق للأسلحة حاليًا.' : 'No reliable weapon ranking is available right now.'); else weapons.slice(0, 8).forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  return lines.join('\n');
}

function statsText(guide, lang) {
  const A = ar(lang), lines = [`**${guide.name} — ${A ? 'الإحصائيات المطلوبة' : 'Recommended Stats'}**`];
  if (guide.stats?.targets?.length) guide.stats.targets.slice(0, 8).forEach((item) => lines.push(`• ${item}`)); else lines.push(A ? 'ما عندي أرقام Target موثقة لهذه الشخصية حاليًا.' : 'No reliable target ranges are available for this character right now.');
  if (guide.stats?.priority) lines.push(`**${A ? 'الأولوية' : 'Priority'}:** ${guide.stats.priority}`);
  return lines.join('\n');
}

function groupLabel(value, characterName) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const escaped = String(characterName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped) text = text.replace(new RegExp(`^${escaped}\\s*`, 'i'), '');
  return text.replace(/\s+Teams?$/i, '').replace(/^Best\s+/i, '').trim();
}

function reqKey(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function optionLabel(name, requirements = {}) {
  const constellation = Number(requirements?.[reqKey(name)]?.constellation);
  return Number.isInteger(constellation) ? `${name} C${constellation}` : name;
}

function slotTeamLine(slots, requirements = {}) {
  return (slots || []).map((slot) => (slot || []).map((name) => optionLabel(name, requirements)).join(' / ')).join(' | ');
}

function groupedTeamText(guide, lang, type) {
  const A = ar(lang);
  const groups = (guide.teamGroups || []).filter((group) => (type === 'f2p' ? group.kind === 'f2p' : group.kind !== 'f2p'));
  if (!groups.length) return null;

  const title = type === 'f2p' ? 'F2P' : (A ? 'أفضل التيمات' : 'Best Teams');
  const lines = [`**${guide.name} — ${title}**`];
  let shownGroups = 0;

  for (const group of groups) {
    if (shownGroups >= 10) break;
    const role = groupLabel(group.role, guide.name);
    const category = groupLabel(group.category, guide.name);
    const labels = [category, role].filter((value, index, all) => value && all.indexOf(value) === index);
    lines.push(`\n**${labels.join(' — ') || (A ? 'تيم منشور' : 'Published Team')}**`);

    const displays = [];
    for (const slots of group.slotTeams || []) {
      const line = slotTeamLine(slots, group.requirements);
      if (line && !displays.includes(line)) displays.push(line);
    }
    if (!displays.length) {
      for (const team of group.teams || []) {
        const line = team.join(' | ');
        if (line && !displays.includes(line)) displays.push(line);
      }
    }

    displays.slice(0, 3).forEach((line) => lines.push(`• ${line}`));
    shownGroups += 1;
  }

  return lines.join('\n');
}

function teamText(guide, lang, type = 'premium', limit = 4) {
  const grouped = groupedTeamText(guide, lang, type);
  if (grouped) return grouped;

  const A = ar(lang), teams = normalizeTeams(guide, type), typeText = type === 'f2p' ? 'F2P' : (A ? 'أفضل التيمات' : 'Best Teams'), lines = [`**${guide.name} — ${typeText}**`];
  if (!teams.length) { lines.push(A ? 'ما لقيت تيم منشور بهذا التصنيف حاليًا.' : 'No published team is available for that category right now.'); return lines.join('\n'); }
  teams.slice(0, limit).forEach((team, i) => lines.push(`${i + 1}. ${team.join(' | ')}`)); return lines.join('\n');
}

function comboText(guide, lang) {
  const A = ar(lang), lines = [`**${guide.name} — ${A ? 'الكومبو / الروتيشن' : 'Combo / Rotation'}**`];
  if (!guide.combos?.length) { lines.push(A ? 'ما قدرت أستخرج كومبو منشور بشكل موثوق لهذه الشخصية حاليًا.' : 'I could not extract a reliable published combo for this character right now.'); return lines.join('\n'); }
  guide.combos.slice(0, 6).forEach((step, i) => lines.push(`${i + 1}. ${step}`)); return lines.join('\n');
}

function baseText(character, stats, lang) {
  const hp = stats?.hp || stats?.basehp, atk = stats?.attack || stats?.atk || stats?.baseatk, def = stats?.defense || stats?.def || stats?.basedef;
  return [`**${character?.name || 'Character'} — Base Stats**`, hp != null ? `Base HP: ${Number(hp).toLocaleString('en-US', { maximumFractionDigits: 1 })}` : null, atk != null ? `Base ATK: ${Number(atk).toLocaleString('en-US', { maximumFractionDigits: 1 })}` : null, def != null ? `Base DEF: ${Number(def).toLocaleString('en-US', { maximumFractionDigits: 1 })}` : null].filter(Boolean).join('\n');
}

function opinionText(guide, lang) {
  if (!ar(lang)) return `**${guide.name}**: ${guide.role || 'I have build and team data for this character.'} Ask for the exact part you want and I’ll only answer that.`;
  return `**${guide.name}**: ${guide.role || 'عندي لها بيانات بيلد وتيمات'}. تقدر تطلب البيلد، التيم، F2P، الكومبو، الأسلحة أو الستات — وأنا أرد على المطلوب فقط.`;
}

function closestReplacement(currentTeam, alternatives, missingNames) {
  const missing = new Set(missingNames.map((x) => String(x).toLowerCase())), base = currentTeam || [];
  return alternatives.filter((team) => !team.some((name) => missing.has(String(name).toLowerCase()))).map((team) => ({ team, same: team.filter((member) => base.some((x) => String(x).toLowerCase() === String(member).toLowerCase())).length, replacements: team.filter((member) => !base.some((x) => String(x).toLowerCase() === String(member).toLowerCase())) })).sort((a, b) => b.same - a.same)[0] || null;
}

function replacementText(character, currentTeam, alternatives, missingNames, lang) {
  const A = ar(lang), best = closestReplacement(currentTeam, alternatives, missingNames), missing = missingNames.join(', ');
  if (!best) return A ? `بعد استبعاد **${missing}** ما لقيت بديل منشور قريب لنفس تيم **${character}**.` : `After excluding **${missing}**, I couldn't find a close published replacement for that **${character}** team.`;
  const replacement = best.replacements.join(' / ');
  return A ? `إذا ما عندك **${missing}**، أقرب بديل منشور هو **${replacement || 'تغيير التشكيلة'}**.\nالتيم يصير: **${best.team.join(' | ')}**` : `If you don't have **${missing}**, the closest published replacement is **${replacement || 'a different shell'}**.\nUse: **${best.team.join(' | ')}**`;
}

function ratingWord(score, lang) {
  const A = ar(lang);
  if (score >= 95) return A ? 'نخبوي' : 'Elite';
  if (score >= 90) return A ? 'ممتاز' : 'Excellent';
  if (score >= 80) return A ? 'قوي' : 'Strong';
  if (score >= 70) return A ? 'جيد' : 'Good';
  if (score >= 60) return A ? 'متوسط' : 'Average';
  if (score >= 45) return A ? 'يحتاج تحسين' : 'Needs Work';
  return A ? 'غير مكتمل' : 'Incomplete';
}

function akashaInfo(value) {
  if (Number.isFinite(value)) return { topPercent: value };
  if (!value || typeof value !== 'object') return null;
  const topPercent = Number(value.topPercent ?? value.top_percent);
  if (!Number.isFinite(topPercent)) return null;
  return { ...value, topPercent };
}

function formatTop(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 10) return Math.round(value).toString();
  return Number(value.toFixed(2)).toString();
}

function accountEvaluationText(snapshot, evaluation, comparison, guide, lang, akashaRanking = null) {
  const A = ar(lang), lines = [`**${snapshot.name} — ${A ? 'تقييم البيلد' : 'Build Rating'}: ${evaluation.score}% (${ratingWord(evaluation.score, lang)})**`];

  if (evaluation.relevantStats?.length) {
    lines.push(`**${A ? 'الإحصائيات المهمة لهذه الشخصية' : 'Relevant stats for this character'}:**`);
    for (const row of evaluation.relevantStats.slice(0, 6)) {
      const marker = row.status === 'down' ? '↓' : row.status === 'warn' ? '!' : '✓';
      lines.push(`${marker} **${row.label}:** ${formatStat(row.key, row.value)}  |  ${A ? 'الهدف' : 'target'} ${formatTarget(row.target)}`);
    }
  }

  if (snapshot.weapon?.name) lines.push(`**${A ? 'السلاح' : 'Weapon'}:** ${snapshot.weapon.name}${snapshot.weapon.refinement ? ` R${snapshot.weapon.refinement}` : ''}`);
  lines.push(`**Artifacts:** ${evaluation.artifactCount}/5 • ${A ? 'متوسط المستوى' : 'avg level'} +${evaluation.artifactAvgLevel} • Main Stats ${evaluation.mainStatScore}% • Set ${evaluation.artifactSetScore}%`);

  const weak = evaluation.notes.filter((n) => n.type === 'down' || n.type === 'warn').slice(0, 4);
  if (weak.length) {
    lines.push(`**${A ? 'الأولوية للتحسين' : 'Improvement priority'}:**`);
    weak.forEach((n) => lines.push(`• ${n.text}`));
  }

  if (comparison) {
    lines.push(`**${A ? 'المقارنة مع آخر نسخة مختلفة' : 'Compared with the previous different build'}:** ${comparison.previousScore}% → ${comparison.currentScore}% (${pctDelta(comparison.scoreDelta)}%)`);
    const useful = Object.entries(comparison.deltas).filter(([, value]) => value !== 0).slice(0, 6);
    if (useful.length) lines.push(useful.map(([key, value]) => `${LABELS[key] || key} ${value > 0 ? '+' : ''}${value}`).join(' • '));
    lines.push(comparison.scoreDelta > 0 ? (A ? 'البيلد الحالي أفضل من النسخة السابقة.' : 'The current build is stronger than the previous one.') : comparison.scoreDelta < 0 ? (A ? 'البيلد الحالي أضعف إجمالًا؛ راجع الإحصائيات التي نزلت.' : 'The current build is weaker overall; review the stats that dropped.') : (A ? 'التقييم العام لم يتغير فعليًا.' : 'The overall rating is effectively unchanged.'));
  }

  const akasha = akashaInfo(akashaRanking);
  lines.push(`**${A ? 'الترتيب والتقييم' : 'Ranking & Rating'}:**`);
  if (akasha) {
    const parts = [`Top ${formatTop(akasha.topPercent)}%`];
    if (Number.isFinite(akasha.ranking) && Number.isFinite(akasha.outOf)) parts.push(`#${akasha.ranking.toLocaleString('en-US')} / ${akasha.outOf.toLocaleString('en-US')}`);
    if (akasha.category) parts.push(String(akasha.category));
    lines.push(`• **Akasha:** ${parts.join(' • ')}`);
  } else {
    lines.push(`• **Akasha:** ${A ? 'لا يوجد ترتيب متاح حاليًا' : 'No ranking available right now'}`);
  }
  lines.push(`• **Neverless:** ${evaluation.score}% (${ratingWord(evaluation.score, lang)})`);

  return lines.join('\n');
}

module.exports = { buildText, artifactsText, weaponsText, statsText, teamText, comboText, baseText, opinionText, replacementText, accountEvaluationText, normalizeTeams, closestReplacement, groupedTeamText, slotTeamLine };
