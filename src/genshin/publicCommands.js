'use strict';

const { EmbedBuilder } = require('discord.js');
const { getBannerNotice } = require('./bannerClient');
const { findQuestVideo } = require('./questClient');

function clean(value) {
  return String(value || '').trim();
}

function parseBannerCommand(text) {
  const value = clean(text).replace(/\s+/g, ' ');
  if (!/^[-–—]/.test(value)) return null;
  const body = value.replace(/^[-–—]\s*/, '').trim();
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

function isPublicGenshinCommand(text) {
  return Boolean(parseBannerCommand(text) || parseQuestCommand(text));
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

async function handlePublicGenshinCommand(message) {
  const banner = parseBannerCommand(message.content);
  if (banner) return handleBanner(message, banner);
  const quest = parseQuestCommand(message.content);
  if (quest) return handleQuest(message, quest);
  return false;
}

function installPublicGenshinCommands(client, allowedChannels) {
  if (client.__neverlessPublicGenshinInstalled) return;
  client.__neverlessPublicGenshinInstalled = true;
  const channels = allowedChannels instanceof Set ? allowedChannels : new Set(allowedChannels || []);
  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot || !channels.has(message.channelId)) return;
    if (!isPublicGenshinCommand(message.content)) return;
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
  parseBannerCommand,
  parseQuestCommand,
  buildBannerEmbeds,
};
