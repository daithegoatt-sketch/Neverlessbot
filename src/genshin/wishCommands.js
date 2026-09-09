'use strict';

const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { whenWishStoreReady, getWishUser, mutateWishUser } = require('./wishStore');
const { rollWishes, bannerInfo, BANNERS } = require('./wishEngine');
const { renderInventory } = require('./wishRenderer');
const { renderGameWishGif, animationColor, animationWaitMs } = require('./wishGameAnimation');
const { getOfficialRevealInfo, renderOfficialRevealGif, renderOfficialSummary } = require('./wishOfficialReveal');

const busyUsers = new Set();

function wishButtons(token) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nlwish:next:${token}`).setEmoji('➡️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`nlwish:skip:${token}`).setEmoji('⏩').setStyle(ButtonStyle.Secondary),
  )];
}

function bannerButtons(token, current) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nlwish:banner:${token}:flins`).setLabel(current === 'flins' ? '✓ Flins' : 'Flins').setStyle(current === 'flins' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`nlwish:banner:${token}:ineffa`).setLabel(current === 'ineffa' ? '✓ Ineffa' : 'Ineffa').setStyle(current === 'ineffa' ? ButtonStyle.Success : ButtonStyle.Secondary),
  )];
}

async function revealPayload(item, index, total, token = null) {
  const [gif, info] = await Promise.all([
    renderOfficialRevealGif(item),
    getOfficialRevealInfo(item),
  ]);
  const filename = `wish-reveal-${index + 1}.gif`;
  const embed = new EmbedBuilder()
    .setColor(info.embedColor)
    .setTitle(`${item.name} (${index + 1}/${total})`)
    .setDescription(`${'⭐'.repeat(item.rarity)}${info.description ? `\n\n${info.description}` : ''}`)
    .setImage(`attachment://${filename}`)
    .setFooter({ text: `${item.fivePityAfter ?? 0} pity` });
  return {
    content: '',
    embeds: [embed],
    files: [{ attachment: gif, name: filename }],
    attachments: [],
    components: total === 10 && token ? wishButtons(token) : [],
    allowedMentions: { repliedUser: false },
  };
}

async function summaryPayload(results, endPity) {
  const summary = await renderOfficialSummary(results);
  const embed = new EmbedBuilder()
    .setColor(0xf1d875)
    .setTitle('Summary')
    .setImage('attachment://wish-summary.png')
    .setFooter({ text: `${endPity} pity` });
  return {
    content: '',
    embeds: [embed],
    files: [{ attachment: summary, name: 'wish-summary.png' }],
    attachments: [],
    components: [],
  };
}

async function showWish(message, count) {
  if (busyUsers.has(message.author.id)) {
    await message.reply({ content: 'عندك سحبة قيد العرض حاليًا.', allowedMentions: { repliedUser: false } });
    return;
  }
  busyUsers.add(message.author.id);
  let collector = null;
  try {
    await whenWishStoreReady();
    const results = await mutateWishUser(message.author.id, (state) => rollWishes(state, count));
    const highest = Math.max(...results.map((item) => item.rarity));
    const capture = results.some((item) => item.rarity === 5 && item.capturingRadiance);
    const endPity = results[results.length - 1]?.fivePityAfter || 0;
    const token = crypto.randomBytes(5).toString('hex');
    let output = null;

    // Start preparing the first real item reveal while the meteor animation is playing.
    let preparedReveal = revealPayload(results[0], 0, results.length, count === 10 ? token : null);

    await message.channel.sendTyping().catch(() => {});
    try {
      const animation = await renderGameWishGif(highest, count, capture);
      const animationEmbed = new EmbedBuilder()
        .setColor(animationColor(highest, capture))
        .setImage('attachment://wish-animation.gif');
      output = await message.reply({
        embeds: [animationEmbed],
        files: [{ attachment: animation, name: 'wish-animation.gif' }],
        allowedMentions: { repliedUser: false },
      });
      await new Promise((resolve) => setTimeout(resolve, animationWaitMs(capture)));
    } catch (error) {
      console.warn(`[wish] game animation fallback: ${error.message}`);
    }

    let firstPayload;
    try {
      firstPayload = await preparedReveal;
    } catch (error) {
      console.warn(`[wish] item reveal unavailable for ${results[0].name}: ${error.message}`);
      const info = await getOfficialRevealInfo(results[0]);
      firstPayload = {
        content: `**${results[0].name}**\n${'⭐'.repeat(results[0].rarity)}\n${results[0].fivePityAfter ?? 0} pity`,
        embeds: info.description ? [new EmbedBuilder().setColor(info.embedColor).setDescription(info.description)] : [],
        files: [], attachments: [], components: count === 10 ? wishButtons(token) : [],
      };
    }
    if (output) await output.edit(firstPayload);
    else output = await message.reply(firstPayload);
    if (count !== 10) return;

    let index = 0;
    let finished = false;
    let nextPrepared = results[1] ? revealPayload(results[1], 1, 10, token) : null;
    collector = output.createMessageComponentCollector({ time: 8 * 60 * 1000 });
    collector.on('collect', async (interaction) => {
      if (interaction.user.id !== message.author.id) {
        await interaction.reply({ content: 'أزرار السحبة تخص صاحب الأمر.', ephemeral: true }).catch(() => {});
        return;
      }
      if (finished) return interaction.deferUpdate().catch(() => {});
      await interaction.deferUpdate().catch(() => {});

      if (interaction.customId === `nlwish:skip:${token}`) {
        finished = true;
        collector.stop('summary');
        const payload = await summaryPayload(results, endPity).catch((error) => {
          console.warn(`[wish] summary render failed: ${error.message}`);
          return { content: `**Summary** • ${endPity} pity`, embeds: [], files: [], attachments: [], components: [] };
        });
        await output.edit(payload).catch(() => {});
        return;
      }

      if (interaction.customId !== `nlwish:next:${token}`) return;
      index += 1;
      if (index >= results.length) {
        finished = true;
        collector.stop('done');
        const payload = await summaryPayload(results, endPity).catch((error) => {
          console.warn(`[wish] summary render failed: ${error.message}`);
          return { content: `**Summary** • ${endPity} pity`, embeds: [], files: [], attachments: [], components: [] };
        });
        await output.edit(payload).catch(() => {});
        return;
      }

      let payload;
      try {
        payload = nextPrepared ? await nextPrepared : await revealPayload(results[index], index, 10, token);
      } catch (error) {
        console.warn(`[wish] item reveal unavailable for ${results[index].name}: ${error.message}`);
        const info = await getOfficialRevealInfo(results[index]);
        payload = {
          content: `**${results[index].name} (${index + 1}/10)**\n${'⭐'.repeat(results[index].rarity)}\n${results[index].fivePityAfter ?? 0} pity`,
          embeds: info.description ? [new EmbedBuilder().setColor(info.embedColor).setDescription(info.description)] : [],
          files: [], attachments: [], components: wishButtons(token),
        };
      }
      await output.edit(payload).catch(() => {});
      nextPrepared = results[index + 1] ? revealPayload(results[index + 1], index + 1, 10, token) : null;
      nextPrepared?.catch(() => {});
    });
    collector.on('end', () => {
      if (!finished) output.edit({ components: [] }).catch(() => {});
      busyUsers.delete(message.author.id);
    });
  } finally {
    // A 10-pull remains busy until its collector ends, preventing concurrent displays for one user.
    if (!collector) busyUsers.delete(message.author.id);
  }
}

async function showInventory(message, type) {
  await whenWishStoreReady();
  const state = getWishUser(message.author.id);
  const isCharacters = type === 'characters';
  const image = await renderInventory(
    `${message.member?.displayName || message.author.username}'s ${isCharacters ? 'Characters' : 'Weapons'}`,
    isCharacters ? state.characters : state.weapons,
    isCharacters ? 'character' : 'weapon',
  );
  await message.reply({ files: [{ attachment: image, name: `wish-${type}.png` }], allowedMentions: { repliedUser: false } });
}

async function showBanner(message, requested) {
  await whenWishStoreReady();
  if (requested && BANNERS[requested]) await mutateWishUser(message.author.id, (state) => { state.banner = requested; });
  const current = getWishUser(message.author.id).banner;
  const info = bannerInfo(current);
  const token = crypto.randomBytes(5).toString('hex');
  const embed = new EmbedBuilder()
    .setColor(0x657ad9)
    .setTitle('Neverless Character Event Wish')
    .setDescription(`Current banner: **${info.featured5}**\n${info.name}\n\n4★ rate-up: ${info.featured4.join(' • ')}`)
    .setFooter({ text: 'Character Event Wish pity is shared between the two current banners.' });
  const output = await message.reply({ embeds: [embed], components: bannerButtons(token, current), allowedMentions: { repliedUser: false } });
  const collector = output.createMessageComponentCollector({ time: 3 * 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) return interaction.reply({ content: 'اختيار البنر يخص صاحب الأمر.', ephemeral: true }).catch(() => {});
    const key = interaction.customId.split(':').pop();
    if (!BANNERS[key]) return interaction.deferUpdate().catch(() => {});
    await interaction.deferUpdate().catch(() => {});
    await mutateWishUser(message.author.id, (state) => { state.banner = key; });
    const next = bannerInfo(key);
    embed.setDescription(`Current banner: **${next.featured5}**\n${next.name}\n\n4★ rate-up: ${next.featured4.join(' • ')}`);
    await output.edit({ embeds: [embed], components: bannerButtons(token, key) }).catch(() => {});
  });
  collector.on('end', () => output.edit({ components: [] }).catch(() => {}));
}

module.exports = { showWish, showInventory, showBanner };
