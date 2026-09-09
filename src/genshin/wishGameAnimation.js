'use strict';

const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const ffmpegPath = require('ffmpeg-static');

// Real in-game wish sequences used by the public WishSimulator.App project.
// Source is pinned so the opening meteor animation cannot silently change.
const PRIMARY_SOURCE_BASE = 'https://cdn.jsdelivr.net/gh/DingerBtn/Genshin-Impact-Wish-Simulator@ec1803b7914ffd896a7ceed76aa553e2bbafbd02/static/videos';
const CAPTURE_SOURCE_BASE = 'https://cdn.jsdelivr.net/gh/Mantan21/Genshin-Impact-Wish-Simulator@d7d1870df7f2b168e37affdfadb43ba9da75857a/static/videos';
const MAX_GIF_BYTES = 9 * 1024 * 1024;
const sourceCache = new Map();
const gifCache = new Map();
const trimCache = new Map();

const PROFILES = [
  { width: 560, fps: 10, colors: 96 },
  { width: 500, fps: 9, colors: 88 },
  { width: 440, fps: 8, colors: 72 },
  { width: 400, fps: 7, colors: 64 },
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
  return capturingRadiance ? 8600 : 7200;
}

function sourceBaseFor(filename) {
  return filename === 'capturing-radiance.mp4' ? CAPTURE_SOURCE_BASE : PRIMARY_SOURCE_BASE;
}

async function fetchSource(filename) {
  if (sourceCache.has(filename)) return sourceCache.get(filename);
  const promise = (async () => {
    const url = `${sourceBaseFor(filename)}/${filename}`;
    const response = await fetch(url, {
      headers: { 'user-agent': 'Neverless-Wish/1.0' },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`WISH_ANIMATION_HTTP_${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 100000) throw new Error(`WISH_ANIMATION_TOO_SMALL_${buffer.length}`);
    if (!buffer.subarray(0, 64).includes(Buffer.from('ftyp'))) throw new Error('WISH_ANIMATION_NOT_MP4');
    return buffer;
  })();
  sourceCache.set(filename, promise);
  try { return await promise; } catch (error) { sourceCache.delete(filename); throw error; }
}

async function detectBlackTrim(inputPath, cacheKey) {
  if (trimCache.has(cacheKey)) return trimCache.get(cacheKey);
  if (!ffmpegPath) return { start: 0, duration: null };
  const child = spawn(ffmpegPath, [
    '-hide_banner', '-i', inputPath,
    '-vf', 'blackdetect=d=0.12:pix_th=0.10',
    '-an', '-f', 'null', '-',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  await once(child, 'close').catch(() => {});
  const text = Buffer.concat(stderr).toString('utf8');
  const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!durationMatch) return { start: 0, duration: null };
  const fullDuration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  const segments = [...text.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)]
    .map((match) => ({ start: Number(match[1]), end: Number(match[2]) }))
    .filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end));

  let start = 0;
  let end = fullDuration;
  const leading = segments.find((row) => row.start <= 0.15 && row.end < fullDuration * 0.45);
  if (leading) start = Math.min(fullDuration - 0.25, leading.end + 0.035);
  const trailing = [...segments].reverse().find((row) => fullDuration - row.end <= 0.18 && row.start > fullDuration * 0.5);
  if (trailing) end = Math.max(start + 0.3, trailing.start - 0.035);

  const trim = { start, duration: Math.max(0.3, end - start) };
  trimCache.set(cacheKey, trim);
  return trim;
}

async function transcodeGif(inputPath, profile, trim) {
  if (!ffmpegPath) throw new Error('FFMPEG_NOT_AVAILABLE');
  const filter = [
    `[0:v]fps=${profile.fps},scale=${profile.width}:-2:flags=lanczos,split[a][b]`,
    `[a]palettegen=max_colors=${profile.colors}:stats_mode=diff[p]`,
    '[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[v]',
  ].join(';');
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (trim?.start > 0.001) args.push('-ss', trim.start.toFixed(3));
  args.push('-i', inputPath);
  if (trim?.duration) args.push('-t', trim.duration.toFixed(3));
  args.push('-an', '-filter_complex', filter, '-map', '[v]', '-loop', '0', '-f', 'gif', 'pipe:1');

  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  const errors = [];
  let size = 0;
  let tooLarge = false;
  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_GIF_BYTES) { tooLarge = true; child.kill('SIGKILL'); return; }
    chunks.push(chunk);
  });
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const [code, signal] = await once(child, 'close');
  if (tooLarge) throw new Error('WISH_GIF_TOO_LARGE');
  if (code !== 0) throw new Error(`WISH_GIF_FFMPEG_${code ?? signal}: ${Buffer.concat(errors).toString('utf8').slice(0, 500)}`);
  const gif = Buffer.concat(chunks);
  if (!gif.length) throw new Error('WISH_GIF_EMPTY');
  return gif;
}

async function renderGameWishGif(rarity, count, capturingRadiance = false) {
  const filename = animationFilename(rarity, count, capturingRadiance);
  if (gifCache.has(filename)) return gifCache.get(filename);
  const promise = (async () => {
    const source = await fetchSource(filename);
    const dir = await mkdtemp(join(tmpdir(), 'neverless-wish-'));
    const inputPath = join(dir, filename);
    try {
      await writeFile(inputPath, source);
      const trim = await detectBlackTrim(inputPath, filename).catch(() => ({ start: 0, duration: null }));
      let lastError = null;
      for (const profile of PROFILES) {
        try { return await transcodeGif(inputPath, profile, trim); }
        catch (error) { lastError = error; if (error.message !== 'WISH_GIF_TOO_LARGE') break; }
      }
      throw lastError || new Error('WISH_GIF_FAILED');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  gifCache.set(filename, promise);
  try { return await promise; } catch (error) { gifCache.delete(filename); throw error; }
}

module.exports = {
  PRIMARY_SOURCE_BASE,
  CAPTURE_SOURCE_BASE,
  animationFilename,
  animationColor,
  animationWaitMs,
  renderGameWishGif,
};
