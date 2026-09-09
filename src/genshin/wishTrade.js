'use strict';

const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { whenWishStoreReady, getWishUser, mutateWishPair } = require('./wishStore');
const { itemData } = require('./wishRenderer');

const TRADE_TTL_MS = 10 * 60 * 1000;

function cleanQuoted(value) {
  return String(value || '').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
}

function parseItemSpec(value) {
  let text = cleanQuoted(value);
  let quantity = 1;
  let match = text.match(/^(\d{1,2})\s*[x×]\s*(.+)$/i);
  if (match) {
    quantity = Number(match[1]);
    text = cleanQuoted(match[2]);
  } else {
    match = text.match(/^(.+?)\s*[x×]\s*(\d{1,2})$/i);
    if (match) {
      text = cleanQuoted(match[1]);
      quantity = Number(match[2]);
    }
  }
  if (!text || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return null;
  return { query: text, quantity };
}

function normalizeName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function inventoryMatch(inventory, query) {
  const target = normalizeName(query);
  if (!target) return null;
  const names = Object.keys(inventory || {}).filter((name) => Number(inventory[name]) > 0);
  const exact = names.find((name) => normalizeName(name) === target);
  if (exact) return exact;
  const starts = names.filter((name) => normalizeName(name).startsWith(target));
  return starts.length === 1 ? starts[0] : null;
}

function parseTrade(message) {
  const target = message.mentions?.users?.find?.((user) => !user.bot && user.id !== message.author.id) || null;
  if (!target) return null;
  const raw = String(message.content || '').trim();
  const mentionPattern = new RegExp(`<@!?${target.id}>`);
  const match = mentionPattern.exec(raw);
  if (!match) return null;
  const before = raw.slice(0, match.index).replace(/^trade\s*/i, '').trim();
  const after = raw.slice(match.index + match[0].length).trim();
  const offer = parseItemSpec(before);
  const request = parseItemSpec(after);
  return offer && request ? { target, offer, request } : null;
}

function tradeButtons(token) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nlwish:trade:${token}:accept`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`nlwish:trade:${token}:decline`).setLabel('Decline').setStyle(ButtonStyle.Danger),
  )];
}

function stars(rarity) {
  return '⭐️'.repeat(Math.max(4, Math.min(5, Number(rarity) || 4)));
}

async function characterRarity(name) {
  const data = await itemData({ type: 'character', name }).catch(() => null);
  return Math.max(4, Math.min(5, Number(data?.rarity) || 4));
}

async function handleTrade(message) {
  await whenWishStoreReady();
  const parsed = parseTrade(message);
  if (!parsed) {
    await message.reply({
      content: 'الصيغة: `Trade "Diluc" @user "Citlali"` أو `Trade Diluc @user 2x Citlali`.',
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const actorId = message.author.id;
  const targetId = parsed.target.id;
  const actor = getWishUser(actorId);
  const target = getWishUser(targetId);
  const offerName = inventoryMatch(actor.characters, parsed.offer.query);
  const requestName = inventoryMatch(target.characters, parsed.request.query);

  if (!offerName || Number(actor.characters[offerName] || 0) < parsed.offer.quantity) {
    await message.reply({ content: 'ما عندك عدد كافي من الشخصية المعروضة.', allowedMentions: { repliedUser: false } });
    return;
  }
  if (!requestName || Number(target.characters[requestName] || 0) < parsed.request.quantity) {
    await message.reply({ content: 'العضو الآخر ما عنده عدد كافي من الشخصية المطلوبة.', allowedMentions: { repliedUser: false } });
    return;
  }

  const [offerRarity, requestRarity] = await Promise.all([characterRarity(offerName), characterRarity(requestName)]);
  const token = crypto.randomBytes(6).toString('hex');
  const embed = new EmbedBuilder()
    .setColor(0xd6a632)
    .setTitle('Trade Request')
    .setDescription(`<@${actorId}> want to trade <@${targetId}>`)
    .addFields(
      { name: 'Offer', value: `${stars(offerRarity)}\n**${parsed.offer.quantity}x ${offerName}**`, inline: true },
      { name: 'For', value: `${stars(requestRarity)}\n**${parsed.request.quantity}x ${requestName}**`, inline: true },
    )
    .setFooter({ text: 'Neverless Wish Simulator • Trade' });

  const output = await message.reply({
    embeds: [embed],
    components: tradeButtons(token),
    allowedMentions: { users: [actorId, targetId], repliedUser: false },
  });

  let settled = false;
  const collector = output.createMessageComponentCollector({ time: TRADE_TTL_MS });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== targetId) {
      await interaction.reply({ content: 'فقط الشخص المطلوب منه المبادلة يقدر يختار.', ephemeral: true }).catch(() => {});
      return;
    }
    const action = interaction.customId.split(':').pop();
    if (!['accept', 'decline'].includes(action)) return interaction.deferUpdate().catch(() => {});
    await interaction.deferUpdate().catch(() => {});

    if (action === 'decline') {
      settled = true;
      collector.stop('declined');
      embed.setColor(0x8d2f36).setTitle('Trade Declined');
      await output.edit({ embeds: [embed], components: [] }).catch(() => {});
      return;
    }

    let outcome;
    try {
      outcome = await mutateWishPair(actorId, targetId, (actorNow, targetNow) => {
        const offerNow = inventoryMatch(actorNow.characters, offerName);
        const requestNow = inventoryMatch(targetNow.characters, requestName);
        if (!offerNow || Number(actorNow.characters[offerNow] || 0) < parsed.offer.quantity) return { ok: false };
        if (!requestNow || Number(targetNow.characters[requestNow] || 0) < parsed.request.quantity) return { ok: false };

        actorNow.characters[offerNow] -= parsed.offer.quantity;
        if (actorNow.characters[offerNow] <= 0) delete actorNow.characters[offerNow];
        targetNow.characters[requestNow] -= parsed.request.quantity;
        if (targetNow.characters[requestNow] <= 0) delete targetNow.characters[requestNow];
        actorNow.characters[requestNow] = Number(actorNow.characters[requestNow] || 0) + parsed.request.quantity;
        targetNow.characters[offerNow] = Number(targetNow.characters[offerNow] || 0) + parsed.offer.quantity;
        return { ok: true };
      });
    } catch (error) {
      console.error('[wish-trade] persistence error:', error);
      outcome = { ok: false };
    }

    settled = true;
    collector.stop(outcome?.ok ? 'accepted' : 'invalid');
    if (!outcome?.ok) {
      embed.setColor(0x8d2f36).setTitle('Trade Failed').setDescription('تغيرت ممتلكات أحد الطرفين قبل القبول، لذلك ألغيت المبادلة بدون نقل أي شخصية.');
      await output.edit({ embeds: [embed], components: [] }).catch(() => {});
      return;
    }

    embed.setColor(0x3b9b68).setTitle('Trade Accepted');
    await output.edit({ embeds: [embed], components: [] }).catch(() => {});
    await message.channel.send({
      content: `وافق <@${targetId}> على المبادلة.\n<@${actorId}> حصل على **${parsed.request.quantity}x ${requestName}** مقابل **${parsed.offer.quantity}x ${offerName}**.`,
      allowedMentions: { users: [actorId, targetId] },
    }).catch(() => {});
  });
  collector.on('end', () => { if (!settled) output.edit({ components: [] }).catch(() => {}); });
}

module.exports = { handleTrade, parseTrade, parseItemSpec, inventoryMatch };
