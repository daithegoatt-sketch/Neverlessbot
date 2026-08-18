'use strict';

const { getLinkedUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot } = require('./enkaClient');
const { getGuide } = require('./guideClient');
const { resolveCharacter } = require('./characterResolver');
const { formatArtifactReview } = require('./ratingCopyV2');
const { formatArtifactDoctor } = require('./artifactDoctor');
const { buildArtifactCard } = require('./artifactCard');
const { evaluateBuild } = require('./buildEvaluator');

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function accountPhrase(text) {
  return /بحسابي|في\s+حسابي|من\s+حسابي|my\s+account|in\s+my\s+account|on\s+my\s+account/i.test(String(text || ''));
}

function isArtifactDoctor(text) {
  const value = String(text || '');
  const hasArtifact = /[اآأإ]?رت[يى]?فا?كت(?:ات)?|artifact(?:s)?/iu.test(value);
  const hasImprove = /تحسين|حس[ّ]?ن|طور|طوّر|رفع|ارفع|أرفع|improve|upgrade|doctor|increase|raise/iu.test(value);
  return hasArtifact && hasImprove;
}

function isArtifactReview(text) {
  const value = String(text || '');
  const hasArtifact = /[اآأإ]?رت[يى]?فا?كت(?:ات)?|artifact(?:s)?/iu.test(value);
  const hasReview = /تقييم|قيّم|قيم|حلل|راجع|rate|review|evaluate/iu.test(value);
  return hasArtifact && hasReview && accountPhrase(value);
}

async function send(message, text, files = []) {
  await message.channel.send({ content: text, files, allowedMentions: { users: [], repliedUser: false } });
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
      ? `أقدر أقرأ ارتيفاكتات **${characterName}**، لكن ما عندي Guide موثوق كفاية حتى أحدد الـRV والـMain Stats.`
      : `I can read **${characterName}** artifacts, but I do not have a reliable guide to judge RV and main stats.`);
    return null;
  }

  return { characterName, character, guide, snapshot: getBuildSnapshot(character) };
}

async function artifactCardFile(character, characterName) {
  try {
    const buffer = await buildArtifactCard(character);
    return [{ attachment: buffer, name: `${characterName.replace(/[^a-z0-9]+/gi, '-')}-artifacts.png` }];
  } catch (error) {
    console.warn('[artifact-card] generation failed:', error.message);
    return [];
  }
}

async function handleArtifactReviewMessage(message) {
  const text = String(message?.content || '').trim();
  const doctor = isArtifactDoctor(text);
  const review = isArtifactReview(text);
  if (!doctor && !review) return false;

  const lang = language(text);
  const linked = await loadLinkedBuild(message, text, lang);
  if (!linked) return true;
  const { characterName, character, guide, snapshot } = linked;
  const files = await artifactCardFile(character, characterName);

  if (doctor) {
    const evaluation = evaluateBuild(snapshot, guide);
    await send(message, formatArtifactDoctor(snapshot, guide, evaluation, lang, text), files);
    return true;
  }

  await send(message, formatArtifactReview(snapshot, guide, lang), files);
  return true;
}

module.exports = { handleArtifactReviewMessage, isArtifactReview, isArtifactDoctor };
