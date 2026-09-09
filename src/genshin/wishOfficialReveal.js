'use strict';

const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createCanvas, loadImage, Path2D } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { getCharacter, getWeapon } = require('./dataClient');

// Pinned WishSimulator.App revision. The simulator uses recorded Genshin wish videos
// plus extracted game-style result assets. Neverless renders those same assets and
// ports the upstream reveal timings instead of drawing a separate visual theme.
const WISH_SIM_REV = 'd7d1870df7f2b168e37affdfadb43ba9da75857a';
const WISH_SIM_BASE = `https://cdn.jsdelivr.net/gh/Mantan21/Genshin-Impact-Wish-Simulator@${WISH_SIM_REV}`;
const SPLASH_BG = `${WISH_SIM_BASE}/src/images/background/splash-background.webp`;
const RESULT_BG = `${WISH_SIM_BASE}/src/images/utility/resultcard-bg.webp`;
const CHAR_DATA = `${WISH_SIM_BASE}/src/lib/data/characters.json`;
const WEAPON_DATA = `${WISH_SIM_BASE}/src/lib/data/weapons.json`;

const MAX_GIF_BYTES = 9 * 1024 * 1024;
const imageCache = new Map();
const textCache = new Map();
const jsonCache = new Map();
const fallbackMetaCache = new Map();
const revealCache = new Map();
const iconCache = new Map();

const ICON_COMPONENT = Object.freeze({
  anemo: 'Anemo',
  cryo: 'Cryo',
  dendro: 'Dendro',
  electro: 'Electro',
  geo: 'Geo',
  hydro: 'Hydro',
  pyro: 'Pyro',
  bow: 'Bow',
  catalyst: 'Catalyst',
  claymore: 'Claymore',
  polearm: 'Polearm',
  sword: 'Sword',
});

// Exact wishframe SVG path used by WishSimulator.App ResultList.svelte.
// Its original coordinates are normalized by 1510 x 6470 in the web app.
const RESULT_FRAME_D = [
  'M734 6419 c-25 -29 -100 -76 -199 -127 -125 -64 -165 -117 -165 -217',
  '0 -22 -3 -50 -6 -63 -9 -33 -83 -72 -155 -82 -68 -10 -79 -19 -79 -67 0 -24',
  '-7 -37 -32 -54 -18 -12 -43 -34 -55 -48 l-22 -26 -1 -2502 c0 -1542 4 -2503 9',
  '-2503 5 0 13 -9 16 -20 4 -11 23 -28 43 -38 32 -15 37 -22 40 -57 4 -49 23',
  '-65 76 -65 47 0 113 -28 140 -58 12 -14 21 -45 26 -90 13 -117 54 -164 215',
  '-250 55 -28 114 -66 132 -82 18 -17 35 -30 39 -30 4 0 23 15 44 34 21 19 80',
  '56 131 82 153 79 197 131 210 252 4 39 13 70 25 84 27 30 93 58 140 58 53 0',
  '72 16 76 65 3 35 8 42 40 57 20 10 39 27 43 38 3 11 11 20 16 20 5 0 9 961 9',
  '2503 l-1 2502 -22 26 c-12 14 -37 36 -54 48 -26 17 -33 30 -33 54 0 48 -11 57',
  '-79 67 -72 10 -146 49 -155 82 -3 13 -6 41 -6 63 0 100 -40 153 -165 217 -106',
  '54 -153 84 -191 119 l-30 29 -20 -21z',
].join(' ');
const RESULT_FRAME_PATH = typeof Path2D === 'function' ? new Path2D(RESULT_FRAME_D) : null;

function rarityStyle(rarity) {
  if (rarity >= 5) {
    return {
      rgb: [251, 193, 60],
      embed: 0xf4c65a,
      edge: '#f9aa02',
      light: '#fbc13c',
      shadow: 'rgba(249,170,2,0.95)',
    };
  }
  if (rarity === 4) {
    return {
      rgb: [156, 71, 218],
      embed: 0x9e68e8,
      edge: '#c44dda',
      light: '#b42ff8',
      shadow: 'rgba(196,77,218,0.95)',
    };
  }
  return {
    rgb: [99, 124, 205],
    embed: 0x6aa9ff,
    edge: '#aac8f1',
    light: '#637ccd',
    shadow: 'rgba(101,187,246,0.75)',
  };
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

async function fetchText(url) {
  if (!textCache.has(url)) {
    textCache.set(url, (async () => {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Neverless-Wish/3.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`WISH_SIM_TEXT_${response.status}`);
      return response.text();
    })());
  }
  try {
    return await textCache.get(url);
  } catch (error) {
    textCache.delete(url);
    throw error;
  }
}

async function fetchJson(url) {
  if (!jsonCache.has(url)) {
    jsonCache.set(url, fetchText(url).then((text) => JSON.parse(text)));
  }
  try {
    return await jsonCache.get(url);
  } catch (error) {
    jsonCache.delete(url);
    throw error;
  }
}

async function fetchImage(url) {
  if (!url) return null;
  if (!imageCache.has(url)) {
    imageCache.set(url, (async () => {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Neverless-Wish/3.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 256) return null;
      return loadImage(buffer).catch(() => null);
    })().catch(() => null));
  }
  return imageCache.get(url);
}

async function fetchUpstreamIcon(name) {
  const key = String(name || '').toLowerCase();
  if (!ICON_COMPONENT[key]) return null;
  if (!iconCache.has(key)) {
    iconCache.set(key, (async () => {
      const source = await fetchText(
        `${WISH_SIM_BASE}/src/lib/components/svgs/${ICON_COMPONENT[key]}.svelte`,
      );
      // Individual icon components are static SVG files despite the .svelte extension.
      return loadImage(Buffer.from(source, 'utf8')).catch(() => null);
    })().catch(() => null));
  }
  return iconCache.get(key);
}

async function fallbackMeta(item) {
  const key = `${item.type}:${item.name}`;
  if (!fallbackMetaCache.has(key)) {
    fallbackMetaCache.set(
      key,
      (item.type === 'character' ? getCharacter(item.name) : getWeapon(item.name))
        .catch(() => null),
    );
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
    const row = rows.find((entry) => String(entry?.name || '').toLowerCase() === slug);
    if (row) return { ...row, slug };
  } catch (error) {
    console.warn(`[wish] WishSimulator catalog unavailable: ${error.message}`);
  }
  return { slug };
}

function characterSplashUrl(meta, rarity) {
  return `${WISH_SIM_BASE}/src/images/characters/splash-art/${rarity}star/${meta.slug}.webp`;
}

function weaponUrl(meta, rarity) {
  if (!meta.weaponType) return null;
  return `${WISH_SIM_BASE}/src/images/weapons/${meta.weaponType}/${rarity}star/${meta.slug}.webp`;
}

async function resolveVisual(item) {
  const meta = await wishSimMeta(item);
  let image = item.type === 'character'
    ? await fetchImage(characterSplashUrl(meta, item.rarity))
    : await fetchImage(weaponUrl(meta, item.rarity));

  if (!image) {
    const fallback = await fallbackMeta(item);
    const images = fallback?.images || {};
    const url = item.type === 'character'
      ? (images.card || images.portrait || images.icon || images['hoyolab-avatar'])
      : (images.image || images.icon || images.awakenicon);
    image = await fetchImage(url);
  }

  const iconKey = item.type === 'character' ? meta.vision : meta.weaponType;
  const icon = await fetchUpstreamIcon(iconKey);
  return { meta, image, icon, iconKey };
}

function drawCover(ctx, image, x, y, w, h) {
  if (!image) {
    ctx.fillStyle = '#080b15';
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

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function easeOutCubic(value) {
  const p = clamp01(value);
  return 1 - Math.pow(1 - p, 3);
}

function upstreamOrbColor(rarity) {
  if (rarity >= 5) {
    return {
      core: [251, 193, 60],
      mid: [253, 148, 48],
      outer: [254, 133, 63],
    };
  }
  if (rarity === 4) {
    return {
      core: [180, 47, 248],
      mid: [113, 34, 221],
      outer: [156, 71, 218],
    };
  }
  return {
    core: [157, 217, 252],
    mid: [85, 93, 255],
    outer: [99, 124, 205],
  };
}

function drawGlowDisc(ctx, cx, cy, radius, rgb, alpha, whiteCore = false) {
  if (radius <= 0 || alpha <= 0) return;
  const [r, g, b] = rgb;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  if (whiteCore) grad.addColorStop(0, `rgba(255,255,255,${Math.min(0.9, alpha)})`);
  else grad.addColorStop(0, `rgba(${r},${g},${b},${Math.min(0.78, alpha)})`);
  grad.addColorStop(0.28, `rgba(${r},${g},${b},${alpha * 0.62})`);
  grad.addColorStop(0.70, `rgba(${r},${g},${b},${alpha * 0.20})`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
}

// Port of _splash-light.svelte. The upstream component uses four "in" orbs,
// a full-screen rarity glow, then three "out" orbs beginning at ~1.1s.
function drawSplashLight(ctx, w, h, rarity, seconds) {
  const colors = upstreamOrbColor(rarity);
  const cx = w / 2;
  const cy = h / 2;
  const base = Math.min(w, h);

  ctx.save();
  ctx.globalCompositeOperation = 'screen';

  const fullP = clamp01(seconds / 1.0);
  if (fullP < 1) {
    const scale = fullP < 0.90 ? fullP / 0.90 : 1;
    const alpha = fullP < 0.90 ? 0.55 * scale : 0.55 * (1 - fullP) / 0.10;
    drawGlowDisc(ctx, cx, cy + h * 0.18, base * 1.25 * scale, colors.outer, alpha);
  }

  const inOrbs = [
    { width: 1.00, duration: 1.00, rgb: colors.outer },
    { width: 0.80, duration: 1.20, rgb: colors.mid },
    { width: 0.40, duration: 1.10, rgb: colors.core, white: true },
    { width: 0.70, duration: 0.75, rgb: colors.mid },
  ];

  for (const orb of inOrbs) {
    const p = clamp01(seconds / orb.duration);
    if (p >= 1) continue;
    const scale = p < 0.90 ? p / 0.90 : 1;
    const alpha = p < 0.90 ? 0.56 * scale : 0.56 * (1 - p) / 0.10;
    drawGlowDisc(
      ctx,
      cx,
      cy,
      base * orb.width * 0.66 * scale,
      orb.rgb,
      alpha,
      Boolean(orb.white),
    );
  }

  const outOrbs = [
    { delay: 0.10, duration: 0.80, width: 0.50, rgb: colors.core },
    { delay: 0.00, duration: 2.00, width: 1.00, rgb: [255, 255, 255], white: true },
    { delay: 0.10, duration: 1.20, width: 1.50, rgb: colors.mid },
  ];

  const outTime = seconds - 1.10;
  if (outTime >= 0) {
    for (const orb of outOrbs) {
      const p = clamp01((outTime - orb.delay) / orb.duration);
      if (p <= 0 || p >= 1) continue;
      const scale = p * 2;
      const alpha = p < 0.30 ? (p / 0.30) * 0.52 : (1 - p) / 0.70 * 0.52;
      drawGlowDisc(
        ctx,
        cx,
        cy,
        base * orb.width * 0.42 * scale,
        orb.rgb,
        alpha,
        Boolean(orb.white),
      );
    }
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

async function drawPositionedWeapon(ctx, image, meta, w, h, animScale, brightness, shiftX, artT) {
  const weaponType = meta.weaponType || 'sword';
  const bg = await fetchImage(`${WISH_SIM_BASE}/src/images/utility/bg-${weaponType}.webp`);
  const layer = createCanvas(w, h);
  const lctx = layer.getContext('2d');

  // _splash-art.svelte weaponbg: hidden until 80%, visible by 85%.
  if (bg && artT >= 0.80) {
    const alpha = clamp01((artT - 0.80) / 0.05);
    lctx.save();
    lctx.globalAlpha = alpha;
    const bgH = weaponType === 'catalyst' ? h * 0.90 : h * 0.80;
    drawContain(lctx, bg, 0, (h - bgH) / 2, w, bgH, weaponType === 'bow' ? 1.10 : 1);
    lctx.restore();
  }

  let typeScale = 1;
  if (weaponType === 'bow') typeScale = 1.15;
  if (weaponType === 'catalyst') typeScale = 0.42;
  if (weaponType === 'polearm') typeScale = 1.20;

  const box = { x: w * 0.17 + shiftX, y: h * 0.04, w: w * 0.66, h: h * 0.92 };
  lctx.save();
  lctx.translate(box.x + box.w / 2, box.y + box.h / 2);
  lctx.scale(animScale, animScale);
  lctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
  if (brightness >= 0.995) {
    lctx.shadowColor = 'rgba(0,0,0,0.70)';
    lctx.shadowBlur = 10;
    lctx.shadowOffsetX = 7;
    lctx.shadowOffsetY = 7;
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

function drawUpstreamItemInfo(ctx, item, visual, w, h, seconds) {
  const nameProgress = easeOutCubic((seconds - 1.30) / 0.80);
  const iconProgress = clamp01((seconds - 1.20) / 1.30);
  const infoY = h * 0.60;
  const left = w * 0.055;

  if (visual.icon && iconProgress > 0) {
    ctx.save();
    ctx.globalAlpha = iconProgress;
    const size = h * 0.125;
    drawContain(ctx, visual.icon, left, infoY - size * 0.55, size, size, 1);
    ctx.restore();
  }

  if (nameProgress > 0) {
    ctx.save();
    ctx.globalAlpha = nameProgress;
    ctx.translate((1 - nameProgress) * 20, 0);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.82)';
    ctx.lineWidth = 2.2;
    ctx.font = `700 ${Math.round(h * 0.075)}px sans-serif`;
    const maxChars = item.name.length > 23 ? 22 : item.name.length;
    const label = item.name.length > maxChars ? `${item.name.slice(0, maxChars)}…` : item.name;
    const textX = left + h * 0.145;
    const textY = infoY + h * 0.01;
    ctx.strokeText(label, textX, textY);
    ctx.fillText(label, textX, textY);
    ctx.restore();
  }

  // Upstream stars start at 2s, one every 150ms, each scaling down over 400ms.
  const starSize = Math.round(h * 0.054);
  const starY = infoY + h * 0.09;
  const starX = left + h * 0.145;
  ctx.save();
  ctx.fillStyle = '#f7cf33';
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 5;
  ctx.font = `700 ${starSize}px sans-serif`;
  for (let i = 0; i < item.rarity; i += 1) {
    const p = easeOutCubic((seconds - (2.0 + i * 0.15)) / 0.40);
    if (p <= 0) continue;
    ctx.save();
    const x = starX + i * starSize * 1.05;
    ctx.translate(x, starY);
    const scale = 5 - 4 * p;
    ctx.scale(scale, scale);
    ctx.globalAlpha = p;
    ctx.fillText('★', 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

async function renderRevealFrame(item, visual, background, frame, fps) {
  const w = 800;
  const h = 450;
  const seconds = frame / fps;
  const artT = clamp01(seconds / 1.50);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  drawCover(ctx, background, 0, 0, w, h);
  drawSplashLight(ctx, w, h, item.rarity, seconds);

  // Exact _splash-art.svelte timing:
  // 0% scale 5 black -> 20% scale 1 black -> 75% black
  // -> 95% full color + 2% horizontal shift -> 100% hold.
  let animScale = 1;
  let brightness = 0;
  let shiftX = 0;
  if (artT <= 0.20) {
    animScale = 5 - 4 * (artT / 0.20);
  } else if (artT > 0.75 && artT <= 0.95) {
    const p = (artT - 0.75) / 0.20;
    brightness = p;
    shiftX = 0.02 * w * p;
  } else if (artT > 0.95) {
    brightness = 1;
    shiftX = 0.02 * w;
  }

  if (visual.image) {
    if (item.type === 'character') {
      drawPositionedCharacter(
        ctx,
        visual.image,
        visual.meta?.offset?.splashArt,
        w,
        h,
        animScale,
        brightness,
        shiftX,
      );
    } else {
      await drawPositionedWeapon(
        ctx,
        visual.image,
        visual.meta || {},
        w,
        h,
        animScale,
        brightness,
        shiftX,
        artT,
      );
    }
  }

  drawUpstreamItemInfo(ctx, item, visual, w, h, seconds);
  return canvas.toBuffer('image/png');
}

async function encodeReveal(item, visual, background) {
  if (!ffmpegPath) throw new Error('FFMPEG_NOT_AVAILABLE');

  const fps = 12;
  const activeSeconds = 2.85;
  const holdSeconds = 0.85;
  const activeFrames = Math.ceil(activeSeconds * fps);
  const holdFrames = Math.ceil(holdSeconds * fps);
  const totalFrames = activeFrames + holdFrames;

  const filter = [
    '[0:v]split[a][b]',
    '[a]palettegen=max_colors=112:stats_mode=diff[p]',
    '[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[v]',
  ].join(';');

  const child = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', filter, '-map', '[v]',
    // No Netscape infinite-loop extension. Discord plays the reveal once and holds.
    '-loop', '-1',
    '-f', 'gif', 'pipe:1',
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
    } else {
      out.push(chunk);
    }
  });
  child.stderr.on('data', (chunk) => err.push(chunk));

  let finalPng = null;
  for (let i = 0; i < totalFrames; i += 1) {
    const sourceFrame = Math.min(i, activeFrames - 1);
    const png = sourceFrame === activeFrames - 1 && finalPng
      ? finalPng
      : await renderRevealFrame(item, visual, background, sourceFrame, fps);
    if (sourceFrame === activeFrames - 1) finalPng = png;
    if (!child.stdin.write(png)) await once(child.stdin, 'drain');
  }

  child.stdin.end();
  const [code] = await once(child, 'close');
  if (tooLarge) throw new Error('WISH_REVEAL_GIF_TOO_LARGE');
  if (code !== 0) {
    throw new Error(
      `WISH_REVEAL_FFMPEG_${code}:${Buffer.concat(err).toString('utf8').slice(0, 400)}`,
    );
  }

  const gif = Buffer.concat(out);
  if (!gif.length) throw new Error('WISH_REVEAL_GIF_EMPTY');
  return gif;
}

async function renderOfficialRevealGif(item) {
  const key = `${item.type}:${item.name}:${item.rarity}`;
  if (!revealCache.has(key)) {
    revealCache.set(key, (async () => {
      const [visual, background] = await Promise.all([
        resolveVisual(item),
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

  return [
    ...promoted(5),
    ...promoted(4),
    ...results.filter((item) => item.rarity === 3),
  ];
}

function fallbackFramePath(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(8, w * 0.08));
}

function withWishFrameClip(ctx, x, y, w, h, draw) {
  ctx.save();
  if (RESULT_FRAME_PATH) {
    ctx.translate(x, y);
    ctx.scale(w / 1510, h / 6470);
    ctx.clip(RESULT_FRAME_PATH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    fallbackFramePath(ctx, x, y, w, h);
    ctx.clip();
  }
  draw();
  ctx.restore();
}

function fillWishFrame(ctx, x, y, w, h, fillStyle, shadow = null, shadowBlur = 0) {
  ctx.save();
  if (shadow) {
    ctx.shadowColor = shadow;
    ctx.shadowBlur = shadowBlur;
  }
  ctx.fillStyle = fillStyle;
  if (RESULT_FRAME_PATH) {
    ctx.translate(x, y);
    ctx.scale(w / 1510, h / 6470);
    ctx.fill(RESULT_FRAME_PATH);
  } else {
    fallbackFramePath(ctx, x, y, w, h);
    ctx.fill();
  }
  ctx.restore();
}

function drawResultArt(ctx, item, visual, x, y, w, h) {
  if (!visual.image) return;

  ctx.save();
  if (item.type === 'character') {
    // ResultListItem.svelte uses splash-art again, transformed by offset.wishCard.
    const offset = visual.meta?.offset?.wishCard || {};
    const scale = Number(offset.scale || 5);
    const tx = Number(offset.x || 0) / 100 * w;
    const ty = Number(offset.y || 0) / 100 * h;
    const cx = x + w / 2;
    const cy = y + h / 2;

    ctx.translate(cx + tx, cy + ty);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    drawContain(ctx, visual.image, x, y, w, h, 1);
  } else {
    drawContain(ctx, visual.image, x, y + h * 0.03, w, h * 0.78, 1);
  }
  ctx.restore();
}

async function drawResultInfo(ctx, item, visual, x, y, w, h) {
  const iconKey = item.type === 'character'
    ? visual.meta?.vision
    : visual.meta?.weaponType;
  const icon = visual.icon || await fetchUpstreamIcon(iconKey);

  if (icon) {
    const iconSize = w * 0.64;
    drawContain(
      ctx,
      icon,
      x + (w - iconSize) / 2,
      y + h * 0.69,
      iconSize,
      iconSize,
      1,
    );
  }

  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f7cf33';
  ctx.shadowColor = 'rgba(0,0,0,0.78)';
  ctx.shadowBlur = 4;
  ctx.font = `700 ${Math.max(14, Math.round(w * 0.115))}px sans-serif`;
  ctx.fillText('★'.repeat(item.rarity), x + w / 2, y + h * 0.91);
  ctx.restore();
}

async function renderOfficialSummary(results) {
  const w = 1600;
  const h = 780;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  const [background, resultBg] = await Promise.all([
    fetchImage(SPLASH_BG),
    fetchImage(RESULT_BG),
  ]);

  drawCover(ctx, background, 0, 0, w, h);
  ctx.fillStyle = 'rgba(8,12,22,0.08)';
  ctx.fillRect(0, 0, w, h);

  const sorted = sortLikeWishSimulator(results);
  const prepared = await Promise.all(
    sorted.map(async (item) => ({ item, visual: await resolveVisual(item) })),
  );

  // Upstream ResultList uses card aspect-ratio 7/30.
  const cardH = 615;
  const cardW = cardH * 7 / 30;
  const gap = 3;
  const totalW = prepared.length * cardW + Math.max(0, prepared.length - 1) * gap;
  const startX = (w - totalW) / 2;
  const y = 78;

  for (let i = 0; i < prepared.length; i += 1) {
    const { item, visual } = prepared[i];
    const x = startX + i * (cardW + gap);
    const style = rarityStyle(item.rarity);

    const rarityGradient = ctx.createLinearGradient(x, y, x, y + cardH);
    if (item.rarity >= 5) {
      rarityGradient.addColorStop(0, '#f9aa02');
      rarityGradient.addColorStop(0.50, '#ffffff');
      rarityGradient.addColorStop(1, '#f9aa02');
    } else if (item.rarity === 4) {
      rarityGradient.addColorStop(0, '#c44dda');
      rarityGradient.addColorStop(0.50, '#ffffff');
      rarityGradient.addColorStop(1, '#c44dda');
    } else {
      rarityGradient.addColorStop(0, '#aac8f1');
      rarityGradient.addColorStop(0.50, '#ffffff');
      rarityGradient.addColorStop(1, '#aac8f1');
    }

    fillWishFrame(
      ctx,
      x,
      y,
      cardW,
      cardH,
      rarityGradient,
      style.shadow,
      item.rarity >= 4 ? 24 : 8,
    );

    const insetX = 2.0;
    const insetY = 4.0;
    withWishFrameClip(
      ctx,
      x + insetX,
      y + insetY,
      cardW - insetX * 2,
      cardH - insetY * 2,
      () => {
        drawCover(
          ctx,
          resultBg,
          x + insetX,
          y + insetY,
          cardW - insetX * 2,
          cardH - insetY * 2,
        );

        drawResultArt(
          ctx,
          item,
          visual,
          x + insetX,
          y + insetY,
          cardW - insetX * 2,
          cardH - insetY * 2,
        );

        const shade = ctx.createLinearGradient(0, y + cardH * 0.53, 0, y + cardH);
        shade.addColorStop(0, 'rgba(0,0,0,0)');
        shade.addColorStop(1, 'rgba(0,0,0,0.42)');
        ctx.fillStyle = shade;
        ctx.fillRect(x, y + cardH * 0.50, cardW, cardH * 0.50);
      },
    );

    await drawResultInfo(ctx, item, visual, x, y, cardW, cardH);
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
