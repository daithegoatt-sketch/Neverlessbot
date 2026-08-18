'use strict';

const { reviewArtifacts } = require('./artifactEvaluator');
const { formatStat, formatTarget } = require('./statProfile');

function pieceGrade(row, lang = 'ar') {
  const ar = lang === 'ar';
  if (!row.mainMatch) return ar ? 'Main Stat غير مناسب' : 'Wrong main stat';
  if (row.level < 20) return ar ? 'غير مكتمل' : 'Not finished';
  if (row.usefulRv >= 650) return ar ? 'ممتاز جدًا' : 'Excellent';
  if (row.usefulRv >= 550) return ar ? 'ممتاز' : 'Very good';
  if (row.usefulRv >= 450) return ar ? 'جيد' : 'Good';
  if (row.usefulRv >= 330) return ar ? 'متوسط' : 'Average';
  return ar ? 'أولوية للتبديل' : 'Replace first';
}

function statLabel(key) {
  const labels = {
    critRate: 'CRIT Rate', critDmg: 'CRIT DMG', er: 'ER', em: 'EM',
    atkPercent: 'ATK%', flatAtk: 'ATK', hpPercent: 'HP%', flatHp: 'HP', defPercent: 'DEF%', flatDef: 'DEF',
  };
  return labels[key] || key;
}

function formatArtifactReview(snapshot, guide, lang = 'ar') {
  const ar = lang === 'ar';
  const report = reviewArtifacts(snapshot, guide);
  const lines = [`**${snapshot.name} — ${ar ? 'تقييم الآرتيفاكتات' : 'Artifact Review'}**`];

  for (const row of report.pieces) {
    const useful = row.usefulKeys.slice(0, 4).map(statLabel).join(' / ');
    lines.push(`\n**${row.slotLabel} +${row.level} — ${pieceGrade(row, lang)}**`);
    lines.push(ar
      ? `• RV الكلي: **${row.totalRv}%** | RV المفيد للشخصية: **${row.usefulRv}%**`
      : `• Total RV: **${row.totalRv}%** | Useful RV: **${row.usefulRv}%**`);
    if (useful) lines.push(ar ? `• الرولات المفيدة: ${useful}` : `• Useful rolls: ${useful}`);
    if (!row.mainMatch && row.mainOptions.length) {
      lines.push(ar
        ? `• ⚠ الـMain Stat الحالي **${row.mainStat}${row.mainValue ? ` ${row.mainValue}` : ''}**؛ الأفضل **${row.mainOptions.join(' / ')}**.`
        : `• ⚠ Current main stat: **${row.mainStat}${row.mainValue ? ` ${row.mainValue}` : ''}**; recommended: **${row.mainOptions.join(' / ')}**.`);
    }
  }

  const priorities = report.prioritized.filter((row) => !row.mainMatch || row.level < 20 || row.usefulRv < 550).slice(0, 3);
  lines.push(`\n**${ar ? 'وش تطور أول؟' : 'What to improve first'}**`);
  if (!priorities.length) {
    lines.push(ar
      ? 'قطعك الأساسية قوية. من هنا التحسين يكون Min-Max: ابدأ بأقل قطعة Useful RV وحاول ترفع الرولات المفيدة بدون تخريب الـMain Stats.'
      : 'Your core pieces are strong. From here, min-max the lowest Useful RV piece without sacrificing correct main stats.');
  } else {
    priorities.forEach((row, index) => {
      let reason;
      if (!row.mainMatch) {
        reason = ar
          ? `غيّر الـMain Stat إلى **${row.mainOptions.join(' / ')}**.`
          : `change the main stat to **${row.mainOptions.join(' / ')}**.`;
      } else if (row.level < 20) {
        reason = ar ? 'ارفعها إلى **+20** قبل الحكم النهائي عليها.' : 'level it to **+20** before judging it.';
      } else {
        const useful = row.usefulKeys.slice(0, 3).map(statLabel).join(' / ');
        reason = ar
          ? `هي من أضعف قطعك حاليًا بـUseful RV **${row.usefulRv}%**؛ دور على نفس الـMain Stat مع رولات أكثر في ${useful || 'الستات المهمة'}.`
          : `it is one of your weakest pieces at **${row.usefulRv}% Useful RV**; keep the main stat and look for stronger relevant rolls.`;
      }
      lines.push(`${index + 1}. **${row.slotLabel}:** ${reason}`);
    });
  }

  lines.push(ar
    ? '\n*RV هنا مجموع جودة الرولات: الرول بأعلى قيمة = 100% تقريبًا، لذلك طبيعي مجموع القطعة يتجاوز 100%. Useful RV يحسب فقط الرولات المفيدة لهذه الشخصية.*'
    : '\n*RV is the sum of roll quality: a max-value roll is about 100%, so a piece can exceed 100% total. Useful RV only counts stats relevant to this character.*');
  return lines.join('\n');
}

function weakestPieceText(report, lang = 'ar') {
  const rows = report.prioritized.filter((row) => row.level >= 20 && row.mainMatch).slice(0, 2);
  if (!rows.length) return null;
  return rows.map((row) => `${row.slotLabel} (${row.usefulRv}% Useful RV)`).join(lang === 'ar' ? ' ثم ' : ', then ');
}

function targetAdviceLine(snapshot, row, lang = 'ar') {
  const ar = lang === 'ar';
  const current = formatStat(row.key, row.value);
  const target = formatTarget(row.target);

  if (String(snapshot?.name || '').toLowerCase() === 'sandrone' && row.key === 'er') {
    return ar
      ? `• **ER:** ${current} → ${target} إذا تبي الـBurst كل روتيشن؛ 100% ممكن يكون كافي إذا تستخدم الـBurst كل روتيشنين.`
      : `• **ER:** ${current} → ${target} if you want Burst every rotation; 100% can be enough when Bursting every other rotation.`;
  }

  return ar
    ? `• **${row.label}:** ${current} → الهدف ${target}`
    : `• **${row.label}:** ${current} → target ${target}`;
}

function akashaImprovementAdvice(snapshot, guide, evaluation, akashaRanking, lang = 'ar') {
  const topPercent = Number(akashaRanking?.topPercent ?? akashaRanking);
  if (!Number.isFinite(topPercent)) return null;
  const ar = lang === 'ar';
  const report = reviewArtifacts(snapshot, guide);
  const targetProblems = (evaluation?.relevantStats || []).filter((row) => row.status === 'down');
  const mainProblems = report.pieces.filter((row) => !row.mainMatch);
  const weakest = weakestPieceText(report, lang);
  const category = akashaRanking?.category ? String(akashaRanking.category) : null;

  const lines = [`**${ar ? 'خطة رفع ترتيب Akasha' : 'Akasha improvement plan'}**`];
  lines.push(ar
    ? `• ترتيبك الحالي: **Top ${topPercent}%**${category ? ` — ${category}` : ''}`
    : `• Current rank: **Top ${topPercent}%**${category ? ` — ${category}` : ''}`);

  if (targetProblems.length || mainProblems.length) {
    lines.push(ar ? '• **الأولوية الآن:** أصلح النواقص الواضحة قبل الـMin-Max.' : '• **Priority now:** fix clear gaps before min-maxing.');
    targetProblems.slice(0, 3).forEach((row) => lines.push(targetAdviceLine(snapshot, row, lang)));
    mainProblems.slice(0, 2).forEach((row) => lines.push(ar
      ? `• **${row.slotLabel}:** غيّر الـMain Stat إلى ${row.mainOptions.join(' / ')}.`
      : `• **${row.slotLabel}:** change main stat to ${row.mainOptions.join(' / ')}.`));
    if (weakest) lines.push(ar
      ? `• بعد ما تضبط هذي النقاط، ابدأ بالـMin-Max من **${weakest}**.`
      : `• After those are fixed, start min-maxing **${weakest}**.`);
  } else if (topPercent > 1) {
    lines.push(ar ? '• أهداف البيلد الأساسية محققة؛ لا تحتاج تغيّر الستات الرئيسية.' : '• Core build targets are met; you do not need to change the main stat plan.');
    lines.push(ar
      ? `• الخطوة التالية: ${weakest ? `ابدأ بـ **${weakest}**` : 'ارفع جودة أضعف قطعتين'} وحاول تزيد CRIT/الستات المفيدة بدون ما تنزل تحت التارقت الحالي.`
      : `• Next: ${weakest ? `start with **${weakest}**` : 'improve the two weakest pieces'} while keeping your current target thresholds.`);
  } else {
    lines.push(ar
      ? `• أنت أصلًا داخل Top ${topPercent}%. أي تقدم إضافي غالبًا يحتاج تبديل أضعف قطعة بقطعة أعلى Useful RV مع الحفاظ على نفس التوازن.`
      : `• You are already Top ${topPercent}%. Further gains usually require replacing the weakest piece with higher Useful RV while preserving the same balance.`);
  }

  return lines.join('\n');
}

module.exports = { formatArtifactReview, akashaImprovementAdvice };
