'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { reviewArtifact } = require('./artifactEvaluator');
const {
  cleanSetName,
  pieceQuality,
  directStatDelta,
  applyArtifactReplacement,
  effectiveRv,
} = require('./artifactDoctor');
const { guideProfile, formatStat } = require('./statProfile');

const SLOT_LABELS = { flower: 'Flower', plume: 'Plume', sands: 'Sands', goblet: 'Goblet', circlet: 'Circlet' };
const DIRECT_KEYS = ['critRate', 'critDmg', 'er', 'em'];
const LABELS = { critRate: 'CRIT Rate', critDmg: 'CRIT DMG', er: 'ER', em: 'EM' };
let workerPromise = null;
let ocrQueue = Promise.resolve();

function slotFromText(text) {
  const value = String(text || '');
  if (/flower|flower\s+of\s+life|زهرة|زهره/iu.test(value)) return 'flower';
  if (/plume|plume\s+of\s+death|feather|ريش[ةه]?/iu.test(value)) return 'plume';
  if (/sands?|sands\s+of\s+eon|hourglass|ساعة|ساعه|رمل/iu.test(value)) return 'sands';
  if (/goblet|goblet\s+of\s+eonothem|eonothem|cup|كوب|قوبلت|غوبلت/iu.test(value)) return 'goblet';
  if (/circlet|circlet\s+of\s+logos|logos|crown|تاج|سيركليت/iu.test(value)) return 'circlet';
  return null;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/[＋﹢]/g, '+')
    .replace(/[％﹪]/g, '%')
    .replace(/[·•●]/g, ' • ')
    .replace(/CR[Il1]T/gi, 'CRIT')
    .replace(/D[MＮ]G/gi, 'DMG')
    .replace(/\bDEFENCE\b/gi, 'DEFENSE')
    .replace(/[|]/g, 'I');
}

function statDescriptor(label, hasPercent) {
  const text = String(label || '').trim();
  if (/crit\s*rate/i.test(text)) return ['CRIT Rate', 'FIGHT_PROP_CRITICAL', true];
  if (/crit\s*(?:dmg|damage)/i.test(text)) return ['CRIT DMG', 'FIGHT_PROP_CRITICAL_HURT', true];
  if (/energy\s*recharge|\ber\b/i.test(text)) return ['Energy Recharge', 'FIGHT_PROP_CHARGE_EFFICIENCY', true];
  if (/elemental\s*mastery|\bem\b/i.test(text)) return ['Elemental Mastery', 'FIGHT_PROP_ELEMENT_MASTERY', false];
  if (/pyro\s*dmg/i.test(text)) return ['Pyro DMG Bonus', 'FIGHT_PROP_FIRE_ADD_HURT', true];
  if (/cryo\s*dmg/i.test(text)) return ['Cryo DMG Bonus', 'FIGHT_PROP_ICE_ADD_HURT', true];
  if (/hydro\s*dmg/i.test(text)) return ['Hydro DMG Bonus', 'FIGHT_PROP_WATER_ADD_HURT', true];
  if (/electro\s*dmg/i.test(text)) return ['Electro DMG Bonus', 'FIGHT_PROP_ELEC_ADD_HURT', true];
  if (/anemo\s*dmg/i.test(text)) return ['Anemo DMG Bonus', 'FIGHT_PROP_WIND_ADD_HURT', true];
  if (/geo\s*dmg/i.test(text)) return ['Geo DMG Bonus', 'FIGHT_PROP_ROCK_ADD_HURT', true];
  if (/dendro\s*dmg/i.test(text)) return ['Dendro DMG Bonus', 'FIGHT_PROP_GRASS_ADD_HURT', true];
  if (/physical\s*dmg/i.test(text)) return ['Physical DMG Bonus', 'FIGHT_PROP_PHYSICAL_ADD_HURT', true];
  if (/healing\s*bonus/i.test(text)) return ['Healing Bonus', 'FIGHT_PROP_HEAL_ADD', true];
  if (/\batk\b|attack/i.test(text)) return [hasPercent ? 'ATK%' : 'ATK', hasPercent ? 'FIGHT_PROP_ATTACK_PERCENT' : 'FIGHT_PROP_ATTACK', hasPercent];
  if (/\bhp\b|health/i.test(text)) return [hasPercent ? 'HP%' : 'HP', hasPercent ? 'FIGHT_PROP_HP_PERCENT' : 'FIGHT_PROP_HP', hasPercent];
  if (/\bdef\b|defense/i.test(text)) return [hasPercent ? 'DEF%' : 'DEF', hasPercent ? 'FIGHT_PROP_DEFENSE_PERCENT' : 'FIGHT_PROP_DEFENSE', hasPercent];
  return null;
}

function cleanLines(text) {
  return normalizeOcrText(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parseSubstats(text) {
  const rows = [];
  const lines = cleanLines(text);
  const label = '(CRIT\\s*(?:RATE|DMG|DAMAGE)|ENERGY\\s*RECHARGE|ELEMENTAL\\s*MASTERY|ATK|ATTACK|HP|DEF|DEFENSE)';
  const strict = new RegExp(`${label}\\s*\\+\\s*(\\d+(?:\\.\\d+)?)\\s*(%?)`, 'i');
  const loose = new RegExp(`^[^A-Za-z0-9]{0,4}${label}\\s*[:+]?\\s*(\\d+(?:\\.\\d+)?)\\s*(%?)`, 'i');

  for (const line of lines) {
    let match = line.match(strict);
    if (!match && /^[•*·.\-]/.test(line)) match = line.match(loose);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    const descriptor = statDescriptor(match[1], match[3] === '%');
    if (!descriptor) continue;
    const [name, fightProp, isPercent] = descriptor;
    if (rows.some((row) => row.fightProp === fightProp)) continue;
    rows.push({ name, fightProp, isPercent, numericValue: value, value: `${value}${isPercent ? '%' : ''}` });
    if (rows.length >= 4) break;
  }
  return rows;
}

function parseMainStat(lines, slot, levelIndex) {
  if (slot === 'flower') return { mainStat: 'HP', mainStatKey: 'FIGHT_PROP_HP', mainValue: '4780' };
  if (slot === 'plume') return { mainStat: 'ATK', mainStatKey: 'FIGHT_PROP_ATTACK', mainValue: '311' };

  const head = lines.slice(0, levelIndex >= 0 ? levelIndex : Math.min(lines.length, 12));
  const labels = '(CRIT\\s*(?:RATE|DMG|DAMAGE)|ENERGY\\s*RECHARGE|ELEMENTAL\\s*MASTERY|PYRO\\s*DMG(?:\\s*BONUS)?|CRYO\\s*DMG(?:\\s*BONUS)?|HYDRO\\s*DMG(?:\\s*BONUS)?|ELECTRO\\s*DMG(?:\\s*BONUS)?|ANEMO\\s*DMG(?:\\s*BONUS)?|GEO\\s*DMG(?:\\s*BONUS)?|DENDRO\\s*DMG(?:\\s*BONUS)?|PHYSICAL\\s*DMG(?:\\s*BONUS)?|HEALING\\s*BONUS|ATK|ATTACK|HP|DEF|DEFENSE)';
  const inline = new RegExp(`${labels}\\s*[: ]+\\s*(\\d+(?:\\.\\d+)?)\\s*(%?)`, 'i');

  for (let i = head.length - 1; i >= 0; i -= 1) {
    const match = head[i].match(inline);
    if (!match) continue;
    const descriptor = statDescriptor(match[1], match[3] === '%');
    if (!descriptor) continue;
    return { mainStat: descriptor[0], mainStatKey: descriptor[1], mainValue: `${match[2]}${descriptor[2] ? '%' : ''}` };
  }

  for (let i = 0; i < head.length - 1; i += 1) {
    if (!new RegExp(`^${labels}$`, 'i').test(head[i])) continue;
    const val = head[i + 1].match(/^(\d+(?:\.\d+)?)\s*(%?)$/);
    if (!val) continue;
    const descriptor = statDescriptor(head[i], val[2] === '%');
    if (!descriptor) continue;
    return { mainStat: descriptor[0], mainStatKey: descriptor[1], mainValue: `${val[1]}${descriptor[2] ? '%' : ''}` };
  }
  return { mainStat: 'Unknown', mainStatKey: null, mainValue: '' };
}

function setTokens(value) {
  return String(value || '').toLowerCase().match(/[a-z]{4,}/g) || [];
}

function findSet(text, lines, guide) {
  const full = normalize(text);
  for (const row of guide?.artifacts || []) {
    const set = cleanSetName(row);
    if (set && full.includes(normalize(set))) return set;
  }

  // OCR often drops an apostrophe or one word in long set names. Accept a recommended
  // set when most of its meaningful words are still visible in the screenshot.
  for (const row of guide?.artifacts || []) {
    const set = cleanSetName(row);
    const tokens = setTokens(set);
    if (tokens.length < 2) continue;
    const hits = tokens.filter((token) => full.includes(token)).length;
    if (hits / tokens.length >= 0.6) return set;
  }

  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!/(?:2|4)\s*[- ]?\s*piece\s*set/i.test(lines[i + 1])) continue;
    const candidate = lines[i].replace(/:\s*$/, '').trim();
    if (candidate.length >= 5 && !/bonus/i.test(candidate)) return candidate;
  }
  return null;
}

function parseArtifactText(text, guide, expectedSlot = null) {
  const cleaned = normalizeOcrText(text);
  const lines = cleanLines(cleaned);
  const slot = slotFromText(cleaned) || expectedSlot;
  if (!slot) return { ok: false, reason: 'SLOT_NOT_FOUND', rawText: cleaned, confidence: 0 };

  const levelMatch = cleaned.match(/\+(\d{1,2})\b/);
  const level = Number(levelMatch?.[1] ?? 20);
  const levelIndex = lines.findIndex((line) => /\+\s*\d{1,2}\b/.test(line));
  const tail = levelIndex >= 0 ? lines.slice(levelIndex + 1).join('\n') : lines.join('\n');
  const substats = parseSubstats(tail);
  const main = parseMainStat(lines, slot, levelIndex);
  const set = findSet(cleaned, lines, guide);
  const mainKnown = Boolean(main.mainStatKey) || slot === 'flower' || slot === 'plume';
  const requiredSubstats = level >= 4 ? 4 : 3;
  const confidence = substats.length * 20 + (mainKnown ? 15 : 0) + (set ? 10 : 0) + (levelIndex >= 0 ? 5 : 0);

  const artifact = {
    slot,
    level: Number.isFinite(level) ? Math.max(0, Math.min(20, level)) : 20,
    rarity: 5,
    set: set || 'Unknown Set',
    mainStat: main.mainStat,
    mainStatKey: main.mainStatKey,
    mainValue: main.mainValue,
    substats,
    rolls: [],
    totalRolls: 0,
    source: 'ocr',
  };

  if (!mainKnown) return { ok: false, reason: 'MAIN_STAT_NOT_FOUND', rawText: cleaned, slot, artifact, confidence };
  if (substats.length < requiredSubstats) {
    return { ok: false, reason: `PARTIAL_SUBSTATS_${substats.length}`, rawText: cleaned, slot, artifact, confidence };
  }
  return { ok: true, artifact, rawText: cleaned, confidence };
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = import('tesseract.js').then(async ({ createWorker }) => {
      const worker = await createWorker('eng');
      try {
        await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
      } catch {}
      return worker;
    });
  }
  try {
    return await workerPromise;
  } catch (error) {
    workerPromise = null;
    throw error;
  }
}

function enhanceCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.55 + 128));
    data[i] = contrasted;
    data[i + 1] = contrasted;
    data[i + 2] = contrasted;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function cropBuffer(image, sx, sy, sw, sh, enhanced = false) {
  const scale = Math.max(1.4, Math.min(3, 1800 / Math.max(1, sw)));
  const width = Math.max(1, Math.floor(sw * scale));
  const height = Math.max(1, Math.floor(sh * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
  if (enhanced) enhanceCanvas(canvas);
  return canvas.toBuffer('image/png');
}

async function preprocessVariants(buffer) {
  const image = await loadImage(buffer);
  const w = Number(image.width) || 1;
  const h = Number(image.height) || 1;
  const ratio = w / h;
  const variants = [];

  if (ratio >= 1.45) {
    // Genshin's detail panel sits on the right in both the character-artifact screen
    // and inventory screen. Try a tight crop first, then a wider crop and full frame.
    variants.push(cropBuffer(image, Math.floor(w * 0.64), 0, Math.floor(w * 0.36), h, false));
    variants.push(cropBuffer(image, Math.floor(w * 0.54), 0, Math.floor(w * 0.46), h, true));
    variants.push(cropBuffer(image, 0, 0, w, h, true));
  } else {
    // Tight artifact screenshots like the in-game detail card already fill the frame.
    variants.push(cropBuffer(image, 0, 0, w, h, false));
    variants.push(cropBuffer(image, 0, 0, w, h, true));
  }
  return variants;
}

async function fetchAttachmentBuffer(attachment) {
  const url = attachment?.url || attachment?.proxyURL;
  if (!url || !/^https:\/\//i.test(url)) throw new Error('INVALID_ATTACHMENT_URL');
  if (Number(attachment?.size) > 12 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE');
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`IMAGE_HTTP_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function recognizeArtifactAttachment(attachment, guide, expectedSlot = null) {
  const task = async () => {
    const buffer = await fetchAttachmentBuffer(attachment);
    const variants = await preprocessVariants(buffer);
    const worker = await getWorker();
    let best = null;

    for (const prepared of variants) {
      const result = await worker.recognize(prepared);
      const parsed = parseArtifactText(result?.data?.text || '', guide, expectedSlot);
      if (!best || Number(parsed.confidence || 0) > Number(best.confidence || 0)) best = parsed;
      if (parsed.ok && (parsed.artifact?.substats?.length || 0) >= 4) return parsed;
    }
    return best || { ok: false, reason: 'OCR_EMPTY', confidence: 0 };
  };

  const operation = ocrQueue.catch(() => {}).then(task);
  ocrQueue = operation.catch(() => {});
  return operation;
}

function recommendedSetNames(guide) {
  return (guide?.artifacts || []).map(cleanSetName).filter(Boolean);
}

function projectedRecommendedSetCount(snapshot, slot, artifact, guide) {
  const names = recommendedSetNames(guide);
  if (!names.length) return { required: 0, count: 0, matched: true };
  const current = (snapshot?.artifacts || []).filter((row) => row.slot !== slot).concat([artifact]);
  const counts = names.map((name) => current.filter((row) => {
    const currentSet = normalize(row.set);
    const wanted = normalize(name);
    return currentSet && wanted && (currentSet.includes(wanted) || wanted.includes(currentSet));
  }).length);
  const required = (guide?.artifacts || []).some((row) => /4\s*[- ]?\s*(?:pc|piece)/i.test(String(row))) ? 4 : 2;
  const count = Math.max(0, ...counts);
  return { required, count, matched: count >= required };
}

function targetGain(snapshot, projected, guide) {
  const profile = guideProfile(guide);
  let score = 0;
  const details = [];
  for (const target of profile.targets) {
    if (!DIRECT_KEYS.includes(target.key)) continue;
    const before = Number(snapshot?.stats?.[target.key]);
    const after = Number(projected?.stats?.[target.key]);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    const beforeGap = Math.max(0, target.min - before);
    const afterGap = Math.max(0, target.min - after);
    if (afterGap < beforeGap) score += (beforeGap - afterGap) * 18;
    if (before >= target.min && after < target.min) score -= (target.min - after + 1) * 40;
    if (target.max > target.min && before < target.max && after > before) score += Math.min(after - before, target.max - before) * 4;
    details.push({ key: target.key, before, after, target });
  }
  return { score, details };
}

function scoreCandidateArtifact(candidate, snapshot, guide, evaluation = null, expectedSlot = null) {
  const slot = expectedSlot || candidate?.slot;
  if (!candidate || !slot || candidate.slot !== slot) return { valid: false, score: -99999, reason: 'WRONG_SLOT' };
  const reviewedBase = reviewArtifact(candidate, guide);
  if (!reviewedBase.mainMatch) return { valid: false, score: -50000, reason: 'WRONG_MAIN', reviewed: reviewedBase };

  const quality = pieceQuality(candidate, reviewedBase, snapshot, guide, evaluation);
  const reviewed = { ...reviewedBase, effectiveRv: quality.displayRv };
  const currentArtifact = (snapshot?.artifacts || []).find((row) => row.slot === slot) || null;
  const currentReviewedBase = currentArtifact ? reviewArtifact(currentArtifact, guide) : null;
  const currentQuality = currentArtifact ? pieceQuality(currentArtifact, currentReviewedBase, snapshot, guide, evaluation) : null;
  const currentReviewed = currentReviewedBase ? { ...currentReviewedBase, effectiveRv: currentQuality.displayRv } : null;
  const projected = applyArtifactReplacement(snapshot, slot, candidate);
  const gain = targetGain(snapshot, projected, guide);
  const setFit = projectedRecommendedSetCount(snapshot, slot, candidate, guide);
  let score = quality.score + gain.score;
  if (setFit.required && setFit.matched) score += 90;
  else if (setFit.required && !setFit.matched) score -= 360;
  if (candidate.set === 'Unknown Set') score -= 45;
  if (candidate.level < 20) score -= (20 - candidate.level) * 12;

  return {
    valid: true,
    score: Math.round(score * 10) / 10,
    reviewed,
    quality,
    currentReviewed,
    currentQuality,
    projected,
    delta: directStatDelta(currentArtifact, candidate),
    targetDetails: gain.details,
    setFit,
  };
}

function fmtDelta(key, value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.05) return null;
  const sign = value > 0 ? '+' : '';
  if (['critRate', 'critDmg', 'er'].includes(key)) return `${LABELS[key] || key} ${sign}${value.toFixed(1)}%`;
  return `${LABELS[key] || key} ${sign}${Math.round(value)}`;
}

function formatPickerResult(best, candidates, snapshot, guide, lang = 'ar') {
  const ar = lang === 'ar';
  const row = best.reviewed;
  const lines = [ar
    ? `**أفضل قطعة: ${SLOT_LABELS[row.slot]} — الصورة #${best.index + 1}**`
    : `**Best piece: ${SLOT_LABELS[row.slot]} — image #${best.index + 1}**`];
  lines.push(`RV **${effectiveRv(row)}%** • CV **${row.cv}**`);

  const deltas = Object.entries(best.delta || {}).map(([key, value]) => fmtDelta(key, value)).filter(Boolean);
  if (deltas.length) lines.push(ar ? `أثرها على البيلد: ${deltas.join(' • ')}` : `Build impact: ${deltas.join(' • ')}`);

  const losses = [];
  for (const detail of best.targetDetails || []) {
    if (detail.before >= detail.target.min && detail.after < detail.target.min) {
      losses.push(`${LABELS[detail.key] || detail.key} ${formatStat(detail.key, detail.before)} → ${formatStat(detail.key, detail.after)}`);
    }
  }
  if (losses.length) lines.push(ar ? `⚠ تنبيه: ${losses.join(' • ')} أقل من التارقت.` : `⚠ Warning: ${losses.join(' • ')} falls below target.`);

  if (best.setFit?.required && !best.setFit.matched) {
    lines.push(ar
      ? `⚠ تركيبها يكسر ${best.setFit.required}-Piece للـSet المقترح، لذلك تُخفض أفضليتها حتى لو سب ستاتها قوية.`
      : `⚠ Equipping it breaks the recommended ${best.setFit.required}-piece set, so it is penalized even with strong substats.`);
  }

  const valid = candidates.filter((item) => item.valid).length;
  lines.push(ar
    ? `تمت مقارنة **${valid}** قطعة حسب بيلد ${snapshot.name}: التارقت والـSet أولًا، ثم RV، وCV فقط إذا الكريت مهم للشخصية.`
    : `Compared **${valid}** pieces for ${snapshot.name}: targets and set first, then RV, with CV only when crit matters.`);
  return lines.join('\n');
}

module.exports = {
  SLOT_LABELS,
  slotFromText,
  normalizeOcrText,
  parseSubstats,
  parseArtifactText,
  recognizeArtifactAttachment,
  scoreCandidateArtifact,
  formatPickerResult,
  projectedRecommendedSetCount,
};
