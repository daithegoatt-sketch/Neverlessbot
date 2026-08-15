'use strict';

const { getGuideByText } = require('./guides');
const { getGuide } = require('./guideClient');
const { getCharacterNames, getCharacter } = require('./dataClient');
const { getLinkedUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot } = require('./enkaClient');
const { evaluateBuild, compareSnapshots } = require('./buildEvaluator');
const { getEntries, record } = require('./buildHistory');
const { buildRatingCard } = require('./buildCard');
const { fetchAkashaPercentile } = require('./akashaClient');
const { accountEvaluationText } = require('./responses');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function isAccountPhrase(text) {
  return /بحسابي|في\s+حسابي|من\s+حسابي|my\s+account|in\s+my\s+account|on\s+my\s+account/i.test(text);
}

function requestType(text) {
  if (!isAccountPhrase(text)) return null;
  if (/قارن|مقارن[ةه]|compare|comparison|السابق|القديم/i.test(text)) return 'compare';
  if (/تقييم|قييم|قيّم|قيم|رأيك|رايك|شرايك|حلل|rate|rating|evaluate|analy[sz]e|what\s+do\s+you\s+think/i.test(text)) return 'rate';
  return null;
}

function skeleton(value) {
  const map = { ا:'a',أ:'a',إ:'a',آ:'a',ب:'b',ت:'t',ث:'th',ج:'j',ح:'h',خ:'kh',د:'d',ذ:'dh',ر:'r',ز:'z',س:'s',ش:'sh',ص:'s',ض:'d',ط:'t',ظ:'z',ع:'',غ:'gh',ف:'f',ق:'q',ك:'k',ل:'l',م:'m',ن:'n',ه:'h',ة:'h',و:'w',ي:'y',ى:'a',ء:'',ئ:'y',ؤ:'w' };
  return [...String(value).toLowerCase()].map((c) => map[c] ?? c).join('').replace(/sh/g,'s').replace(/kh/g,'k').replace(/gh/g,'g').replace(/th|dh/g,'t').replace(/[^a-z0-9]/g,'').replace(/[aeiouywh]/g,'').replace(/(.)\1+/g,'$1');
}

function distance(a, b) {
  const d = Array.from({ length: b.length + 1 }, () => Array(a.length + 1).fill(0));
  for (let i = 0; i <= b.length; i += 1) d[i][0] = i;
  for (let j = 0; j <= a.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= b.length; i += 1) for (let j = 1; j <= a.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (b[i - 1] === a[j - 1] ? 0 : 1));
  return d[b.length][a.length];
}

async function resolveCharacter(text) {
  const curated = getGuideByText(text);
  if (curated) return curated.name;
  let names = [];
  try { names = await getCharacterNames(); } catch { return null; }
  const lower = String(text).toLowerCase();
  const direct = [...names].sort((a, b) => b.length - a.length).find((name) => lower.includes(name.toLowerCase()));
  if (direct) return direct;
  const tokens = String(text).match(/[\u0600-\u06ff]{3,}(?:\s+[\u0600-\u06ff]{3,})?/g) || [];
  let best = null;
  for (const token of tokens) {
    const left = skeleton(token);
    if (left.length < 3) continue;
    for (const name of names) {
      const right = skeleton(name);
      if (right.length < 2) continue;
      const score = 1 - distance(left, right) / Math.max(left.length, right.length);
      if (score >= 0.68 && (!best || score > best.score)) best = { name, score };
    }
  }
  return best?.name || null;
}

function snapshotKey(snapshot) {
  return JSON.stringify({
    stats: snapshot?.stats,
    weapon: snapshot?.weapon,
    sets: snapshot?.setCounts,
    artifacts: snapshot?.artifacts?.map((item) => [item.slot, item.set, item.mainStat, item.level]),
  });
}

function sameSnapshot(a, b) {
  return snapshotKey(a) === snapshotKey(b);
}

function previousDifferent(entries, currentSnapshot) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!sameSnapshot(entries[i]?.snapshot, currentSnapshot)) return entries[i];
  }
  return null;
}

async function send(message, text, files = []) {
  const prefix = `<@${message.author.id}> `;
  await message.channel.send({ content: `${prefix}${text}`, files, allowedMentions: { users: [message.author.id] } });
}

async function handleRatingMessage(message) {
  if (!message?.guildId || message.author?.bot || message.channelId !== CHANNEL_ID) return false;
  const text = String(message.content || '').trim();
  const type = requestType(text);
  if (!type) return false;

  const lang = language(text);
  const characterName = await resolveCharacter(text);
  if (!characterName) {
    await send(message, lang === 'ar' ? 'حدد اسم الشخصية داخل الطلب، مثال: `تقييم Skirk في حسابي`.' : 'Include the character name, e.g. `rate Skirk in my account`.');
    return true;
  }

  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar' ? 'حساب Genshin مو مربوط. اكتب أولًا: `ربط UID 729663359`.' : 'No Genshin account is linked. First use `link UID 729663359`.');
    return true;
  }

  let account;
  try {
    account = await fetchAccount(uid);
  } catch (error) {
    console.warn('[genshin-rating-v4] Enka fetch failed:', error.message);
    await send(message, lang === 'ar' ? 'ما قدرت أقرأ Enka الآن. تأكد أن الشخصية موجودة في الـShowcase وأن **Show Character Details** مفعّل.' : 'I could not read Enka right now. Make sure the character is in Showcase and **Show Character Details** is enabled.');
    return true;
  }

  const character = findCharacter(account, characterName);
  if (!character) {
    await send(message, lang === 'ar' ? `**${characterName}** مو ظاهرة بالتفاصيل في الـShowcase حاليًا.` : `**${characterName}** is not visible with details in your Showcase.`);
    return true;
  }

  const guide = await getGuide(characterName);
  if (!guide) {
    await send(message, lang === 'ar' ? `أقدر أقرأ **${characterName}** من Enka، لكن ما عندي Guide موثوق كفاية حتى أعطيها نسبة تقييم.` : `I can read **${characterName}** from Enka, but I do not have a reliable enough guide to assign a rating.`);
    return true;
  }

  const snapshot = getBuildSnapshot(character);
  const akashaPercentile = await fetchAkashaPercentile(uid, characterName);
  const evaluation = evaluateBuild(snapshot, guide, { akashaPercentile });
  const current = { snapshot, evaluation };
  const entries = getEntries(message.author.id, uid, characterName);
  const latest = entries.at(-1) || null;

  let comparison = null;
  if (type === 'compare') {
    const baseline = previousDifferent(entries, snapshot);
    if (!baseline) {
      if (!latest || !sameSnapshot(latest.snapshot, snapshot)) await record(message.author.id, uid, characterName, current);
      await send(message, lang === 'ar'
        ? `ما عندي نسخة **مختلفة** أقدم لـ **${characterName}** أقارنها بالحالي. حفظت البيلد الحالي ${evaluation.score}% كنقطة بداية؛ بعد ما تغيّره اطلب: \`قارن ${characterName} في حسابي\`.`
        : `I do not have an older **different** ${characterName} build to compare with. I saved the current ${evaluation.score}% build as the baseline.`);
      return true;
    }
    comparison = compareSnapshots(baseline, current);
  }

  // Rating saves snapshots for future explicit comparisons, but never displays comparison by itself.
  if (!latest || !sameSnapshot(latest.snapshot, snapshot)) await record(message.author.id, uid, characterName, current);

  let files = [];
  try {
    const characterData = await getCharacter(characterName).catch(() => null);
    const card = await buildRatingCard(character, snapshot, evaluation, type === 'compare' ? comparison : null, { characterData, akashaPercentile });
    files = [{ attachment: card, name: `${characterName.replace(/[^a-z0-9]+/gi, '-')}-${type}.png` }];
  } catch (error) {
    console.warn('[genshin-rating-v4] Card generation failed:', error.message);
  }

  await send(message, accountEvaluationText(snapshot, evaluation, type === 'compare' ? comparison : null, guide, lang, akashaPercentile), files);
  return true;
}

module.exports = { handleRatingMessage, requestType, previousDifferent, sameSnapshot };
