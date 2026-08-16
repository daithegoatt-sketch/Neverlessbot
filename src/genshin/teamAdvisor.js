'use strict';

const { getGuide } = require('./guideClient');
const { resolveCharacterMentions } = require('./characterResolver');

function key(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function sameName(a, b) {
  return key(a) === key(b);
}

function optionLabel(group, name) {
  const constellation = Number(group?.requirements?.[key(name)]?.constellation);
  return Number.isInteger(constellation) ? `${name} C${constellation}` : name;
}

function slotLine(group, slots) {
  return slots.map((slot) => slot.map((name) => optionLabel(group, name)).join(' / ')).join(' | ');
}

function premiumGroups(guide) {
  return (guide?.teamGroups || []).filter((group) => group?.kind !== 'f2p' && Array.isArray(group.slotTeams));
}

function slotContains(slot, name) {
  return (slot || []).some((item) => sameName(item, name));
}

function assignNamesToSlots(slots, names, index = 0, used = new Set(), assignment = new Map()) {
  if (index >= names.length) return assignment;
  const name = names[index];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    if (used.has(slotIndex) || !slotContains(slots[slotIndex], name)) continue;
    used.add(slotIndex);
    assignment.set(slotIndex, name);
    const result = assignNamesToSlots(slots, names, index + 1, used, assignment);
    if (result) return result;
    assignment.delete(slotIndex);
    used.delete(slotIndex);
  }
  return null;
}

async function findMainCharacter(names) {
  let best = null;
  for (let order = 0; order < names.length; order += 1) {
    const name = names[order];
    const guide = await getGuide(name).catch(() => null);
    if (!guide) continue;
    let score = 0;
    for (const group of premiumGroups(guide)) {
      for (const slots of group.slotTeams || []) {
        if (!slotContains(slots[0], name)) continue;
        const matched = names.filter((candidate) => slots.some((slot) => slotContains(slot, candidate))).length;
        score = Math.max(score, matched * 10 + (slots[0].some((item) => sameName(item, name)) ? 5 : 0));
      }
    }
    if (!best || score > best.score || (score === best.score && order < best.order)) best = { name, guide, score, order };
  }
  return best;
}

function groupLabel(group) {
  const category = String(group?.category || '').replace(/\s+/g, ' ').trim();
  const role = String(group?.role || '').replace(/\s+/g, ' ').trim();
  if (category && role && !category.toLowerCase().includes(role.toLowerCase())) return `${category} — ${role}`;
  return category || role || 'Team';
}

async function missingAlternativeAdvice(text, lang = 'ar') {
  const names = await resolveCharacterMentions(text, 6);
  if (names.length < 2) return null;
  const mainResult = await findMainCharacter(names);
  if (!mainResult?.guide || mainResult.score < 15) return null;
  const main = mainResult.name;
  const missing = names.find((name) => !sameName(name, main));
  if (!missing) return null;

  const matches = [];
  for (const group of premiumGroups(mainResult.guide)) {
    for (const slots of group.slotTeams || []) {
      if (!slotContains(slots[0], main)) continue;
      const slotIndex = slots.findIndex((slot) => slotContains(slot, missing));
      if (slotIndex < 0) continue;
      const alternatives = slots[slotIndex].filter((name) => !sameName(name, missing));
      if (!alternatives.length) continue;
      matches.push({ group, slots, alternatives, slotIndex });
    }
  }
  if (!matches.length) return null;

  const chosen = matches[0];
  const alternatives = chosen.alternatives.map((name) => optionLabel(chosen.group, name));
  const A = lang === 'ar';
  const lines = [
    A
      ? `إذا ما عندك **${missing}** في تيم **${main}**، نفس الخانة في Game8 تسمح بـ **${alternatives.join(' / ')}**.`
      : `If you do not have **${missing}** for **${main}**, the same Game8 slot allows **${alternatives.join(' / ')}**.`,
    `**${groupLabel(chosen.group)}**`,
    slotLine(chosen.group, chosen.slots),
  ];
  return lines.join('\n');
}

function concreteTeamsForSlots(group, slots, mustInclude, limit = 4) {
  const assignment = assignNamesToSlots(slots, mustInclude);
  if (!assignment) return [];
  let teams = [[]];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    const fixed = assignment.get(slotIndex);
    const choices = fixed ? [fixed] : slots[slotIndex];
    const next = [];
    for (const team of teams) {
      for (const choice of choices) {
        next.push([...team, choice]);
        if (next.length >= limit) break;
      }
      if (next.length >= limit) break;
    }
    teams = next;
  }
  return teams;
}

async function ownedPairAdvice(text, lang = 'ar') {
  const names = await resolveCharacterMentions(text, 6);
  if (names.length < 2) return null;
  const mainResult = await findMainCharacter(names);
  if (!mainResult?.guide || mainResult.score < 15) return null;
  const main = mainResult.name;
  const candidates = [];

  for (const group of premiumGroups(mainResult.guide)) {
    for (const slots of group.slotTeams || []) {
      const assignment = assignNamesToSlots(slots, names);
      if (!assignment) continue;
      const teams = concreteTeamsForSlots(group, slots, names, 4);
      for (const team of teams) {
        const missing = team.filter((name) => !names.some((owned) => sameName(owned, name)));
        candidates.push({ group, team, missing });
      }
    }
  }

  const seen = new Set();
  const unique = candidates.filter((candidate) => {
    const id = candidate.team.map(key).join('|');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, 4);
  if (!unique.length) return null;

  const A = lang === 'ar';
  const lines = [A ? `**${names.join(' + ')} — شنو تكمل عليهم؟**` : `**${names.join(' + ')} — team completions**`];
  unique.forEach((candidate, index) => {
    lines.push(`\n**${index + 1}. ${groupLabel(candidate.group)}**`);
    lines.push(candidate.team.map((name) => optionLabel(candidate.group, name)).join(' | '));
    if (candidate.missing.length) lines.push(`${A ? 'تكمل بـ' : 'Add'}: **${candidate.missing.map((name) => optionLabel(candidate.group, name)).join(' + ')}**`);
  });
  return lines.join('\n');
}

function isMissingAdviceRequest(text) {
  return /ما\s*عندي|ما\s*املك|ما\s*أملك|بدون|i\s+don'?t\s+have|without/iu.test(String(text || ''))
    && /تيم|فريق|team|comp/iu.test(String(text || ''));
}

function isOwnedAdviceRequest(text) {
  const value = String(text || '');
  return /(?:^|\s)(?:عندي|املك|أملك|i\s+have)(?:\s|$)/iu.test(value)
    && /شنو|وش|ايش|إيش|ماذا|ماهي|ما\s+هي|اختار|أختار|اكمل|أكمل|تيم|فريق|what|who|choose|complete|team/iu.test(value);
}

module.exports = {
  missingAlternativeAdvice,
  ownedPairAdvice,
  isMissingAdviceRequest,
  isOwnedAdviceRequest,
  findMainCharacter,
  assignNamesToSlots,
};
