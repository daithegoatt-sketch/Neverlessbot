'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { getCharacter, getTalent } = require('./dataClient');

const LEVEL_1_TO_90_MORA = 1_672_000;
const LEVEL_1_TO_90_HERO_WIT = 419;

function addCosts(map, costs, multiplier, source) {
  for (const rows of Object.values(costs || {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const name = String(row?.name || '').trim();
      const count = Number(row?.count);
      if (!name || !Number.isFinite(count) || count <= 0) continue;
      const key = name.toLowerCase();
      const current = map.get(key) || { id: row?.id ?? null, name, count: 0, ascension: false, talent: false };
      current.count += count * multiplier;
      current[source] = true;
      if (current.id == null && row?.id != null) current.id = row.id;
      map.set(key, current);
    }
  }
}

function materialGroup(item) {
  if (item.name === 'Mora' || item.name === "Hero's Wit") return 'level';
  if (/Sliver|Fragment|Chunk|Gemstone$/i.test(item.name)) return 'gems';
  if (/^(Teachings of|Guide to|Philosophies of)/i.test(item.name)) return 'books';
  if (/Crown of Insight/i.test(item.name)) return 'weekly';
  const id = Number(item.id);
  if (Number.isFinite(id) && id >= 112000 && id < 113000) return 'enemy';
  if (item.talent && !item.ascension) return 'weekly';
  return 'ascension';
}

function groupMaterials(items) {
  const groups = { level: [], ascension: [], gems: [], enemy: [], books: [], weekly: [] };
  for (const item of items) (groups[materialGroup(item)] || groups.ascension).push(item);
  return groups;
}

async function getCharacterMaterials(name) {
  const [character, talent] = await Promise.all([getCharacter(name), getTalent(name)]);
  if (!character?.costs) throw new Error('CHARACTER_MATERIALS_NOT_FOUND');
  const totals = new Map();
  addCosts(totals, character.costs, 1, 'ascension');
  if (talent?.costs) addCosts(totals, talent.costs, 3, 'talent');

  const moraKey = 'mora';
  const mora = totals.get(moraKey) || { id: 202, name: 'Mora', count: 0, ascension: true, talent: true };
  mora.count += LEVEL_1_TO_90_MORA;
  totals.set(moraKey, mora);
  totals.set("hero's wit", { id: 104003, name: "Hero's Wit", count: LEVEL_1_TO_90_HERO_WIT, ascension: true, talent: false });

  const items = [...totals.values()].map((row) => ({ ...row, count: Math.round(row.count) }));
  return {
    name: character.name || name,
    rarity: character.rarity || null,
    items,
    groups: groupMaterials(items),
    scope: 'Lv. 1→90 + Talents 10/10/10',
  };
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function materialIconUrl(name) {
  return `https://genshin.jmp.blue/materials/${slug(name)}/icon`;
}

async function fetchImage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'NeverlessBot/27.0' } });
  if (!response.ok) throw new Error(`ICON_HTTP_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return loadImage(bytes);
}

function shortName(name) {
  const value = String(name || '');
  return value.length <= 24 ? value : `${value.slice(0, 22)}…`;
}

async function buildMaterialsCard(result) {
  const items = (result?.items || []).slice(0, 20);
  if (!items.length) return null;
  const columns = 4;
  const cellW = 245;
  const cellH = 126;
  const rows = Math.ceil(items.length / columns);
  const width = columns * cellW;
  const height = 66 + rows * cellH;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111722';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#f4f5f7';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(`${result.name} — Materials`, 22, 37);
  ctx.fillStyle = '#aeb8c8';
  ctx.font = '15px sans-serif';
  ctx.fillText(result.scope, 22, 59);

  let loaded = 0;
  await Promise.all(items.map(async (item, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = col * cellW;
    const y = 66 + row * cellH;
    ctx.fillStyle = index % 2 ? '#161e2b' : '#141b27';
    ctx.fillRect(x + 4, y + 4, cellW - 8, cellH - 8);
    try {
      const image = await fetchImage(materialIconUrl(item.name));
      ctx.drawImage(image, x + 14, y + 20, 72, 72);
      loaded += 1;
    } catch {}
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText(shortName(item.name), x + 94, y + 48);
    ctx.fillStyle = '#d5dde8';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(`× ${Number(item.count).toLocaleString('en-US')}`, x + 94, y + 80);
  }));

  if (!loaded) return null;
  return canvas.toBuffer('image/png');
}

module.exports = {
  getCharacterMaterials,
  groupMaterials,
  materialIconUrl,
  buildMaterialsCard,
  addCosts,
  LEVEL_1_TO_90_MORA,
  LEVEL_1_TO_90_HERO_WIT,
};
