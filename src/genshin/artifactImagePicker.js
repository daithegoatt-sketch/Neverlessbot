'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { reviewArtifact } = require('./artifactEvaluator');
const {
  cleanSetName,
  pieceQuality,
  directStatDelta,
  applyArtifactReplacement,
} = require('./artifactDoctor');
const { guideProfile, formatStat } = require('./statProfile');

const SLOT_LABELS = { flower: 'Flower', plume: 'Plume', sands: 'Sands', goblet: 'Goblet', circlet: 'Circlet' };
const DIRECT_KEYS = ['critRate', 'critDmg', 'er', 'em'];
let workerPromise = null;
let ocrQueue = Promise.resolve();

function slotFromText(text) {
  const value = String(text || '');
  if (/flower|زهرة|زهره/iu.test(value)) return 'flower';
  if (/plume|feather|ريش[ةه]?/iu.test(value)) return 'plume';
  if (/sands?|hourglass|ساعة|ساعه|رمل/iu.test(value)) return 'sands';
  if (/goblet|cup|كوب|قوبلت|غوبلت/iu.test(value)) return 'goblet';
  if (/circlet|crown|تاج|سيركليت/iu.test(value)) return 'circlet';
  return null;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
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

function parseSubstats(text) {
  const rows = [];
  const regex = /(CRIT\s*(?:RATE|DMG|DAMAGE)|ENERGY\s*RECHARGE|ELEMENTAL\s*MASTERY|ATK|ATTACK|HP|DEF|DEFENSE)\s*\+\s*(\d+(?:\.\d+)?)\s*(%?)/gi;
  for (const match of String(text || '').matchAll(regex)) {
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

function parseMainStat(text, lines, slot) {
  if (slot === 'flower') return { mainStat: 'HP', mainStatKey: 'FIGHT_PROP_HP', mainValue: '4780' };
  if (slot === 'plume') return { mainStat: 'ATK', mainStatKey: 'FIGHT_PROP_ATTACK', mainValue: '311' };

  const labels = '(CRIT\\s*(?:RATE|DMG|DAMAGE)|ENERGY\\s*RECHARGE|ELEMENTAL\\s*MASTERY|PYRO\\s*DMG\\s*BONUS|CRYO\\s*DMG\\s*BONUS|HYDRO\\s*DMG\\s*BONUS|ELECTRO\\s*DMG\\s*BONUS|ANEMO\\s*DMG\\s*BONUS|GEO\\s*DMG\\s*BONUS|DENDRO\\s*DMG\\s*BONUS|PHYSICAL\\s*DMG\\s*BONUS|HEALING\\s*BONUS|ATK|ATTACK|HP|DEF|DEFENSE)';
  const inline = new RegExp(`${labels}\\s*[: ]+\\s*(?!\\+)(\\d+(?:\\.\\d+)?)\\s*(%?)`, 'i');
  for (const line of lines) {
    const match = line.match(inline);
    if (!match) continue;
    const descriptor = statDescriptor(match[1], match[3] === '%');
    if (!descriptor) continue;
    const [mainStat, mainStatKey, isPercent] = descriptor;
    return { mainStat, mainStatKey, mainValue: `${match[2]}${isPercent ? '%' : ''}` };
  }

  // Genshin often renders the main-stat label and value on separate OCR lines.
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!new RegExp(`^${labels}$`, 'i').test(lines[i])) continue;
    const val = lines[i + 1].match(/^(\d+(?:\.\d+)?)\s*(%?)$/);
    if (!val) continue;
    const descriptor = statDescriptor(lines[i], val[2] === '%');
    if (!descriptor) continue;
    return { mainStat: descriptor[0], mainStatKey: descriptor[1], mainValue: `${val[1]}${descriptor[2] ? '%' : ''}` };
  }
  return { mainStat: 'Unknown', mainStatKey: null, mainValue: '' };
}

function findSet(text, lines, guide) {
  const full = normalize(text);
  for (const row of guide?.artifacts || []) {
    const set = cleanSetName(row);
    if (set && full.includes(normalize(set))) return set;
  }
  const candidate = lines.find((line, index) => /:$/.test(line)
    && index + 1 < lines.length
    && /(?:2|4)[- ]?piece\s*set/i.test(lines[index + 1]));
  return candidate ? candidate.replace(/:\s*$/, '').trim() : null;
}

function parseArtifactText(text, guide, expectedSlot = null) {
  const cleaned = String(text || '').replace(/[|]/g, 'I');
  const lines = cleaned.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const slot = slotFromText(cleaned) || expectedSlot;
  if (!slot) return { ok: false, reason: 'SLOT_NOT_FOUND', rawText: cleaned };
  const substats = parseSubstats(cleaned);
  if (substats.length < 2) return { ok: false, reason: 'SUBSTATS_NOT_FOUND', rawText: cleaned, slot };
  const main = parseMainStat(cleaned, lines, slot);
  const level = Number(cleaned.match(/\+(\d{1,2})\b/)?.[1] || 20);
  const set = findSet(cleaned, lines, guide);
  return {
    ok: true,
    artifact: {
      slot,
      level: Number.isFinite(level) ? level : 20,
      rarity: 5,
      set: set || 'Unknown Set',
      mainStat: main.mainStat,
      mainStatKey: main.mainStatKey,
      mainValue: main.mainValue,
      substats,
      rolls: [],
      totalRolls: 0,
      source: 'ocr',
    },
    rawText: cleaned,
  };
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = import('tesseract.js').then(({ createWorker }) => createWorker('eng'));
  }
  try {
    return await workerPromise;
  } catch (error) {
    workerPromise = null;
    throw error;
  }
}

async function preprocess(buffer) {
  const image = await loadImage(buffer);
  const sourceW = Number(image.width) || 1;
  const sourceH = Number(image.height) || 1;
  const wide = sourceW / sourceH > 1.45;
  const sx = wide ? Math.floor(sourceW * 0.48) : 0;
  const sw = wide ? sourceW - sx : sourceW;
  const scale = Math.max(1, Math.min(2.2, 1700 / sw));
  const width = Math.floor(sw * scale);
  const height = Math.floor(sourceH * scale);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, sx, 0, sw, sourceH, 0, 0, width, height);
  return canvas.toBuffer('image/png');
}

async function fetchAttachmentBuffer(attachment) {
  const url = attachment?.url || attachment?.proxyURL;
  if (!url || !/^https:\/\//i.test(url)) throw new Error('INVALID_ATTACHMENT_URL');
  if (Number(attachment?.size) > 12 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE');
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`IMAGE_HTTP_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function recognizeArtifactAttachment(attachment, guide, expectedSlot) {
  const task = async () => {
    const buffer = await fetchAttachmentBuffer(attachment);
    const prepared = await preprocess(buffer);
    const worker = await getWorker();
    const result = await worker.recognize(prepared);
    return parseArtifactText(result?.data?.text || '', guide, expectedSlot);
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
  const counts = names.map((name) => current.filter((row) => normalize(row.set).includes(normalize(name)) || normalize(name).includes(normalize(row.set))).length);
  const required = (guide?.artifacts || []).some((row) => /4[- ]?piece/i.test(String(row))) ? 4 : 2;
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
    if (afterGap < beforeGap) score += (beforeGap - afterGap) * 14;
    if (before >= target.min && after < target.min) score -= (target.min - after + 1) * 32;
    details.push({ key: target.key, before, after, target });
  }
  return { score, details };
}

function scoreCandidateArtifact(candidate, snapshot, guide, evaluation = null, expectedSlot = null) {
  const slot = expectedSlot || candidate?.slot;
  if (!candidate || !slot || candidate.slot !== slot) return { valid: false, score: -99999, reason: 'WRONG_SLOT' };
  const reviewed = reviewArtifact(candidate, guide);
  if (!reviewed.mainMatch) return { valid: false, score: -50000, reason: 'WRONG_MAIN', reviewed };

  const quality = pieceQuality(candidate, reviewed, snapshot, guide, evaluation);
  const currentArtifact = (snapshot?.artifacts || []).find((row) => row.slot === slot) || null;
  const currentReviewed = currentArtifact ? reviewArtifact(currentArtifact, guide) : null;
  const currentQuality = currentArtifact ? pieceQuality(currentArtifact, currentReviewed, snapshot, guide, evaluation) : null;
  const projected = applyArtifactReplacement(snapshot, slot, candidate);
  const gain = targetGain(snapshot, projected, guide);
  const setFit = projectedRecommendedSetCount(snapshot, slot, candidate, guide);
  let score = quality.score + gain.score;
  if (setFit.required && setFit.matched) score += 80;
  else if (setFit.required && !setFit.matched) score -= 320;
  if (candidate.set === 'Unknown Set') score -= 25;

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

const LABELS = { critRate: 'CRIT Rate', critDmg: 'CRIT DMG', er: 'ER', em: 'EM' };

function formatPickerResult(best, candidates, snapshot, guide, lang = 'ar') {
  const ar = lang === 'ar';
  const row = best.reviewed;
  const lines = [ar
    ? `**أفضل قطعة من الصور: ${SLOT_LABELS[row.slot]} — الصورة #${best.index + 1}**`
    : `**Best uploaded piece: ${SLOT_LABELS[row.slot]} — image #${best.index + 1}**`];
  lines.push(`RV **${row.usefulRv}%** • CV **${row.cv}**${best.quality ? ` • Fit **${Math.round(best.quality.score)}**` : ''}`);

  const deltas = Object.entries(best.delta || {}).map(([key, value]) => fmtDelta(key, value)).filter(Boolean);
  if (deltas.length) lines.push(ar ? `التغيير المباشر: ${deltas.join(' • ')}` : `Direct change: ${deltas.join(' • ')}`);

  for (const detail of best.targetDetails || []) {
    if (detail.before >= detail.target.min && detail.after < detail.target.min) {
      lines.push(ar
        ? `⚠ هذه القطعة تنزل ${LABELS[detail.key] || detail.key} من ${formatStat(detail.key, detail.before)} إلى ${formatStat(detail.key, detail.after)}، أقل من التارقت ${formatStat(detail.key, detail.target.min)}.`
        : `⚠ This drops ${LABELS[detail.key] || detail.key} below its target.`);
    }
  }

  if (best.setFit?.required && !best.setFit.matched) {
    lines.push(ar
      ? `⚠ القطعة نفسها جيدة، لكن تركيبها الآن يكسر شرط ${best.setFit.required}-Piece للـSet المقترح؛ لذلك ما اعتبرتها ترقية آمنة.`
      : `⚠ The piece is individually good, but equipping it would break the recommended ${best.setFit.required}-piece set.`);
  }

  const valid = candidates.filter((row) => row.valid).length;
  lines.push(ar
    ? `تمت مقارنة **${valid}** قطعة حسب احتياج ${snapshot.name}: الستات المطلوبة أولًا، ثم RV، وCV فقط إذا الكريت مهم للشخصية.`
    : `Compared **${valid}** pieces using ${snapshot.name}'s required stats first, then RV, with CV only when crit matters to the build.`);
  lines.push(ar
    ? 'اعتمدت القطعة مؤقتًا داخل الجلسة؛ تقدر الآن ترسل صور Slot ثاني، والبوت يحسبها على البيلد المعدّل.'
    : 'This piece is now the temporary session choice; you can send another slot and it will be judged against the projected build.');
  return lines.join('\n');
}

module.exports = {
  slotFromText,
  parseArtifactText,
  recognizeArtifactAttachment,
  scoreCandidateArtifact,
  formatPickerResult,
  projectedRecommendedSetCount,
};
