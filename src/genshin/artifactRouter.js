'use strict';

const { getLinkedUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot } = require('./enkaClient');
const { getGuide } = require('./guideClient');
const { resolveCharacter } = require('./characterResolver');
const { formatArtifactReview } = require('./ratingCopyV2');
const { formatArtifactDoctor } = require('./artifactDoctor');
const { evaluateBuild } = require('./buildEvaluator');

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function accountPhrase(text) {
  return /بحسابي|في\s+حسابي|من\s+حسابي|my\s+account|in\s+my\s+account|on\s+my\s+account/i.test(String(text || ''));
}

function hasArtifactWord(value) {
  return /[اآأإ]?رت[يى]?[فڤ]ا?كت(?:ات)?|artifact(?:s)?/iu.test(String(value || ''));
}

// Keep the useful text-only improvement command. The interactive Artifact Doctor,
// screenshot picker, buttons and sessions have been removed completely.
function isArtifactImprove(text) {
  const value = String(text || '');
  const hasImprove = /تحسين|حس[ّ]?ن|طور|طوّر|رفع|ارفع|أرفع|improve|upgrade|increase|raise/iu.test(value);
  return hasArtifactWord(value) && hasImprove;
}

function isArtifactReview(text) {
  const value = String(text || '');
  const hasReview = /تقييم|قيّم|قيم|حلل|راجع|rate|review|evaluate/iu.test(value);
  return hasArtifactWord(value) && hasReview && accountPhrase(value);
}

async function send(message, content) {
  await message.channel.send({
    content,
    allowedMentions: { users: [], repliedUser: false },
  });
}

async function loadLinkedBuild(message, text, lang) {
  const characterName = await resolveCharacter(text);
  if (!characterName) {
    await send(message, lang === 'ar'
      ? 'حدد اسم الشخصية، مثال: `قيم ارتيفاكتات Skirk بحسابي` أو `تحسين ارتيفاكتات Skirk`.'
      : 'Include the character name, e.g. `rate Skirk artifacts on my account` or `improve Skirk artifacts`.');
    return null;
  }

  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar'
      ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.'
      : 'Link your account first: `link UID 7XXXXXXXXX`.');
    return null;
  }

  let account;
  try {
    account = await fetchAccount(uid, { forceRefresh: true });
  } catch (error) {
    console.warn('[artifact-review] Enka fetch failed:', error.message);
    await send(message, lang === 'ar'
      ? 'ما قدرت أقرأ الـShowcase الآن. تأكد أن **Show Character Details** مفعّل.'
      : 'I could not read the Showcase right now. Make sure **Show Character Details** is enabled.');
    return null;
  }

  const character = findCharacter(account, characterName);
  if (!character) {
    await send(message, lang === 'ar'
      ? `**${characterName}** مو ظاهرة بالتفاصيل في الـShowcase حاليًا.`
      : `**${characterName}** is not visible with details in your Showcase.`);
    return null;
  }

  const guide = await getGuide(characterName).catch(() => null);
  if (!guide) {
    await send(message, lang === 'ar'
      ? `أقدر أقرأ ارتيفاكتات **${characterName}**، لكن ما عندي Guide موثوق كفاية حتى أحدد أفضل بيلد.`
      : `I can read **${characterName}**, but I do not have a reliable enough guide to judge the build.`);
    return null;
  }

  return { characterName, guide, snapshot: getBuildSnapshot(character) };
}

function cleanImproveText(text, characterName, lang) {
  let value = String(text || '');
  value = value.replace(
    `**${characterName} — Artifact Doctor**`,
    lang === 'ar' ? `**${characterName} — تحسين الارتيفاكتات**` : `**${characterName} — Artifact Improvement**`,
  );
  value = value
    .replace(/\s*كل رقم داخل حدود رول 5★ منطقي، ولا يطلب 6–7 رولات على سب ستات واحد\.?/gu, '')
    .replace(/\s*Every requested value stays within a realistic 5★ substat ceiling\.?/gu, '');
  return value.trim();
}

async function handleArtifactReviewMessage(message) {
  const text = String(message?.content || '').trim();
  const improve = isArtifactImprove(text);
  const review = isArtifactReview(text);
  if (!improve && !review) return false;

  const lang = language(text);
  const linked = await loadLinkedBuild(message, text, lang);
  if (!linked) return true;

  const { characterName, guide, snapshot } = linked;
  if (improve) {
    const evaluation = evaluateBuild(snapshot, guide);
    const content = cleanImproveText(formatArtifactDoctor(snapshot, guide, evaluation, lang, text), characterName, lang);
    await send(message, content);
    return true;
  }

  await send(message, formatArtifactReview(snapshot, guide, lang));
  return true;
}

module.exports = {
  handleArtifactReviewMessage,
  isArtifactReview,
  isArtifactImprove,
  hasArtifactWord,
  cleanImproveText,
};
