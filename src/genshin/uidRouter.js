'use strict';

const { getLinkedUid, getAllLinkedUsers, linkUid, unlinkUid } = require('./accountStore');
const { fetchAccount, accountSummary } = require('./enkaClient');
const { clearLeaderboardCache } = require('./leaderboard');

let claimQueue = Promise.resolve();

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function uidFrom(text) {
  return String(text || '').match(/\b\d{9,10}\b/)?.[0] || null;
}

function isLink(text) {
  const value = String(text || '').trim();
  return /ربط/iu.test(value) || /\blink\b/i.test(value) || /^uid\b/i.test(value);
}

function isUnlink(text) {
  return /فك\s*(?:ربط)?|الغاء\s*ربط|إلغاء\s*ربط|\bunlink\b|remove\s+uid/iu.test(String(text || ''));
}

function isBareLinkPrompt(text) {
  return /^\s*(?:ربط|link|uid)\s*$/iu.test(String(text || ''));
}

function needsLinkedAccount(text) {
  return /بحسابي|في\s+حسابي|من\s+حسابي|my\s+account|in\s+my\s+account|on\s+my\s+account|شخصياتي|شخصيات\s+حسابي|my\s+characters|my\s+showcase/iu.test(String(text || ''));
}

function findOwner(uid) {
  return getAllLinkedUsers().find((row) => String(row.uid) === String(uid)) || null;
}

async function send(message, content) {
  await message.channel.send({
    content,
    allowedMentions: { users: [], repliedUser: false },
  });
}

function linkPrompt(lang) {
  return lang === 'ar'
    ? 'ارسل UID حسابك بهالشكل: `ربط UID 7XXXXXXXXX`.'
    : 'Send your account UID like this: `link UID 7XXXXXXXXX`.';
}

async function claim(message, uid, lang) {
  const userId = String(message.author.id);
  const current = getLinkedUid(userId);

  if (current) {
    if (String(current) === String(uid)) {
      await send(message, lang === 'ar'
        ? `حسابك مربوط به UID **${uid}** بالفعل.`
        : `Your account is already linked to UID **${uid}**.`);
      return;
    }
    await send(message, lang === 'ar'
      ? 'أنت رابط حساب بالفعل. إذا الـUID الحالي غلط استخدم `فك ربط UID` أول، وبعدها اربط الصحيح.'
      : 'You already have a linked account. Use `unlink UID` first if it is wrong, then link the correct one.');
    return;
  }

  const owner = findOwner(uid);
  if (owner && owner.discordUserId !== userId) {
    await send(message, lang === 'ar'
      ? 'هذا الـUID مربوط بعضو ثاني بالفعل. إذا تعتقد أنه مربوط بالغلط كلم الإدارة.'
      : 'That UID is already linked to another member. Contact an admin if you believe it was claimed by mistake.');
    return;
  }

  let account;
  try {
    account = await fetchAccount(uid);
  } catch (error) {
    console.warn('[genshin-uid] link validation failed:', error.message);
    await send(message, lang === 'ar'
      ? 'ما قدرت أقرأ هذا الـUID من Enka. تأكد من الرقم وحاول مرة ثانية.'
      : 'I could not read that UID from Enka. Check the number and try again.');
    return;
  }

  // Serialize the final ownership check + write so two users cannot claim the same UID at once.
  // Recover from a previous failed operation so one transient Discord/storage failure never poisons the queue.
  const operation = claimQueue
    .catch(() => {})
    .then(async () => {
      const nowCurrent = getLinkedUid(userId);
      const nowOwner = findOwner(uid);
      if (nowCurrent && String(nowCurrent) !== String(uid)) {
        await send(message, lang === 'ar'
          ? 'صار عندك حساب مربوط بالفعل. فك الربط أول إذا تبي تغيره.'
          : 'You already have a linked account. Unlink it first if you want to change it.');
        return;
      }
      if (nowOwner && nowOwner.discordUserId !== userId) {
        await send(message, lang === 'ar'
          ? 'هذا الـUID تم ربطه بعضو ثاني بالفعل.'
          : 'That UID has already been linked to another member.');
        return;
      }

      await linkUid(userId, uid);
      clearLeaderboardCache();
      const summary = accountSummary(account);
      const suggested = summary.suggestedCharacter || summary.characters[0]?.name || null;
      const visible = summary.characters.length;
      if (lang === 'ar') {
        const next = visible && suggested
          ? `\nجرّب: \`شخصياتي\` أو \`تقييم ${suggested} بحسابي\`.`
          : '\nفعّل **Show Character Details** وحط الشخصية في الـShowcase عشان أقدر أحللها.';
        await send(message, `تم ربط **${summary.nickname || uid}** — AR ${summary.adventureRank ?? '?'} — UID **${uid}**.${next}`);
      } else {
        const next = visible && suggested
          ? ` Try \`my characters\` or \`rate ${suggested} on my account\`.`
          : ' Enable **Show Character Details** and add the character to Showcase for analysis.';
        await send(message, `Linked **${summary.nickname || uid}** — AR ${summary.adventureRank ?? '?'} — UID **${uid}**.${next}`);
      }
    });

  claimQueue = operation;
  await operation;
}

async function handleUidMessage(message) {
  const text = String(message?.content || '').trim();
  if (!text) return false;
  const lang = language(text);
  const uid = uidFrom(text);

  if (isUnlink(text)) {
    const current = getLinkedUid(message.author.id);
    if (!current) {
      await send(message, lang === 'ar' ? 'ما عندك UID مربوط حاليًا.' : 'You do not have a linked UID right now.');
      return true;
    }
    // Regular members can only release their own claim. Admin force-unlink is a slash command.
    if (uid && String(uid) !== String(current)) {
      await send(message, lang === 'ar'
        ? 'تقدر تفك فقط الـUID المربوط بحسابك. الإدارة تقدر تحل تعارضات الـUID.'
        : 'You can only unlink the UID attached to your own account. Admins can resolve UID conflicts.');
      return true;
    }
    await unlinkUid(message.author.id);
    clearLeaderboardCache();
    await send(message, lang === 'ar' ? 'تم فك ربط حساب Genshin.' : 'Genshin UID unlinked.');
    return true;
  }

  if (isBareLinkPrompt(text)) {
    await send(message, linkPrompt(lang));
    return true;
  }

  if (uid && isLink(text)) {
    await claim(message, uid, lang);
    return true;
  }

  if (isLink(text) && !uid) {
    await send(message, linkPrompt(lang));
    return true;
  }

  if (needsLinkedAccount(text) && !getLinkedUid(message.author.id)) {
    await send(message, lang === 'ar'
      ? `ما ربطت حسابك للحين. ${linkPrompt('ar')}`
      : `You have not linked an account yet. ${linkPrompt('en')}`);
    return true;
  }

  return false;
}

module.exports = { handleUidMessage, uidFrom, isLink, isUnlink, needsLinkedAccount };
