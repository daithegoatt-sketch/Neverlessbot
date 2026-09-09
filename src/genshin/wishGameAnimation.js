'use strict';

const { once } = require('node:events');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');

// Game-recorded wish sequences used by the public WishSimulator project.
// Pin the upstream revision so our animation cannot silently change underneath us.
const SOURCE_BASE = 'https://cdn.jsdelivr.net/gh/Mantan21/Genshin-Impact-Wish-Simulator@d7d1870df7f2b168e37affdfadb43ba9da75857a/static/videos';
const MAX_GIF_BYTES = 9 * 1024 * 1024;
const sourceCache = new Map();
const gifCache = new Map();

const PROFILES = [
  { width: 640, fps: 12, colors: 128 },
  { width: 560, fps: 10, colors: 96 },
  { width: 480, fps: 8, colors: 80 },
  { width: 420, fps: 7, colors: 64 },
];

function animationFilename(rarity, count, capturingRadiance = false) {
  if (capturingRadiance) return 'capturing-radiance.mp4';
  if (rarity >= 5) return count === 10 ? '5star-multi.mp4' : '5star-single.mp4';
  if (rarity === 4) return count === 10 ? '4star-multi.mp4' : '4star-single.mp4';
  return '3star-single.mp4';
}

function animationColor(rarity, capturingRadiance = false) {
  if (capturingRadiance) return 0xff8df7;
  if (rarity >= 5) return 0xf4c65a;
  if (rarity === 4) return 0x9e68e8;
  return 0x6aa9ff;
}

function animationWaitMs(capturingRadiance = false) {
  return capturingRadiance ? 8500 : 7000;
}

async function fetchSource(filename) {
  if (sourceCache.has(filename)) return sourceCache.get(filename);
  const promise = (async () => {
    const url = `${SOURCE_BASE}/${filename}`;
    const response = await fetch(url, {
      headers: { 'user-agent': 'Neverless-Wish/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`WISH_ANIMATION_HTTP_${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('WISH_ANIMATION_EMPTY');
    return buffer;
  })();
  sourceCache.set(filename, promise);
  try {
    return await promise;
  } catch (error) {
    sourceCache.delete(filename);
    throw error;
  }
}

async function transcodeGif(source, profile) {
  if (!ffmpegPath) throw new Error('FFMPEG_NOT_AVAILABLE');

  const filter = [
    `[0:v]fps=${profile.fps},scale=${profile.width}:-2:flags=lanczos,split[a][b]`,
    `[a]palettegen=max_colors=${profile.colors}:stats_mode=diff[p]`,
    '[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[v]',
  ].join(';');

  const child = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-an',
    '-filter_complex', filter,
    '-map', '[v]',
    '-loop', '0',
    '-f', 'gif',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const chunks = [];
  const errors = [];
  let size = 0;
  let tooLarge = false;

  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_GIF_BYTES) {
      tooLarge = true;
      child.kill('SIGKILL');
      return;
    }
    chunks.push(chunk);
  });
  child.stderr.on('data', (chunk) => errors.push(chunk));

  child.stdin.on('error', () => {});
  child.stdin.end(source);

  const [code, signal] = await once(child, 'close');
  if (tooLarge) throw new Error('WISH_GIF_TOO_LARGE');
  if (code !== 0) {
    const detail = Buffer.concat(errors).toString('utf8').slice(0, 400);
    throw new Error(`WISH_GIF_FFMPEG_${code ?? signal}: ${detail}`);
  }

  const gif = Buffer.concat(chunks);
  if (!gif.length) throw new Error('WISH_GIF_EMPTY');
  return gif;
}

async function renderGameWishGif(rarity, count, capturingRadiance = false) {
  const filename = animationFilename(rarity, count, capturingRadiance);
  const cacheKey = filename;
  if (gifCache.has(cacheKey)) return gifCache.get(cacheKey);

  const promise = (async () => {
    const source = await fetchSource(filename);
    let lastError = null;
    for (const profile of PROFILES) {
      try {
        return await transcodeGif(source, profile);
      } catch (error) {
        lastError = error;
        if (error.message !== 'WISH_GIF_TOO_LARGE') break;
      }
    }
    throw lastError || new Error('WISH_GIF_FAILED');
  })();

  gifCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    gifCache.delete(cacheKey);
    throw error;
  }
}

module.exports = {
  SOURCE_BASE,
  animationFilename,
  animationColor,
  animationWaitMs,
  renderGameWishGif,
};
