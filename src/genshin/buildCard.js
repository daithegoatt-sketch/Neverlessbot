'use strict';

let kiraraModulePromise = null;

async function getKiraraConstructor() {
  if (!kiraraModulePromise) kiraraModulePromise = import('@kiznavierr/kirara');
  const mod = await kiraraModulePromise;
  const Kirara = mod?.Kirara || mod?.default?.Kirara || mod?.default;
  if (typeof Kirara !== 'function') throw new Error('KIRARA_CONSTRUCTOR_NOT_FOUND');
  return Kirara;
}

function accountContext(character) {
  const uid = String(character?.__neverlessUid || '').trim();
  const avatarId = character?.characterData?.id ?? character?.avatarId ?? character?.id ?? null;
  if (!/^\d{9,10}$/.test(uid)) throw new Error('ENKA_CARD_UID_MISSING');
  if (avatarId == null || !String(avatarId).trim()) throw new Error('ENKA_CARD_AVATAR_ID_MISSING');
  return { uid, avatarId: String(avatarId) };
}

async function normalizeImageResult(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value?.arrayBuffer === 'function') return Buffer.from(await value.arrayBuffer());
  return null;
}

async function downloadCardUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'NeverlessBot/6.0 (Discord Genshin build card)',
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`ENKA_CARD_HTTP_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function generateEnkaCard(character) {
  const { uid, avatarId } = accountContext(character);
  const Kirara = await getKiraraConstructor();
  const kirara = new Kirara('genshin');
  const options = {
    lang: 'en',
    substats: true,
    subsBreakdown: true,
    uid: true,
    hideNames: false,
  };

  try {
    const generated = await kirara.generateCardImage(uid, avatarId, options);
    const buffer = await normalizeImageResult(generated);
    if (buffer?.length) return buffer;
  } catch (error) {
    console.warn('[genshin-card] Direct Enka card download failed:', error.message);
  }

  const cardUrl = await Promise.resolve(kirara.generateCardUrl(uid, avatarId, options));
  const downloaded = await downloadCardUrl(cardUrl);
  if (!downloaded?.length) throw new Error('ENKA_CARD_EMPTY');
  return downloaded;
}

// Keep the same public function signatures so the existing rating/stats logic stays untouched.
async function buildAccountCard(character) {
  return generateEnkaCard(character);
}

async function buildRatingCard(character) {
  return generateEnkaCard(character);
}

async function buildStatsCard(character) {
  return generateEnkaCard(character);
}

// Compatibility exports retained for other Genshin modules, if any.
function characterArtUrl(character) {
  const asset = character?.costume?.art || character?.characterData?.costume?.art || character?.characterData?.art;
  for (const key of ['url', 'imageUrl', 'mihoyoUrl']) {
    if (typeof asset?.[key] === 'string' && /^https?:\/\//.test(asset[key])) return asset[key];
  }
  return null;
}

function dbArtUrl() {
  return null;
}

module.exports = { buildRatingCard, buildStatsCard, buildAccountCard, characterArtUrl, dbArtUrl };
