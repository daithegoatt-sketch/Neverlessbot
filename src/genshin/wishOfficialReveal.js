'use strict';

const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { getCharacter, getWeapon } = require('./dataClient');

// Visuals are sourced from the public WishSimulator.App repository revision below.
// The reveal follows the same in-game assets/keyframes used by the site instead of
// drawing a Neverless-made background/result scene.
const WISH_SIM_REV = 'd7d1870df7f2b168e37affdfadb43ba9da75857a';
const WISH_SIM_BASE = `https://cdn.jsdelivr.net/gh/Mantan21/Genshin-Impact-Wish-Simulator@${WISH_SIM_REV}`;
const SPLASH_BG = `${WISH_SIM_BASE}/src/images/background/splash-background.webp`;
const RESULT_BG = `${WISH_SIM_BASE}/src/images/utility/resultcard-bg.webp`;
const CHAR_DATA = `${WISH_SIM_BASE}/src/lib/data/characters.json`;
const WEAPON_DATA = `${WISH_SIM_BASE}/src/lib/data/weapons.json`;

const imageCache = new Map();
const jsonCache = new Map();
const fallbackMetaCache = new Map();
const revealCache = new Map();
const MAX_GIF_BYTES = 9 * 1024 * 1024;

function rarityStyle(rarity) {
  if (rarity >= 5) return { rgb: [251, 193, 60], embed: 0xf4c65a, edge: '#f9aa02' };
  if (rarity === 4) return { rgb: [156, 71, 218], embed: 0x9e68e8, edge: '#c44dda' };
  return { rgb: [99, 124, 205], embed: 0x6aa9ff, edge: '#aac8f1' };
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[’']/g, '_s')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fetchJson(url) {
  if (!jsonCache.has(url)) {
    jsonCache.set(url, (async () => {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Neverless-Wish/2.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`WISH_SIM_JSON_${response.status}`);
      return response.json();
    })());
  }
  return jsonCache.get(url);
}

async function fetchImage(url) {
  if (!url) return null;
  if (!imageCache.has(url)) {
    imageCache.set(url, (async () => {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Neverless-Wish/2.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return null;
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length < 512) return null;
      return loadImage(buf).catch(() => null);
    })().catch(() => null));
  }
  return imageCache.get(url);
}

async function fallbackMeta(item) {
  const key = `${item.type}:${item.name}`;
  if (!fallbackMetaCache.has(key)) {
    fallbackMetaCache.set(key, (item.type === 'character' ? getCharacter(item.name) : getWeapon(item.name)).catch(() => null));
  }
  return fallbackMetaCache.get(key);
}

function cleanDescription(data) {
  return String(data?.description || data?.descriptionRaw || data?.story || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 650);
}

async function wishSimMeta(item) {
  const slug = slugify(item.name);
  try {
    const doc = await fetchJson(item.type === 'character' ? CHAR_DATA : WEAPON_DATA);
    const rows = Array.isArray(doc) ? doc : (doc?.data || []);
    const row = rows.find((entry) => String(entry?.name || '').toLowerCase() === slug) || null;
    if (row) return { ...row, slug };
  } catch (error) {
    console.warn(`[wish] WishSimulator catalog unavailable: ${error.message}`);
  }
  return { slug };
}

function characterSplashUrl(meta, rarity) {
  return `${WISH_SIM_BASE}/src/images/characters/splash-art/${rarity}star/${meta.slug}.webp`;
}

function characterWishCardUrl(meta, rarity) {
  return `${WISH_SIM_BASE}/src/images/characters/wishcard/${rarity}star/${meta.slug}.webp`;
}

function weaponUrl(meta, rarity) {
  if (!meta.weaponType) return null;
  return `${WISH_SIM_BASE}/src/images/weapons/${meta.weaponType}/${rarity}star/${meta.slug}.webp`;
}

async function resolveVisual(item, forSummary = false) {
  const meta = await wishSimMeta(item);
  let image = null;

  if (item.type === 'character') {
    if (forSummary) image = await fetchImage(characterWishCardUrl(meta, item.rarity));
    if (!image) image = await fetchImage(characterSplashUrl(meta, item.rarity));
  } else {
    image = await fetchImage(weaponUrl(meta, item.rarity));
  }

  if (!image) {
    const fallback = await fallbackMeta(item);
    const images = fallback?.images || {};
    const url = item.type === 'character'
      ? (images.card || images.portrait || images.icon || images['hoyolab-avatar'])
      : (images.image || images.icon || images.awakenicon);
    image = await fetchImage(url);
  }

  return { meta, image };
}

function drawCover(ctx, image, x, y, w, h) {
  if (!image) {
    ctx.fillStyle = '#171c28';
    ctx.fillRect(x, y, w, h);
    return;
  }
  const scale = Math.max(w / image.width, h / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawContain(ctx, image, x, y, w, h, mult = 1) {
  if (!image) return;
  const scale = Math.min(w / image.width, h / image.height) * mult;
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function easeOutCubic(t) {
  const p = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - p, 3);
}

function drawSplashLight(ctx, w, h, rarity, t) {
  const [r, g, b] = rarityStyle(rarity).rgb;
  const cx = w * 0.50;
  const cy = h * 0.50;
  const progress = Math.min(1, t / 0.62);
  const alpha = Math.max(0, Math.sin(progress * Math.PI));
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * (0.25 + progress * 0.58));
  glow.addColorStop(0, `rgba(255,255,255,${0.72 * alpha})`);
  glow.addColorStop(0.20, `rgba(${r},${g},${b},${0.56 * alpha})`);
  glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 4; i += 1) {
    const p = easeOutCubic((t - i * 0.035) / (0.48 + i * 0.04));
    if (p <= 0) continue;
    ctx.globalAlpha = (1 - p) * 0.38;
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = 4.5 - i * 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 28 + p * (160 + i * 72), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPositionedCharacter(ctx, image, offset, w, h, animScale, brightness, shiftX) {
  const baseScale = Number(offset?.scale || 1.5);
  const tx = Number(offset?.x || 0) / 100 * w;
  const ty = Number(offset?.y || 0) / 100 * h;
  const layer = createCanvas(w, h);
  const lctx = layer.getContext('2d');
  lctx.save();
  lctx.translate(w / 2 + tx + shiftX, h / 2 + ty);
  lctx.scale(baseScale * animScale, baseScale * animScale);
  lctx.translate(-w / 2, -h / 2);
  drawContain(lctx, image, 0, 0, w, h, 1);
  lctx.restore();
  if (brightness < 0.995) {
    lctx.globalCompositeOperation = 'source-in';
    const v = Math.round(255 * Math.max(0, brightness));
    lctx.fillStyle = `rgb(${v},${v},${v})`;
    lctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(layer, 0, 0);
}

async function drawPositionedWeapon(ctx, image, meta, w, h, animScale, brightness, shiftX, t) {
  const weaponType = meta.weaponType || 'sword';
  const bg = await fetchImage(`${WISH_SIM_BASE}/src/images/utility/bg-${weaponType}.webp`);
  const layer = createCanvas(w, h);
  const lctx = layer.getContext('2d');

  if (bg && t >= 0.80) {
    const a = Math.max(0, Math.min(1, (t - 0.80) / 0.07));
    lctx.save();
    lctx.globalAlpha = a;
    const bgH = weaponType === 'catalyst' ? h * 0.88 : h * 0.80;
    drawContain(lctx, bg, 0, (h - bgH) / 2, w, bgH, weaponType === 'bow' ? 1.08 : 1);
    lctx.restore();
  }

  let typeScale = 1;
  if (weaponType === 'bow') typeScale = 1.12;
  if (weaponType === 'catalyst') typeScale = 0.58;
  if (weaponType === 'polearm') typeScale = 1.18;
  const box = { x: w * 0.18 + shiftX, y: h * 0.06, w: w * 0.64, h: h * 0.88 };
  lctx.save();
  lctx.translate(box.x + box.w / 2, box.y + box.h / 2);
  lctx.scale(animScale, animScale);
  lctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
  if (brightness >= 0.995) {
    lctx.shadowColor = 'rgba(0,0,0,0.70)';
    lctx.shadowBlur = 12;
    lctx.shadowOffsetX = 8;
    lctx.shadowOffsetY = 8;
  }
  drawContain(lctx, image, box.x, box.y, box.w, box.h, typeScale);
  lctx.restore();

  if (brightness < 0.995) {
    lctx.globalCompositeOperation = 'source-in';
    const v = Math.round(255 * Math.max(0, brightness));
    lctx.fillStyle = `rgb(${v},${v},${v})`;
    lctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(layer, 0, 0);
}

async function renderRevealFrame(item, visual, background, frame, frames) {
  const w = 960;
  const h = 540;
  const t = frame / Math.max(1, frames - 1);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  drawCover(ctx, background, 0, 0, w, h);
  drawSplashLight(ctx, w, h, item.rarity, t);

  let animScale = 1;
  let brightness = 0;
  let shiftX = 0;
  if (t <= 0.20) {
    animScale = 5 - 4 * easeOutCubic(t / 0.20);
  } else if (t > 0.75 && t <= 0.95) {
    const p = (t - 0.75) / 0.20;
    brightness = p;
    shiftX = 0.02 * w * p;
  } else if (t > 0.95) {
    brightness = 1;
    shiftX = 0.02 * w;
  }

  if (visual.image) {
    if (item.type === 'character') {
      drawPositionedCharacter(ctx, visual.image, visual.meta?.offset?.splashArt, w, h, animScale, brightness, shiftX);
    } else {
      await drawPositionedWeapon(ctx, visual.image, visual.meta || {}, w, h, animScale, brightness, shiftX, t);
    }
  }

  // ItemInfo on WishSimulator appears after the silhouette resolves.
  const infoAlpha = Math.max(0, Math.min(1, (t - 0.74) / 0.18));
  if (infoAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = infoAlpha;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 8;
    ctx.font = '700 38px sans-serif';
    const label = String(item.name || 'Unknown');
    ctx.fillText(label.length > 30 ? `${label.slice(0, 29)}…` : label, 52, 418);
    ctx.fillStyle = '#f7cf33';
    ctx.font = '700 31px sans-serif';
    ctx.fillText('★'.repeat(item.rarity), 52, 462);
    ctx.restore();
  }

  return canvas.toBuffer('image/png');
}

async function encodeReveal(item, visual, background) {
  if (!ffmpegPath) throw new Error('FFMPEG_NOT_AVAILABLE');
  const fps = 12;
  const activeFrames = 24;
  const holdFrames = 5;
  const totalFrames = activeFrames + holdFrames;
  const filter = '[0:v]split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[v]';
  const child = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', filter, '-map', '[v]',
    // -1 writes no infinite-loop extension: reveal plays once, then stays on its final frame in Discord.
    '-loop', '-1', '-f', 'gif', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const out = [];
  const err = [];
  let size = 0;
  let tooLarge = false;
  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_GIF_BYTES) {
      tooLarge = true;
      child.kill('SIGKILL');
    } else out.push(chunk);
  });
  child.stderr.on('data', (chunk) => err.push(chunk));

  let finalPng = null;
  for (let i = 0; i < totalFrames; i += 1) {
    const sourceFrame = Math.min(i, activeFrames - 1);
    const png = sourceFrame === activeFrames - 1 && finalPng
      ? finalPng
      : await renderRevealFrame(item, visual, background, sourceFrame, activeFrames);
    if (sourceFrame === activeFrames - 1) finalPng = png;
    if (!child.stdin.write(png)) await once(child.stdin, 'drain');
  }
  child.stdin.end();
  const [code] = await once(child, 'close');
  if (tooLarge) throw new Error('WISH_REVEAL_GIF_TOO_LARGE');
  if (code !== 0) throw new Error(`WISH_REVEAL_FFMPEG_${code}:${Buffer.concat(err).toString('utf8').slice(0, 400)}`);
  const gif = Buffer.concat(out);
  if (!gif.length) throw new Error('WISH_REVEAL_GIF_EMPTY');
  return gif;
}

async function renderOfficialRevealGif(item) {
  const key = `${item.type}:${item.name}:${item.rarity}`;
  if (!revealCache.has(key)) {
    revealCache.set(key, (async () => {
      const [visual, background] = await Promise.all([
        resolveVisual(item, false),
        fetchImage(SPLASH_BG),
      ]);
      if (!visual.image) throw new Error(`WISH_REVEAL_IMAGE_MISSING:${item.name}`);
      return encodeReveal(item, visual, background);
    })());
  }
  try {
    return await revealCache.get(key);
  } catch (error) {
    revealCache.delete(key);
    throw error;
  }
}

async function getOfficialRevealInfo(item) {
  const fallback = await fallbackMeta(item);
  return {
    description: cleanDescription(fallback),
    embedColor: rarityStyle(item.rarity).embed,
  };
}

function sortLikeWishSimulator(results) {
  const byType = (a, b) => String(a.type).localeCompare(String(b.type));
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const promoted = (star) => results
    .filter((item) => item.rarity === star)
    .slice()
    .sort(byName)
    .sort((a, b) => Number((b.ownedCount || 0) === 1) - Number((a.ownedCount || 0) === 1))
    .sort(byType);
  return [...promoted(5), ...promoted(4), ...results.filter((item) => item.rarity === 3)];
}

function traceResultCard(ctx, x, y, w, h) {
  // Shape follows WishSimulator's tall result-card silhouette: crown/shoulders on top,
  // straight body, and a pointed lower cap. It is clipped over the exact resultcard-bg asset.
  ctx.beginPath();
  ctx.moveTo(x + w * 0.50, y);
  ctx.bezierCurveTo(x + w * 0.43, y + h * 0.018, x + w * 0.35, y + h * 0.045, x + w * 0.28, y + h * 0.065);
  ctx.bezierCurveTo(x + w * 0.20, y + h * 0.085, x + w * 0.16, y + h * 0.11, x + w * 0.16, y + h * 0.15);
  ctx.lineTo(x + w * 0.16, y + h * 0.84);
  ctx.bezierCurveTo(x + w * 0.16, y + h * 0.89, x + w * 0.24, y + h * 0.92, x + w * 0.34, y + h * 0.95);
  ctx.lineTo(x + w * 0.50, y + h);
  ctx.lineTo(x + w * 0.66, y + h * 0.95);
  ctx.bezierCurveTo(x + w * 0.76, y + h * 0.92, x + w * 0.84, y + h * 0.89, x + w * 0.84, y + h * 0.84);
  ctx.lineTo(x + w * 0.84, y + h * 0.15);
  ctx.bezierCurveTo(x + w * 0.84, y + h * 0.11, x + w * 0.80, y + h * 0.085, x + w * 0.72, y + h * 0.065);
  ctx.bezierCurveTo(x + w * 0.65, y + h * 0.045, x + w * 0.57, y + h * 0.018, x + w * 0.50, y);
  ctx.closePath();
}

async function renderOfficialSummary(results) {
  const w = 1600;
  const h = 700;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const [background, resultBg] = await Promise.all([fetchImage(SPLASH_BG), fetchImage(RESULT_BG)]);
  drawCover(ctx, background, 0, 0, w, h);
  ctx.fillStyle = 'rgba(8,12,22,0.18)';
  ctx.fillRect(0, 0, w, h);

  const sorted = sortLikeWishSimulator(results);
  const prepared = await Promise.all(sorted.map(async (item) => ({
    item,
    visual: await resolveVisual(item, true),
  })));

  const cardW = 145;
  const cardH = 560;
  const gap = 8;
  const totalW = prepared.length * cardW + (prepared.length - 1) * gap;
  const startX = (w - totalW) / 2;
  const y = 66;

  for (let i = 0; i < prepared.length; i += 1) {
    const { item, visual } = prepared[i];
    const x = startX + i * (cardW + gap);
    const style = rarityStyle(item.rarity);

    ctx.save();
    ctx.shadowColor = item.rarity >= 5
      ? 'rgba(249,170,2,0.95)'
      : item.rarity === 4 ? 'rgba(196,77,218,0.95)' : 'rgba(101,187,246,0.70)';
    ctx.shadowBlur = item.rarity >= 4 ? 24 : 9;
    ctx.fillStyle = style.edge;
    traceResultCard(ctx, x, y, cardW, cardH);
    ctx.fill();
    ctx.restore();

    ctx.save();
    traceResultCard(ctx, x + 3, y + 3, cardW - 6, cardH - 6);
    ctx.clip();
    drawCover(ctx, resultBg, x, y, cardW, cardH);
    const shade = ctx.createLinearGradient(0, y, 0, y + cardH);
    shade.addColorStop(0, 'rgba(255,255,255,0.10)');
    shade.addColorStop(0.60, 'rgba(15,23,37,0.08)');
    shade.addColorStop(1, 'rgba(5,8,15,0.60)');
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, cardW, cardH);

    if (visual.image) {
      if (item.type === 'character') {
        const off = visual.meta?.offset?.wishCard || {};
        const mult = Number(off.scale || 5) / 5;
        const tx = Number(off.x || 0) / 100 * cardW;
        const ty = Number(off.y || 0) / 100 * cardH;
        drawContain(ctx, visual.image, x - 20 + tx, y + 25 + ty, cardW + 40, cardH - 90, 1.6 * mult);
      } else {
        drawContain(ctx, visual.image, x + 12, y + 38, cardW - 24, cardH - 125, 1.05);
      }
    }
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f7cf33';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.font = '700 17px sans-serif';
    ctx.fillText('★'.repeat(item.rarity), x + cardW / 2, y + cardH - 34);
    ctx.restore();
  }

  return canvas.toBuffer('image/png');
}

module.exports = {
  WISH_SIM_REV,
  getOfficialRevealInfo,
  renderOfficialRevealGif,
  renderOfficialSummary,
  rarityStyle,
};
