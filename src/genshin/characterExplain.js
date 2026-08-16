'use strict';

const { getCharacter } = require('./dataClient');
const { getGuide, normalizeTeams } = require('./guideClient');
const { getCharacterTheoryNotes } = require('./kqmClient');

function clean(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(value, max = 240) {
  const text = clean(value);
  if (!text) return null;
  const match = text.match(/^.*?[.!?](?:\s|$)/);
  return (match?.[0] || text).slice(0, max).trim();
}

function skillRows(character) {
  const pools = [character?.skillTalents, character?.talents, character?.skills];
  const list = pools.find(Array.isArray) || [];
  return list.slice(0, 4).map((skill) => ({
    name: clean(skill?.name || skill?.title || skill?.unlock || 'Skill'),
    type: clean(skill?.type || skill?.unlock || ''),
    description: clean(skill?.description || skill?.desc || ''),
  })).filter((row) => row.name && row.description);
}

function effectTags(description, ar) {
  const text = String(description || '').toLowerCase();
  const tags = [];
  const push = (condition, arabic, english) => { if (condition && !tags.includes(ar ? arabic : english)) tags.push(ar ? arabic : english); };
  push(/deal|damage|dmg/.test(text), 'ضرر', 'damage');
  push(/heal|restore.*hp/.test(text), 'علاج', 'healing');
  push(/shield/.test(text), 'درع', 'shield');
  push(/increase|bonus|buff|enhance/.test(text), 'تقوية / Buff', 'buff');
  push(/decrease|resistance|res shred|reduce.*res/.test(text), 'تقليل مقاومة / Debuff', 'RES shred / debuff');
  push(/summon|off-field|field|coordinated/.test(text), 'تأثير مستمر / خارج الملعب', 'persistent / off-field effect');
  push(/energy|recharge|particle/.test(text), 'طاقة', 'Energy');
  push(/elemental mastery|reaction/.test(text), 'تفاعلات / EM', 'reactions / EM');
  return tags.slice(0, 4);
}

function arabicSkillSummary(row) {
  const tags = effectTags(row.description, true);
  const type = row.type ? ` (${row.type})` : '';
  if (tags.length) return `**${row.name}**${type}: تركيزها الأساسي ${tags.join(' + ')}.`;
  return `**${row.name}**${type}: ${firstSentence(row.description, 180)}`;
}

function englishSkillSummary(row) {
  const type = row.type ? ` (${row.type})` : '';
  return `**${row.name}**${type}: ${firstSentence(row.description, 220)}`;
}

function constellationHighlight(notes, character, ar) {
  const theory = clean(notes?.constellations || '');
  if (theory) {
    const candidates = [];
    for (const match of theory.matchAll(/(?:^|\s)(C[1-6])\b[^.!?]{0,240}[.!?]?/gi)) {
      const text = clean(match[0]);
      if (text.length >= 20) candidates.push(text);
    }
    if (candidates.length) {
      const priority = ['C2', 'C1', 'C6', 'C3', 'C4', 'C5'];
      candidates.sort((a, b) => {
        const ai = priority.findIndex((c) => a.toUpperCase().includes(c));
        const bi = priority.findIndex((c) => b.toUpperCase().includes(c));
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });
      return ar
        ? `أبرز قفزة مذكورة في دليل KQM: ${candidates[0].slice(0, 320)}`
        : `Notable KQM constellation note: ${candidates[0].slice(0, 320)}`;
    }
  }

  const constellations = Array.isArray(character?.constellations) ? character.constellations : [];
  if (constellations.length) {
    const c2 = constellations[1] || constellations[0];
    return ar
      ? `للكونستليشنز تأثيرات متعددة؛ راقب خصوصًا **C${Math.min(2, constellations.length)} ${clean(c2?.name)}**، لكن ما عندي ترتيب Theorycrafting موثوق كفاية لأقول إنها الأقوى مطلقًا.`
      : `Constellations have several effects; **C${Math.min(2, constellations.length)} ${clean(c2?.name)}** is worth checking, but I do not have enough theorycrafting evidence to call it the universal best.`;
  }
  return null;
}

async function explainCharacter(name, lang = 'ar') {
  const ar = lang === 'ar';
  const [character, guide, theory] = await Promise.all([
    getCharacter(name).catch(() => null),
    getGuide(name).catch(() => null),
    getCharacterTheoryNotes(name).catch(() => null),
  ]);
  if (!character && !guide) return null;

  const lines = [`**${name} — ${ar ? 'شرح الشخصية' : 'Character Guide'}**`];
  if (guide?.role) lines.push(`**${ar ? 'الدور' : 'Role'}:** ${guide.role}`);
  const description = firstSentence(character?.description, 260);
  if (description) lines.push(ar ? `**الفكرة العامة:** ${description}` : `**Overview:** ${description}`);

  const skills = skillRows(character);
  if (skills.length) {
    lines.push(`\n**${ar ? 'المهارات باختصار' : 'Skills at a glance'}:**`);
    skills.forEach((row) => lines.push(ar ? arabicSkillSummary(row) : englishSkillSummary(row)));
  }

  const premium = normalizeTeams(guide?.teams).premium;
  if (premium.length) {
    lines.push(`\n**${ar ? 'وين تطلع قوتها' : 'Where the character shines'}:**`);
    premium.slice(0, 3).forEach((team, index) => lines.push(`${index + 1}. ${team.join(' • ')}`));
  }

  const strongest = constellationHighlight(theory, character, ar);
  if (strongest) lines.push(`\n**${ar ? 'الكونستليشن' : 'Constellations'}:** ${strongest}`);

  if (guide?.stats?.priority) lines.push(`\n**${ar ? 'أهم ستات للبيلد' : 'Build priority'}:** ${guide.stats.priority}`);
  return lines.join('\n');
}

module.exports = { explainCharacter, effectTags, skillRows };
