'use strict';

const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { whenWishStoreReady, getWishUser, mutateWishUser } = require('./wishStore');
const { rollWishes, bannerInfo, BANNERS } = require('./wishEngine');
const { renderResultCard, renderSummary, renderInventory } = require('./wishRenderer');
const { renderGameWishGif, animationColor, animationWaitMs } = require('./wishGameAnimation');

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

async function showWish(message, count) {
  if (busyUsers.has(message.author.id)) {
    await message.reply({ content: 'عندك سحبة قيد العرض حاليًا.', allowedMentions: { repliedUser: false } });
    return;
  }
  busyUsers.add(message.author.id);
  try {
    await whenWishStoreReady();
    const results = await mutateWishUser(message.author.id, (state) => rollWishes(state, count));
    const highest = Math.max(...results.map((item) => item.rarity));
    const capture = results.some((item) => item.rarity === 5 && item.capturingRadiance);
    const endPity = results[results.length - 1]?.fivePityAfter || 0;
    let output = null;

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

    const firstCard = await renderResultCard(results[0]);
    const token = crypto.randomBytes(5).toString('hex');
    const payload = {
      content: count === 10 ? `**Wish x10** • ${endPity} pity` : `**Wish** • ${endPity} pity`,
      embeds: [],
      files: [{ attachment: firstCard, name: 'wish-result-1.png' }],
      components: count === 10 ? wishButtons(token) : [],
      attachments: [],
      allowedMentions: { repliedUser: false },
    };
    if (output) await output.edit(payload);
    else output = await message.reply(payload);
    if (count !== 10) return;

    let index = 0;
    let finished = false;
    const collector = output.createMessageComponentCollector({ time: 8 * 60 * 1000 });
    collector.on('collect', async (interaction) => {
      if (interaction.user.id !== message.author.id) {
        await interaction.reply({ content: 'أزرار السحبة تخص صاحب الأمر.', ephemeral: true }).catch(() => {});
        return;
      }
      if (finished) return interaction.deferUpdate().catch(() => {});
      await interaction.deferUpdate().catch(() => {});

      if (interaction.customId === `nlwish:skip:${token}`) {
        const summary = await renderSummary(results, endPity);
        finished = true;
        collector.stop('summary');
        await output.edit({
          content: `**Wish x10 • Summary** • ${endPity} pity`,
          embeds: [],
          files: [{ attachment: summary, name: 'wish-summary.png' }],
          attachments: [], components: [],
        }).catch(() => {});
        return;
      }

      if (interaction.customId !== `nlwish:next:${token}`) return;
      index += 1;
      if (index >= results.length) {
        const summary = await renderSummary(results, endPity);
        finished = true;
        collector.stop('done');
        await output.edit({
          content: `**Wish x10 • Summary** • ${endPity} pity`,
          embeds: [],
          files: [{ attachment: summary, name: 'wish-summary.png' }],
          attachments: [], components: [],
        }).catch(() => {});
        return;
      }
      const card = await renderResultCard(results[index]);
      await output.edit({
        content: `**${index + 1}/10** • ${results[index].name}`,
        embeds: [],
        files: [{ attachment: card, name: `wish-result-${index + 1}.png` }],
        attachments: [], components: wishButtons(token),
      }).catch(() => {});
    });
    collector.on('end', () => { if (!finished) output.edit({ components: [] }).catch(() => {}); });
  } finally {
    busyUsers.delete(message.author.id);
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
