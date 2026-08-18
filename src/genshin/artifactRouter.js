'use strict';

const { getLinkedUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot } = require('./enkaClient');
const { getGuide } = require('./guideClient');
const { resolveCharacter } = require('./characterResolver');
const { formatArtifactReview } = require('./ratingCopyV2');
const { formatArtifactDoctor } = require('./artifactDoctor');
const { buildArtifactCard } = require('./artifactCard');
const { evaluateBuild } = require('./buildEvaluator');
const {
  slotFromText,
  recognizeArtifactAttachment,
  scoreCandidateArtifact,
  formatPickerResult,
} = require('./artifactImagePicker');

const PICKER_TTL = 20 * 60 * 1000;
const pickerSessions = new Map();

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

function isArtifactDoctor(text) {
  const value = String(text || '');
  const hasImprove = /تحسين|حس[ّ]?ن|طور|طوّر|رفع|ارفع|أرفع|improve|upgrade|doctor|increase|raise/iu.test(value);
  return hasArtifactWord(value) && hasImprove;
}

function isArtifactReview(text) {
  const value = String(text || '');
  const hasReview = /تقييم|قيّم|قيم|حلل|راجع|rate|review|evaluate/iu.test(value);
  return hasArtifactWord(value) && hasReview && accountPhrase(value);
}

function isArtifactPicker(text) {
  const value = String(text || '');
  const choose = /أفضل|افضل|اختيار|اختر|اختار|قارن|best|pick|choose|compare/iu.test(value);
  return hasArtifactWord(value) && choose;
}

function isPickerCancel(text) {
  return /(?:الغاء|إلغاء|وقف|انهاء|إنهاء).*(?:اختيار|ارتيفاكت)|cancel.*artifact/iu.test(String(text || ''));
}

function sessionKey(message) {
  return `${message?.guildId || 'dm'}:${message?.author?.id || 'unknown'}`;
}

function getPickerSession(message) {
  const key = sessionKey(message);
  const session = pickerSessions.get(key);
  if (!session) return null;
  if (Date.now() - session.updatedAt > PICKER_TTL) {
    pickerSessions.delete(key);
    return null;
  }
  const channelId = message?.channel?.id || message?.channelId;
  if (session.channelId && channelId && String(session.channelId) !== String(channelId)) return null;
  return session;
}

function hasArtifactPickerSession(message) {
  return Boolean(getPickerSession(message));
}

function imageAttachments(message) {
  const values = message?.attachments?.values ? [...message.attachments.values()] : [];
  return values.filter((item) => {
    const type = String(item?.contentType || '');
    const name = String(item?.name || '');
    return type.startsWith('image/') || /\.(?:png|jpe?g|webp)$/i.test(name);
  }).slice(0, 10);
}

async function send(message, text, files = []) {
  await message.channel.send({ content: text, files, allowedMentions: { users: [], repliedUser: false } });
}

async function loadLinkedBuild(message, text, lang, forcedCharacter = null) {
  const characterName = forcedCharacter || await resolveCharacter(text);
  if (!characterName) {
    await send(message, lang === 'ar'
      ? 'حدد اسم الشخصية، مثال: `قيم ارتيفاكتات Skirk بحسابي` أو `تحسين ارتيفاكتات Skirk`.'
      : 'Include the character name, e.g. `rate Skirk artifacts on my account` or `improve Skirk artifacts`.');
    return null;
  }

  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar' ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.' : 'Link your account first: `link UID 7XXXXXXXXX`.');
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

  return { uid, characterName, character, guide, snapshot: getBuildSnapshot(character) };
}

async function artifactCardFile(character, snapshot, guide, characterName) {
  try {
    const buffer = await buildArtifactCard(character, snapshot, guide);
    return [{ attachment: buffer, name: `${characterName.replace(/[^a-z0-9]+/gi, '-')}-artifacts.png` }];
  } catch (error) {
    console.warn('[artifact-card] generation failed:', error.message);
    return [];
  }
}

function pickerPrompt(session, lang) {
  const label = session.slot[0].toUpperCase() + session.slot.slice(1);
  return lang === 'ar'
    ? `**Artifact Picker — ${session.characterName} / ${label}**\nأرسل من **1 إلى 10 صور** للـ${label}. خلي تفاصيل القطعة ظاهرة: Main Stat، الأربع Substats والـSet. ما تحتاج تمنشن البوت في رسالة الصور التالية.\nبعد الاختيار تقدر تكتب Slot ثاني مثل \`Goblet\` أو \`Circlet\` وتكمل نفس الجلسة.`
    : `**Artifact Picker — ${session.characterName} / ${label}**\nSend **1–10 screenshots** with the main stat, four substats and set visible. You do not need to mention the bot in the next image message. Then switch slots with a word such as \`Goblet\` or \`Circlet\`.`;
}

async function processPickerImages(message, session, lang) {
  const images = imageAttachments(message);
  if (!images.length) {
    await send(message, pickerPrompt(session, lang));
    return true;
  }

  const parsed = [];
  for (let index = 0; index < images.length; index += 1) {
    try {
      const result = await recognizeArtifactAttachment(images[index], session.guide, session.slot);
      if (!result.ok) {
        parsed.push({ index, valid: false, reason: result.reason });
        continue;
      }
      const scored = scoreCandidateArtifact(result.artifact, session.snapshot, session.guide, session.evaluation, session.slot);
      parsed.push({ ...scored, index, artifact: result.artifact });
    } catch (error) {
      console.warn('[artifact-picker] OCR failed:', error.message);
      parsed.push({ index, valid: false, reason: error.message });
    }
  }

  const valid = parsed.filter((row) => row.valid).sort((a, b) => b.score - a.score);
  if (!valid.length) {
    const wrongMain = parsed.filter((row) => row.reason === 'WRONG_MAIN').length;
    await send(message, lang === 'ar'
      ? `ما قدرت أطلع قطعة صالحة من الصور.${wrongMain ? ` ${wrongMain} صورة كان الـMain Stat فيها غير مناسب للبيلد.` : ''}\nجرّب صور أوضح مثل شاشة تفاصيل الارتيفاكت، وخلي اسم الـSet والـSubstats ظاهرين كامل.`
      : 'I could not get a valid candidate from the images. Try clearer artifact detail screenshots with the set and all substats visible.');
    return true;
  }

  const best = valid[0];
  session.snapshot = best.projected;
  session.selected[session.slot] = best.artifact;
  session.updatedAt = Date.now();
  pickerSessions.set(sessionKey(message), session);

  await send(message, formatPickerResult(best, parsed, session.snapshot, session.guide, lang));
  return true;
}

async function startPicker(message, text, lang) {
  const slot = slotFromText(text);
  if (!slot) {
    await send(message, lang === 'ar'
      ? 'حدد نوع القطعة داخل الأمر: `Flower` أو `Plume` أو `Sands` أو `Goblet` أو `Circlet`. مثال: `اختر أفضل Circlet لـ Skirk`.'
      : 'Include the slot: Flower, Plume, Sands, Goblet, or Circlet.');
    return true;
  }

  const linked = await loadLinkedBuild(message, text, lang);
  if (!linked) return true;
  const evaluation = evaluateBuild(linked.snapshot, linked.guide);
  const session = {
    uid: linked.uid,
    characterName: linked.characterName,
    guide: linked.guide,
    evaluation,
    originalSnapshot: linked.snapshot,
    snapshot: linked.snapshot,
    selected: {},
    slot,
    channelId: message?.channel?.id || message?.channelId,
    updatedAt: Date.now(),
  };
  pickerSessions.set(sessionKey(message), session);
  return processPickerImages(message, session, lang);
}

async function handleArtifactReviewMessage(message) {
  const text = String(message?.content || '').trim();
  const session = getPickerSession(message);
  const attachments = imageAttachments(message);
  const lang = language(text || session?.language || 'ar');

  if (session && attachments.length) return processPickerImages(message, session, lang);

  if (session && isPickerCancel(text)) {
    pickerSessions.delete(sessionKey(message));
    await send(message, lang === 'ar' ? 'تم إنهاء جلسة اختيار الارتيفاكتات.' : 'Artifact picker session ended.');
    return true;
  }

  if (session && !hasArtifactWord(text)) {
    const nextSlot = slotFromText(text);
    if (nextSlot) {
      session.slot = nextSlot;
      session.updatedAt = Date.now();
      pickerSessions.set(sessionKey(message), session);
      await send(message, pickerPrompt(session, lang));
      return true;
    }
  }

  if (isArtifactPicker(text)) return startPicker(message, text, lang);

  const doctor = isArtifactDoctor(text);
  const review = isArtifactReview(text);
  if (!doctor && !review) return false;

  const linked = await loadLinkedBuild(message, text, lang);
  if (!linked) return true;
  const { characterName, character, guide, snapshot } = linked;
  const files = await artifactCardFile(character, snapshot, guide, characterName);

  if (doctor) {
    const evaluation = evaluateBuild(snapshot, guide);
    await send(message, formatArtifactDoctor(snapshot, guide, evaluation, lang, text), files);
    return true;
  }

  await send(message, formatArtifactReview(snapshot, guide, lang), files);
  return true;
}

module.exports = {
  handleArtifactReviewMessage,
  hasArtifactPickerSession,
  isArtifactReview,
  isArtifactDoctor,
  isArtifactPicker,
  hasArtifactWord,
};
