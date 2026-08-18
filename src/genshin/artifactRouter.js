'use strict';

const { getLinkedUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot } = require('./enkaClient');
const { getGuide } = require('./guideClient');
const { resolveCharacter } = require('./characterResolver');
const { formatArtifactReview } = require('./ratingCopyV2');

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function accountPhrase(text) {
  return /بحسابي|في\s+حسابي|من\s+حسابي|my\s+account|in\s+my\s+account|on\s+my\s+account/i.test(String(text || ''));
}

function isArtifactReview(text) {
  const value = String(text || '');
  const hasArtifact = /[اآأإ]?رت[يى]فاكت(?:ات)?|artifact(?:s)?/iu.test(value);
  const hasReview = /تقييم|قيّم|قيم|حلل|راجع|rate|review|evaluate/iu.test(value);
  return hasArtifact && hasReview && accountPhrase(value);
}

async function send(message, text) {
  await message.channel.send({ content: text, allowedMentions: { users: [], repliedUser: false } });
}

async function handleArtifactReviewMessage(message) {
  const text = String(message?.content || '').trim();
  if (!isArtifactReview(text)) return false;
  const lang = language(text);
  const characterName = await resolveCharacter(text);
  if (!characterName) {
    await send(message, lang === 'ar'
      ? 'حدد اسم الشخصية، مثال: `قيم ارتيفاكتات Skirk بحسابي`.'
      : 'Include the character name, e.g. `rate Skirk artifacts on my account`.');
    return true;
  }

  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar'
      ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.'
      : 'Link your account first: `link UID 7XXXXXXXXX`.');
    return true;
  }

  let account;
  try {
    account = await fetchAccount(uid, { forceRefresh: true });
  } catch (error) {
    console.warn('[artifact-review] Enka fetch failed:', error.message);
    await send(message, lang === 'ar'
      ? 'ما قدرت أقرأ الـShowcase الآن. تأكد أن **Show Character Details** مفعّل.'
      : 'I could not read the Showcase right now. Make sure **Show Character Details** is enabled.');
    return true;
  }

  const character = findCharacter(account, characterName);
  if (!character) {
    await send(message, lang === 'ar'
      ? `**${characterName}** مو ظاهرة بالتفاصيل في الـShowcase حاليًا.`
      : `**${characterName}** is not visible with details in your Showcase.`);
    return true;
  }

  const guide = await getGuide(characterName).catch(() => null);
  if (!guide) {
    await send(message, lang === 'ar'
      ? `أقدر أقرأ ارتيفاكتات **${characterName}**، لكن ما عندي Guide موثوق كفاية حتى أحدد الـUseful RV والـMain Stats.`
      : `I can read **${characterName}** artifacts, but I do not have a reliable guide to judge Useful RV and main stats.`);
    return true;
  }

  const snapshot = getBuildSnapshot(character);
  await send(message, formatArtifactReview(snapshot, guide, lang));
  return true;
}

module.exports = { handleArtifactReviewMessage, isArtifactReview };
