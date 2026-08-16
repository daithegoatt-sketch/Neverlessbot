'use strict';

const ENTRIES = [
  { name: 'Alyosha', aliases: ['alyosha', 'aylosha', 'alyosha', 'اليوشا', 'أليوشا', 'اليوشا'] },
  { name: 'Skirk', aliases: ['skirk', 'سكيرك', 'سكرك'] },
  { name: 'Escoffier', aliases: ['escoffier', 'escofier', 'اسكوفيه', 'اسكوفيير', 'اسكوفر', 'إسكوفييه'] },
  { name: 'Wriothesley', aliases: ['wriothesley', 'wriothesly', 'riothesley', 'ريزلي', 'رايزلي', 'ريوثسلي'] },
  { name: 'Neuvillette', aliases: ['neuvillette', 'neuvilette', 'نوفيلت', 'نوفليت', 'نيوفيلت'] },
  { name: 'Furina', aliases: ['furina', 'فورينا'] },
  { name: 'Flins', aliases: ['flins', 'فلينس'] },
  { name: 'Durin', aliases: ['durin', 'دورين'] },
  { name: 'Sandrone', aliases: ['sandrone', 'ساندروني', 'ساندرون'] },
  { name: 'Yae Miko', aliases: ['yae miko', 'yaemiko', 'ياي ميكو', 'ياي مiko', 'ميكو'] },
  { name: 'Mavuika', aliases: ['mavuika', 'مافويكا', 'مافويكه'] },
  { name: 'Citlali', aliases: ['citlali', 'سيتلالي', 'سيتلاني'] },
  { name: 'Xilonen', aliases: ['xilonen', 'شيلونين', 'زيلونين'] },
  { name: 'Columbina', aliases: ['columbina', 'كولومبينا', 'كولومبينا'] },
  { name: 'Ineffa', aliases: ['ineffa', 'اينيفا', 'إينيفا', 'اينفا'] },
  { name: 'Zibai', aliases: ['zibai', 'zi bai', 'زيباي', 'زي باي'] },
  { name: 'Nicole', aliases: ['nicole', 'نيكول'] },
  { name: 'Varka', aliases: ['varka', 'فاركا'] },
  { name: 'Odette', aliases: ['odette', 'اوديت', 'أوديت'] },
  { name: 'Shenhe', aliases: ['shenhe', 'شينهي', 'شينه'] },
];

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function containsAlias(text, alias) {
  const haystack = ` ${normalize(text)} `;
  const needle = ` ${normalize(alias)} `;
  return needle.trim().length > 1 && haystack.includes(needle);
}

function matchedCharacters(text) {
  const matched = [];
  for (const entry of ENTRIES) {
    if (entry.aliases.some((alias) => containsAlias(text, alias))) matched.push(entry.name);
  }
  return matched;
}

function rewriteCharacterAliases(text) {
  const input = String(text || '').trim();
  if (!input) return input;
  const normalized = normalize(input);
  const append = matchedCharacters(input).filter((name) => !normalized.includes(normalize(name)));
  return append.length ? `${input} ${append.join(' ')}` : input;
}

const KNOWN_CHARACTER_NAMES = [...new Set(ENTRIES.map((entry) => entry.name))];

module.exports = { ENTRIES, KNOWN_CHARACTER_NAMES, rewriteCharacterAliases, matchedCharacters, normalize };
