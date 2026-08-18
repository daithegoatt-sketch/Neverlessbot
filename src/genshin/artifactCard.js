'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { buildAccountCard } = require('./buildCard');

// The old artifact-only canvas depended on local fonts/assets on Railway and could
// render as empty boxes. Reuse the same externally-rendered Enka card that already
// works for character ratings, then crop the artifact column. This keeps the real
// artifact art, substats and roll-quality display without changing rating cards.
async function buildArtifactCard(character) {
  const full = await buildAccountCard(character);
  const image = await loadImage(full);
  const width = Number(image.width) || 0;
  const height = Number(image.height) || 0;
  if (!width || !height) throw new Error('ARTIFACT_CARD_IMAGE_INVALID');

  // enka.cards places the five artifact panels on the right side. Keep a little
  // extra width so main stats/substats and roll-quality values are never clipped.
  const sourceX = Math.max(0, Math.floor(width * 0.61));
  const sourceW = width - sourceX;
  const canvas = createCanvas(sourceW, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, sourceX, 0, sourceW, height, 0, 0, sourceW, height);
  return canvas.toBuffer('image/png');
}

module.exports = { buildArtifactCard };
