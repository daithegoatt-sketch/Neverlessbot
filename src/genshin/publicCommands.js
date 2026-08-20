'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { getBannerNotice } = require('./bannerClient');
const { findQuestVideo } = require('./questClient');
const { fetchActiveCodes } = require('./codesClient');

const REDEEM_URL = 'https://genshin.hoyoverse.com/en/gift';

function clean(value) {
  return String(value || '').trim();
}

function prefixBody(text) {
  const value = clean(text).replace(/\s+/g, ' ');
  if (!/^[-–—]/.test(value)) return null;
  return value.replace(/^[-–—]\s*/, '').trim();
}

function parseBannerCommand(text) {
  const body = prefixBody(text);
  if (!body) return null;
  const lower = body.toLowerCase();
  const weapon = /(?:اسلح|أسلح|weapon)/iu.test(body);
  const upcoming = /(?:القادم|الجاي|القادمة|الجايه|الجايّة|upcoming|coming|next)/iu.test(body);
  const arabicBanner = /^(?:ال)?(?:بنر|بانر)(?:\s|$)/u.test(body);
  const englishBanner = /^(?:banner|weapon\s+banner)(?:\s|$)/i.test(lower)
    || /^(?:upcoming|coming|next)\s+(?:weapon\s+)?banner(?:\s|$)/i.test(lower);
  if (!arabicBanner && !englishBanner) return null;
  return { type: weapon ? 'weapon' : 'character', mode: upcoming ? 'upcoming' : 'current' };
}

function parseQuestCommand(text) {
  const value = clean(text);
  const match = value.match(/^[-–—]\s*(?:كويست|quest)\s+(.+)$/iu);
  if (!match) return null;
  const quest = match[1].trim().replace(/^['"“”]+|['"“”]+$/g, '').trim();
  return quest ? { quest: quest.slice(0, 160) } : null;
}

function parseCodeCommand(text) {
  const body = prefixBody(text);
  if (!body) return null;
  return /^(?:كود|أكواد|اكواد|codes?)$/iu.test(body) ? { type: 'codes' } : null;
}

function parseBannerCountdownCommand(text) {
  const body = prefixBody(text);
  if (!body) return null;
  return /^(?:كم\s+(?:باقي|متبقي)\s+(?:على\s+)?(?:ال)?(?:بنر|بانر)|(?:banner\s+)?countdown|banner\s+time\s+left|time\s+left\s+(?:on\s+)?(?:the\s+)?banner)$/iu.test(body)
    ? { type: 'countdown' }
    : null;
}

function parseRedeemCommand(text) {
  const body = prefixBody(text);
  if (!body) return null;
  const match = body.match(/^(?:ريديم|redeem)(?:\s+([A-Za-z0-9_-]{4,40}))?$/iu);
  if (!match) return null;
  return { code: match[1] || null };
}

function isPublicGenshinCommand(text) {
  return Boolean(
    parseBannerCountdownCommand(text)
    || parseCodeCommand(text)
    || parseRedeemCommand(text)
    || parseBannerCommand(text)
    || parseQuestCommand(text)
  );
}

function shouldHandlePublicMessage(message) {
  return Boolean(message?.guildId && !message.author?.bot && isPublicGenshinCommand(message.content));
}

function formatNames(rows, rarity) {
  if (!rows?.length) return `${rarity}: غير معلن/غير متوفر في المصدر`;
  return `${rarity}: ${rows.map((row) => row.name).join(' • ')}`;
}

function buildBannerEmbeds(notice, request) {
  const upcoming = request.mode === 'upcoming';
  const weapon = request.type === 'weapon';
  const title = weapon
    ? (upcoming ? 'بنر الأسلحة القادم' : 'بنر الأسلحة الحالي')
    : (upcoming ? 'البنر القادم' : 'البنر الحالي');

  const lines = [];
  if (weapon) {
    lines.push(formatNames(notice.fiveWeapons, '**5★**'));
    lines.push(formatNames(notice.fourWeapons, '**4★**'));
  } else {
    lines.push(formatNames(notice.fiveCharacters, '**5★**'));
    lines.push(formatNames(notice.fourCharacters, '**4★**'));
  }
  lines.push('', 'المصدر: **Genshin Impact Official — HoYoLAB**');

  const main = new EmbedBuilder()
    .setColor(0x15233a)
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setURL(notice.sourceUrl)
    .setFooter({ text: notice.subject || 'Official Event Wishes Notice' });

  const images = notice.images || [];
  if (images.length) {
    if (weapon) {
      const charImageCount = Math.max(1, Math.min(2, notice.fiveCharacters?.length || 1));
      const image = images[charImageCount] || images.at(-1) || images[0];
      if (image) main.setImage(image);
    } else if (images[0]) {
      main.setImage(images[0]);
    }
  }

  const embeds = [main];
  if (!weapon && (notice.fiveCharacters?.length || 0) > 1 && images[1]) {
    embeds.push(new EmbedBuilder()
      .setColor(0x15233a)
      .setTitle(`${notice.fiveCharacters[1].name} — Event Wish`)
      .setURL(notice.sourceUrl)
      .setImage(images[1]));
  }
  return embeds;
}

function redeemButton(code = null) {
  const url = code ? `${REDEEM_URL}?code=${encodeURIComponent(code)}` : REDEEM_URL;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(code ? `Redeem ${code}` : 'Official Redeem').setURL(url),
  );
}

async function handleBanner(message, request) {
  let notice;
  try {
    notice = await getBannerNotice(request.mode);
  } catch (error) {
    console.warn('[banner] lookup failed:', error.message);
  }
  if (!notice) {
    const text = request.mode === 'upcoming'
      ? 'ما فيه بنر قادم معلن رسميًا أقدر أثبته حاليًا. إذا HoYoLAB أعلن عنه بيظهر هنا.'
      : 'ما قدرت أجيب بيانات البنر الرسمي حاليًا. جرّب بعد شوي.';
    await message.reply({ content: text, allowedMentions: { repliedUser: false } });
    return true;
  }
  await message.reply({ embeds: buildBannerEmbeds(notice, request), allowedMentions: { repliedUser: false } });
  return true;
}

async function handleQuest(message, request) {
  const result = await findQuestVideo(request.quest);
  if (!result) {
    await message.reply({ content: `ما لقيت شرح واضح لـ **${request.quest}** حاليًا.`, allowedMentions: { repliedUser: false } });
    return true;
  }
  const label = result.direct ? 'شرح فيديو مباشر' : 'نتائج بحث YouTube';
  await message.reply({
    content: `**${request.quest}**\n${label}: ${result.title}\n${result.url}`,
    allowedMentions: { repliedUser: false },
  });
  return true;
}

async function handleCodes(message) {
  let codes;
  try {
    codes = await fetchActiveCodes();
  } catch (error) {
    console.warn('[codes] lookup failed:', error.message);
    await message.reply({ content: 'ما قدرت أتحقق من الأكواد الفعالة حاليًا. جرّب بعد شوي.', allowedMentions: { repliedUser: false } });
    return true;
  }
  if (!codes.length) {
    await message.reply({ content: 'ما فيه أكواد فعالة مؤكدة بالمصدر حاليًا.', components: [redeemButton()], allowedMentions: { repliedUser: false } });
    return true;
  }
  const lines = codes.slice(0, 20).map((row) => {
    const rewards = row.rewards.length ? ` — ${row.rewards.join(' • ')}` : '';
    return `**\`${row.code}\`**${rewards}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x15233a)
    .setTitle('أكواد Genshin الفعالة')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'يعرض Neverless فقط الأكواد المصنفة Active وقت الطلب.' });
  await message.reply({ embeds: [embed], components: [redeemButton()], allowedMentions: { repliedUser: false } });
  return true;
}

function remainingText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'انتهى';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [days ? `${days} يوم` : null, hours ? `${hours} ساعة` : null, `${minutes} دقيقة`].filter(Boolean).join(' و ');
}

async function handleBannerCountdown(message) {
  let notice;
  try { notice = await getBannerNotice('current'); } catch (error) { console.warn('[banner-countdown] lookup failed:', error.message); }
  if (!notice || !Number.isFinite(notice.endAt)) {
    await message.reply({ content: 'ما عندي وقت نهاية رسمي واضح للبنر الحالي الآن.', allowedMentions: { repliedUser: false } });
    return true;
  }
  const now = Date.now();
  const names = notice.fiveCharacters?.map((row) => row.name).filter(Boolean) || [];
  const unix = Math.floor(notice.endAt / 1000);
  const title = names.length ? names.join(' • ') : 'البنر الحالي';
  await message.reply({
    content: `**${title}**\nباقي تقريبًا **${remainingText(notice.endAt - now)}**.\nينتهي <t:${unix}:R> • <t:${unix}:f>\nالمصدر: Genshin Impact Official — HoYoLAB`,
    allowedMentions: { repliedUser: false },
  });
  return true;
}

async function handleRedeem(message, request) {
  const codeText = request.code ? ` للكود **\`${request.code}\`**` : '';
  await message.reply({
    content: `رابط الاسترداد الرسمي من HoYoverse${codeText}:`,
    components: [redeemButton(request.code)],
    allowedMentions: { repliedUser: false },
  });
  return true;
}

async function handlePublicGenshinCommand(message) {
  const countdown = parseBannerCountdownCommand(message.content);
  if (countdown) return handleBannerCountdown(message);
  const code = parseCodeCommand(message.content);
  if (code) return handleCodes(message);
  const redeem = parseRedeemCommand(message.content);
  if (redeem) return handleRedeem(message, redeem);
  const banner = parseBannerCommand(message.content);
  if (banner) return handleBanner(message, banner);
  const quest = parseQuestCommand(message.content);
  if (quest) return handleQuest(message, quest);
  return false;
}

function installPublicGenshinCommands(client) {
  if (client.__neverlessPublicGenshinInstalled) return;
  client.__neverlessPublicGenshinInstalled = true;
  client.on('messageCreate', (message) => {
    if (!shouldHandlePublicMessage(message)) return;
    handlePublicGenshinCommand(message).catch((error) => {
      console.error('[genshin-public] command failed:', error);
      message.reply({ content: 'صار خطأ أثناء جلب المعلومات. جرّب بعد شوي.', allowedMentions: { repliedUser: false } }).catch(() => {});
    });
  });
}

module.exports = {
  installPublicGenshinCommands,
  handlePublicGenshinCommand,
  isPublicGenshinCommand,
  shouldHandlePublicMessage,
  parseBannerCommand,
  parseQuestCommand,
  parseCodeCommand,
  parseBannerCountdownCommand,
  parseRedeemCommand,
  buildBannerEmbeds,
  remainingText,
};
