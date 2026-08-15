'use strict';

function isArabic(lang) {
  return lang === 'ar';
}

function cleanRecommendation(value) {
  return String(value || '').split(/\s+[—–]\s+/)[0].trim();
}

function expandTeamString(value) {
  const cleaned = String(value || '')
    .replace(/^Limited roster:\s*/i, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
  const slots = cleaned.split(/\s+[—–]\s+/).map((slot) => slot.trim()).filter(Boolean);
  let teams = [[]];
  for (const slot of slots) {
    const options = slot.split(/\s*\/\s*/).map((x) => x.replace(/^C\d+\s+/i, '').trim()).filter(Boolean);
    teams = teams.flatMap((team) => options.slice(0, 5).map((option) => [...team, option])).slice(0, 20);
  }
  return teams.filter((team) => team.length === 4);
}

function normalizeTeams(teams) {
  const result = [];
  for (const team of teams || []) {
    const expanded = Array.isArray(team) ? [team] : expandTeamString(team);
    for (const members of expanded) {
      const clean = members.map((x) => String(x).trim()).filter(Boolean);
      if (clean.length !== 4) continue;
      const key = clean.join('|').toLowerCase();
      if (!result.some((x) => x.join('|').toLowerCase() === key)) result.push(clean);
    }
  }
  return result;
}

function rankTeams(teams, owned = [], excluded = []) {
  const ownedSet = new Set(owned.map((x) => x.toLowerCase()));
  const excludedSet = new Set(excluded.map((x) => x.toLowerCase()));
  return teams
    .filter((team) => !team.some((member) => excludedSet.has(member.toLowerCase())))
    .map((team, index) => ({
      team,
      index,
      ownedCount: team.filter((member) => ownedSet.has(member.toLowerCase())).length,
      missing: team.filter((member) => ownedSet.size && !ownedSet.has(member.toLowerCase())),
    }))
    .sort((a, b) => (b.ownedCount - a.ownedCount) || (a.missing.length - b.missing.length) || (a.index - b.index));
}

function formatTeams(guide, lang, owned = [], excluded = []) {
  const ar = isArabic(lang);
  const ranked = rankTeams(normalizeTeams(guide.teams), owned, excluded);
  if (!ranked.length) {
    return ar
      ? `ما لقيت تيم منشور لـ **${guide.name}** يطابق الشخصيات أو القيود اللي ذكرتها.`
      : `I couldn't find a published **${guide.name}** team matching the characters or restrictions you gave.`;
  }

  const lines = [`**${guide.name} — ${ar ? 'التيمات' : 'Teams'}**`];
  ranked.slice(0, 4).forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.team.join(' • ')}`);
    if (owned.length && entry.missing.length) {
      lines.push(`   ${ar ? 'ينقصك' : 'Missing'}: ${entry.missing.join(', ')}`);
    }
  });
  return lines.join('\n');
}

function formatArtifacts(guide, lang) {
  const ar = isArabic(lang);
  const lines = [`**${guide.name} — ${ar ? 'الآرتيفاكت' : 'Artifacts'}**`];
  if (guide.artifacts?.length) guide.artifacts.slice(0, 4).forEach((item, i) => lines.push(`${i + 1}. ${cleanRecommendation(item)}`));
  else lines.push(ar ? 'ما عندي ترتيب آرتيفاكت موثوق حاليًا.' : 'I do not have a reliable artifact ranking right now.');

  if (guide.stats?.main?.length) {
    lines.push(`**${ar ? 'تقسيم القطع' : 'Main Stats'}:**`);
    guide.stats.main.forEach((item) => lines.push(`• ${item}`));
  }
  if (guide.stats?.priority) lines.push(`**${ar ? 'السب ستات' : 'Substats'}:** ${guide.stats.priority}`);
  return lines.join('\n');
}

function formatWeapons(guide, lang) {
  const ar = isArabic(lang);
  const lines = [`**${guide.name} — ${ar ? 'الأسلحة' : 'Weapons'}**`];
  if (guide.weapons?.length) guide.weapons.slice(0, 6).forEach((item, i) => lines.push(`${i + 1}. ${cleanRecommendation(item)}`));
  else lines.push(ar ? 'ما عندي ترتيب أسلحة موثوق حاليًا.' : 'I do not have a reliable weapon ranking right now.');
  return lines.join('\n');
}

function requestedTargetKeys(query) {
  const text = String(query || '');
  const keys = [];
  if (/crit\s*rate|cr\b|كريت\s*ريت|كريت ريت|نسبة الكريت/i.test(text)) keys.push('critRate');
  if (/crit\s*(?:dmg|damage)|cd\b|كريت\s*(?:دمج|دmg)|كريت دمج|ضرر الكريت/i.test(text)) keys.push('critDmg');
  if (/energy\s*recharge|\ber\b|شحن|طاقة|طاقه/i.test(text)) keys.push('er');
  if (/elemental\s*mastery|\bem\b|المنتال|ماستري/i.test(text)) keys.push('em');
  if (/\batk\b|attack|اتاك|هجوم/i.test(text)) keys.push('atk');
  if (/\bhp\b|الصحة|الصحه/i.test(text)) keys.push('hp');
  return [...new Set(keys)];
}

function targetKey(line) {
  const text = String(line || '');
  if (/CRIT Rate/i.test(text)) return 'critRate';
  if (/CRIT DMG/i.test(text)) return 'critDmg';
  if (/Energy Recharge|\bER\b/i.test(text)) return 'er';
  if (/Elemental Mastery|\bEM\b/i.test(text)) return 'em';
  if (/\bATK\b/i.test(text)) return 'atk';
  if (/\bHP\b/i.test(text)) return 'hp';
  return null;
}

function formatStats(guide, lang, query = '') {
  const ar = isArabic(lang);
  const requested = requestedTargetKeys(query);
  const allTargets = guide.stats?.targets || [];
  const targets = requested.length ? allTargets.filter((line) => requested.includes(targetKey(line))) : allTargets;
  const lines = [`**${guide.name} — ${ar ? 'الستات المطلوبة' : 'Recommended Stats'}**`];

  if (targets.length) targets.slice(0, 8).forEach((item) => lines.push(`• ${item}`));
  else if (requested.length) lines.push(ar ? 'ما عندي رقم موثوق لهذا الستات تحديدًا.' : 'I do not have a reliable target for that specific stat.');

  if (!requested.length) {
    if (guide.stats?.priority) lines.push(`**${ar ? 'الأولوية' : 'Priority'}:** ${guide.stats.priority}`);
    if (guide.stats?.main?.length) {
      lines.push(`**${ar ? 'Main Stats للقطع' : 'Artifact Main Stats'}:**`);
      guide.stats.main.forEach((item) => lines.push(`• ${item}`));
    }
  }
  return lines.join('\n');
}

function formatFullBuild(guide, lang) {
  const ar = isArabic(lang);
  const lines = [`**${guide.name} — ${ar ? 'البيلد' : 'Build'}**`];

  if (guide.artifacts?.length) {
    lines.push(`**${ar ? 'أفضل الآرتيفاكت' : 'Best Artifacts'}:**`);
    guide.artifacts.slice(0, 3).forEach((item, i) => lines.push(`${i + 1}. ${cleanRecommendation(item)}`));
  }
  if (guide.stats?.main?.length) {
    lines.push(`**${ar ? 'تقسيم القطع' : 'Main Stats'}:**`);
    guide.stats.main.forEach((item) => lines.push(`• ${item}`));
  }
  if (guide.stats?.priority) lines.push(`**${ar ? 'السب ستات' : 'Substats'}:** ${guide.stats.priority}`);
  if (guide.weapons?.length) {
    lines.push(`**${ar ? 'أفضل الأسلحة' : 'Best Weapons'}:**`);
    guide.weapons.slice(0, 5).forEach((item, i) => lines.push(`${i + 1}. ${cleanRecommendation(item)}`));
  }
  if (guide.stats?.targets?.length) {
    lines.push(`**${ar ? 'الأرقام اللي تستهدفها' : 'Stat Targets'}:**`);
    guide.stats.targets.slice(0, 8).forEach((item) => lines.push(`• ${item}`));
  }
  return lines.join('\n');
}

function formatGuideAnswer(guide, lang, intent, query = '') {
  if (intent === 'artifacts') return formatArtifacts(guide, lang);
  if (intent === 'weapons') return formatWeapons(guide, lang);
  if (intent === 'stats') return formatStats(guide, lang, query);
  return formatFullBuild(guide, lang);
}

function formatBaseData(character, stats, lang) {
  const ar = isArabic(lang);
  const name = character?.name || 'Character';
  const element = character?.elementText || character?.element || 'Unknown';
  const weapon = character?.weaponText || character?.weapontype || character?.weaponType || 'Unknown';
  const hp = stats?.hp || stats?.basehp;
  const atk = stats?.attack || stats?.atk || stats?.baseatk;
  const def = stats?.defense || stats?.def || stats?.basedef;
  return [
    `**${name} — ${ar ? 'البيانات الأساسية' : 'Base Stats'}**`,
    `${element} • ${weapon}`,
    hp != null ? `Base HP: ${Number(hp).toLocaleString('en-US', { maximumFractionDigits: 1 })}` : null,
    atk != null ? `Base ATK: ${Number(atk).toLocaleString('en-US', { maximumFractionDigits: 1 })}` : null,
    def != null ? `Base DEF: ${Number(def).toLocaleString('en-US', { maximumFractionDigits: 1 })}` : null,
  ].filter(Boolean).join('\n');
}

function parseTarget(target) {
  const text = String(target || '').replace(/,/g, '');
  const key = targetKey(text);
  if (!key) return null;
  const nums = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  if (!nums.length) return null;
  return { key, min: nums[0], max: nums[1] ?? nums[0], text: target };
}

function actualStatText(snapshot) {
  const s = snapshot.stats;
  return `HP ${s.hp ?? '?'} • ATK ${s.atk ?? '?'} • CR ${s.critRate ?? '?'}% • CD ${s.critDmg ?? '?'}% • ER ${s.er ?? '?'}% • EM ${s.em ?? '?'}`;
}

function compareTargets(snapshot, guide, lang) {
  const ar = isArabic(lang);
  const parsed = (guide.stats?.targets || []).map(parseTarget).filter(Boolean);
  const counts = parsed.reduce((acc, item) => ({ ...acc, [item.key]: (acc[item.key] || 0) + 1 }), {});
  const notes = [];
  const labels = { critRate: 'CRIT Rate', critDmg: 'CRIT DMG', er: 'ER', em: 'EM', atk: 'ATK', hp: 'HP' };

  for (const target of parsed) {
    // Context-dependent targets (e.g. several ER ranges for different teams) should not be judged blindly.
    if (counts[target.key] > 1) continue;
    const value = snapshot.stats[target.key];
    if (typeof value !== 'number') continue;
    const lowThreshold = target.min === target.max ? target.min * 0.93 : target.min;
    if (value < lowThreshold) {
      notes.push(ar
        ? `${labels[target.key]} عندك ${value}، وهو أقل من الرينج المنشور (${target.text.split(':').slice(1).join(':').trim()}).`
        : `${labels[target.key]} is ${value}, below the published range (${target.text.split(':').slice(1).join(':').trim()}).`);
    } else if ((target.key === 'critRate' || target.key === 'er') && target.max > target.min && value > target.max * 1.08) {
      notes.push(ar
        ? `${labels[target.key]} عندك ${value}، أعلى من الرينج المعتاد؛ ممكن بعض الرولات تتحول لستات أهم إذا بقية البيلد تسمح.`
        : `${labels[target.key]} is ${value}, above the usual range; some rolls may be movable into more useful stats if the rest of the build allows it.`);
    }
  }
  return notes.slice(0, 4);
}

function formatAccountAnalysis(snapshot, guide, lang) {
  const ar = isArabic(lang);
  const lines = [`**${snapshot.name} — ${ar ? 'تحليل بيلدك' : 'Your Build Analysis'}**`];
  lines.push(`${ar ? 'لفل' : 'Level'} ${snapshot.level} • C${snapshot.constellation}`);
  lines.push(`**${ar ? 'ستاتك' : 'Stats'}:** ${actualStatText(snapshot)}`);

  if (snapshot.weapon.name) {
    lines.push(`**${ar ? 'سلاحك' : 'Weapon'}:** ${snapshot.weapon.name}${snapshot.weapon.refinement ? ` R${snapshot.weapon.refinement}` : ''}`);
    if (guide.weapons?.length) lines.push(`${ar ? 'الخيارات المنشورة الأفضل' : 'Published better options'}: ${guide.weapons.slice(0, 3).map(cleanRecommendation).join(' / ')}`);
  }

  const sets = Object.entries(snapshot.setCounts).sort((a, b) => b[1] - a[1]);
  if (sets.length) lines.push(`**${ar ? 'قطعك الحالية' : 'Current Artifacts'}:** ${sets.map(([name, count]) => `${count}pc ${name}`).join(' + ')}`);
  if (guide.artifacts?.length) lines.push(`${ar ? 'المقترح' : 'Recommended'}: ${guide.artifacts.slice(0, 2).map(cleanRecommendation).join(' / ')}`);

  const slots = ['sands', 'goblet', 'circlet'];
  const actualMain = slots.map((slot) => snapshot.artifacts.find((item) => item.slot === slot)).filter(Boolean);
  if (actualMain.length) lines.push(`**Main Stats:** ${actualMain.map((item) => `${item.slot}: ${item.mainStat} ${item.mainValue}`).join(' • ')}`);
  if (guide.stats?.main?.length) lines.push(`${ar ? 'المطلوب غالبًا' : 'Usually aim for'}: ${guide.stats.main.join(' • ')}`);

  const notes = compareTargets(snapshot, guide, lang);
  if (notes.length) {
    lines.push(`**${ar ? 'أهم الملاحظات' : 'Main Notes'}:**`);
    notes.forEach((note) => lines.push(`• ${note}`));
  } else {
    lines.push(ar
      ? 'ما ظهر نقص واضح في الأرقام اللي أقدر أقارنها مباشرة. بعدها الحكم الأدق يعتمد على جودة الرولات، القطع، التيم والروتيشن.'
      : 'No obvious shortfall appeared in the stats I can compare directly. Further optimization depends on rolls, artifacts, team and rotation.');
  }
  return lines.join('\n');
}

function describeOpinion(guide, lang) {
  if (!isArabic(lang)) {
    const topTeam = normalizeTeams(guide.teams)[0];
    return `**${guide.name}**${guide.role ? ` — ${guide.role}` : ''}.${topTeam ? ` One of the strongest published shells I have is ${topTeam.join(' • ')}.` : ''}`;
  }

  const role = String(guide.role || '');
  let roleText = 'عندي لها بيلدات وتيمات منشورة وأقدر أفصلها لك حسب اللي تحتاجه.';
  if (/on-field.*cryo/i.test(role)) roleText = 'دورها الأساسي Main DPS Cryo داخل الملعب، وأفضل قيمتها تظهر مع التيمات اللي مبنية حول تفاعلها.';
  else if (/on-field/i.test(role) && /dps/i.test(role)) roleText = 'دورها الأساسي Main DPS داخل الملعب، فاختيار التيم والبيلد حولها يفرق كثير.';
  else if (/off-field/i.test(role) && /support/i.test(role)) roleText = 'دورها الأساسي Support خارج الملعب؛ قيمتها تجي من دعم التيم وتفعيل التفاعلات أكثر من بقائها داخل الملعب.';
  else if (/off-field/i.test(role) && /dps/i.test(role)) roleText = 'دورها الأساسي ضرر خارج الملعب مع دعم للتيم، لذلك غالبًا تدخل كقطعة تكمل الـDPS الرئيسي.';

  const topTeam = normalizeTeams(guide.teams)[0];
  return `**${guide.name}**: ${roleText}${topTeam ? `\nمن أقوى التيمات المنشورة عندي لها: ${topTeam.join(' • ')}.` : ''}`;
}

module.exports = {
  formatGuideAnswer,
  formatTeams,
  formatBaseData,
  formatAccountAnalysis,
  describeOpinion,
  normalizeTeams,
  rankTeams,
};
