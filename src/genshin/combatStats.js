'use strict';

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
}

function hasFourPiece(snapshot, setName) {
  const wanted = normalize(setName);
  return Object.entries(snapshot?.setCounts || {}).some(([name, count]) => normalize(name) === wanted && Number(count) >= 4);
}

function guideRecommendsSet(guide, setName) {
  const wanted = normalize(setName);
  return (guide?.artifacts || []).some((name) => {
    const current = normalize(String(name || '').replace(/^\s*[24]\s*(?:pc|piece)\s*/i, ''));
    return current === wanted || current.includes(wanted) || wanted.includes(current);
  });
}

function guideRecommendsWeapon(guide, weaponName) {
  const wanted = normalize(weaponName);
  if (!wanted) return false;
  return [...(guide?.weapons || []), ...(guide?.f2pWeapons || [])].some((name) => {
    const current = normalize(name);
    return current && (current === wanted || current.includes(wanted) || wanted.includes(current));
  });
}

// These characters reliably trigger Marechaussee Hunter through their own normal
// field pattern, so the 4pc CRIT Rate should count even if a guide page failed to
// expose its artifact table to the parser.
const SELF_HP_MARECHAUSSEE_USERS = new Set([
  'neuvillette',
  'wriothesley',
  'lyney',
  'gaming',
]);

// Common on-field Nightsoul users whose normal builds can keep Obsidian Codex active.
// Unknown/edge cases still require the guide to explicitly recommend the set.
const SELF_OBSIDIAN_USERS = new Set([
  'mavuika',
  'mualani',
  'kinich',
  'chasca',
  'varesa',
]);

function addBonus(target, sources, key, amount, source, confidence = 1) {
  const value = Number(amount) * Number(confidence);
  if (!Number.isFinite(value) || value <= 0) return;
  target[key] = (target[key] || 0) + value;
  sources.push({ key, amount: value, source, confidence });
}

function artifactCombatBonuses(snapshot, guide) {
  const bonuses = {};
  const sources = [];
  const character = normalize(snapshot?.name);

  if (
    SELF_HP_MARECHAUSSEE_USERS.has(character)
    && hasFourPiece(snapshot, 'Marechaussee Hunter')
  ) {
    addBonus(bonuses, sources, 'critRate', 36, 'Marechaussee Hunter 4pc');
  }

  if (
    hasFourPiece(snapshot, 'Obsidian Codex')
    && (SELF_OBSIDIAN_USERS.has(character) || guideRecommendsSet(guide, 'Obsidian Codex'))
  ) {
    addBonus(bonuses, sources, 'critRate', 40, 'Obsidian Codex 4pc');
  }

  // Blizzard Strayer can grant up to 40% CRIT Rate, but the second 20% requires
  // Frozen specifically. Without a team/enemy-state snapshot Neverless only counts
  // the conservative Cryo-affected portion when the set is actually recommended.
  if (
    hasFourPiece(snapshot, 'Blizzard Strayer')
    && guideRecommendsSet(guide, 'Blizzard Strayer')
  ) {
    addBonus(bonuses, sources, 'critRate', 20, 'Blizzard Strayer 4pc (conservative active portion)');
  }

  return { bonuses, sources };
}

function refinementDescription(weaponData, refinement) {
  const rank = Math.max(1, Math.min(5, Number(refinement) || 1));
  return String(weaponData?.[`r${rank}`]?.description || '').trim();
}

function sentenceAround(text, index) {
  const value = String(text || '');
  const start = Math.max(0, value.lastIndexOf('.', Math.max(0, index - 1)) + 1);
  const endRaw = value.indexOf('.', index);
  const end = endRaw < 0 ? value.length : endRaw + 1;
  return value.slice(start, end);
}

function maxStacksNear(sentence) {
  const match = String(sentence || '').match(/max(?:imum)?\s+(\d+)\s+stacks?/i);
  const count = Number(match?.[1]);
  return Number.isFinite(count) && count > 1 && count <= 10 ? count : 1;
}

function conditionalConfidence(sentence, recommended) {
  const conditional = /\b(?:when|after|if|while|upon|whenever|stack|trigger|for\s+\d+(?:\.\d+)?s)\b/i.test(sentence);
  if (!conditional) return 1;
  return recommended ? 0.75 : 0.5;
}

function extractPassiveBonus(description, labelPattern, percent = true, recommended = false) {
  const text = String(description || '');
  const escaped = labelPattern;
  const patterns = [
    new RegExp(`${escaped}[^.]{0,90}?(?:is|will be|are)?\\s*(?:increased|increases|increase)\\s*(?:by)?\\s*([0-9]+(?:\\.[0-9]+)?)${percent ? '%' : ''}`, 'i'),
    new RegExp(`(?:increases|increase|increased)[^.]{0,90}?${escaped}[^.]{0,40}?by\\s*([0-9]+(?:\\.[0-9]+)?)${percent ? '%' : ''}`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const base = Number(match[1]);
    if (!Number.isFinite(base) || base <= 0) continue;
    const sentence = sentenceAround(text, match.index);
    const stackMultiplier = /(?:each|per)\s+stack/i.test(sentence) ? maxStacksNear(sentence) : 1;
    return base * stackMultiplier * conditionalConfidence(sentence, recommended);
  }
  return 0;
}

function weaponPassiveBonuses(snapshot, guide, weaponData) {
  const bonuses = {};
  const sources = [];
  const weaponName = snapshot?.weapon?.name;
  if (!weaponName || !weaponData) return { bonuses, sources };

  const description = refinementDescription(weaponData, snapshot?.weapon?.refinement);
  if (!description) return { bonuses, sources };
  const recommended = guideRecommendsWeapon(guide, weaponName);

  const direct = [
    ['critRate', 'CRIT\\s*Rate', true],
    ['critDmg', 'CRIT\\s*(?:DMG|Damage)', true],
    ['er', 'Energy\\s*Recharge', true],
    ['em', 'Elemental\\s*Mastery', false],
  ];
  for (const [key, label, percent] of direct) {
    const amount = extractPassiveBonus(description, label, percent, recommended);
    if (amount > 0) addBonus(bonuses, sources, key, amount, `${weaponName} passive`, 1);
  }

  return { bonuses, sources };
}

function effectiveStatsForRating(snapshot, guide, options = {}) {
  const raw = { ...(snapshot?.stats || {}) };
  const artifact = artifactCombatBonuses(snapshot, guide);
  const weapon = weaponPassiveBonuses(snapshot, guide, options.weaponData || null);
  const bonuses = { ...artifact.bonuses };
  for (const [key, value] of Object.entries(weapon.bonuses)) bonuses[key] = (bonuses[key] || 0) + value;

  const effective = { ...raw };
  for (const [key, bonus] of Object.entries(bonuses)) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && Number.isFinite(bonus)) effective[key] = value + bonus;
  }

  return {
    raw,
    effective,
    bonuses,
    sources: [...artifact.sources, ...weapon.sources],
  };
}

module.exports = {
  artifactCombatBonuses,
  weaponPassiveBonuses,
  effectiveStatsForRating,
  hasFourPiece,
  guideRecommendsSet,
  guideRecommendsWeapon,
  extractPassiveBonus,
};
