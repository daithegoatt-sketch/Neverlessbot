'use strict';

const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { handleMessage: handleFriendshipMessage } = require('./friendshipSystem');
const {
  USER_PREFIX,
  MARKET_PREFIX,
  COMMAND_CD,
  SALARY_CD,
  TIP_CD,
  MARKET_STEP,
  MAX_BET,
  clamp,
  newUser,
  packUser,
  unpackUser,
  newMarket,
  packMarket,
  unpackMarket,
  enc,
  parseRecord,
  digits,
  parseAmount,
  parseShares,
  parseShareAmount,
  money,
  commandCooldownLeft,
  setCommandCooldown,
  formatDuration,
  cooldownStatus,
} = require('./bankUtils');
const {
  helpCard,
  balanceCard,
  rewardCard,
  vaultCard,
  transferCard,
  marketCard,
  stockTradeCard,
  topCard,
  statusCard,
  infoCard,
} = require('./bankVisualCore');
const {
  investmentCard,
  betCard,
  diceCard,
  gambleCard,
  tradeGameCard,
  rouletteCard,
  hiloCard,
  boxesCard,
} = require('./bankVisualGames');

const BANK_CHANNEL_ID = '1548665575247581184';
const BANK_TEST_CHANNEL_ID = '1548665662556217384';
const BANK_EXTRA_CHANNEL_ID = '1548983198120419418';
const BANK_CHANNELS = new Set([BANK_CHANNEL_ID, BANK_TEST_CHANNEL_ID, BANK_EXTRA_CHANNEL_ID]);
const DATA_CHANNEL_NAME = 'neverless-data';

const users = new Map();
const userMessageIds = new Map();
const markets = new Map();
const marketMessageIds = new Map();
const loadPromises = new Map();
const locks = new Map();

const key = (guildId, userId) => `${guildId}:${userId}`;
const accountLockKey = (guildId, userId) => `account:${guildId}:${userId}`;
const marketLockKey = (guildId) => `market:${guildId}`;

function dataChannel(guild) {
  return guild.channels.cache.find((channel) => channel?.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
}

async function loadGuild(guild) {
  const started = Date.now();
  const channel = dataChannel(guild);
  if (!channel) throw new Error(`Bank data channel "${DATA_CHANNEL_NAME}" not found in ${guild.name}`);

  const latestUsers = new Map();
  let latestMarket = null;
  let before;
  let scanned = 0;

  while (scanned < 5000) {
    let batch;
    try {
      batch = await channel.messages.fetch({ limit: 100, before });
    } catch (error) {
      throw new Error(`Bank data fetch failed in ${guild.name}: ${error.message}`);
    }
    if (!batch?.size) break;

    for (const message of batch.values()) {
      if (message.author?.id !== guild.client.user?.id) continue;
      const record = parseRecord(message.content);
      if (!record || record.guildId !== guild.id) continue;

      if (record.type === 'user') {
        const old = latestUsers.get(record.userId);
        if (!old || message.createdTimestamp > old.ts) {
          latestUsers.set(record.userId, { ...record, id: message.id, ts: message.createdTimestamp });
        }
      } else if (!latestMarket || message.createdTimestamp > latestMarket.ts) {
        latestMarket = { ...record, id: message.id, ts: message.createdTimestamp };
      }
    }

    scanned += batch.size;
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }

  for (const record of latestUsers.values()) {
    users.set(key(guild.id, record.userId), unpackUser(record.payload));
    userMessageIds.set(key(guild.id, record.userId), record.id);
  }

  if (latestMarket) {
    markets.set(guild.id, unpackMarket(latestMarket.payload));
    marketMessageIds.set(guild.id, latestMarket.id);
  } else {
    markets.set(guild.id, newMarket());
  }

  console.log(`[bank] loaded ${latestUsers.size} accounts in ${guild.name} (${Date.now() - started}ms)`);
}

function ensureLoaded(guild) {
  if (!loadPromises.has(guild.id)) {
    const promise = loadGuild(guild).catch((error) => {
      if (loadPromises.get(guild.id) === promise) loadPromises.delete(guild.id);
      console.error('[bank] load failed:', error);
      throw error;
    });
    loadPromises.set(guild.id, promise);
  }
  return loadPromises.get(guild.id);
}

function getUser(guildId, userId) {
  const accountKey = key(guildId, userId);
  if (!users.has(accountKey)) users.set(accountKey, newUser());
  return users.get(accountKey);
}

async function persistUser(guild, userId) {
  const channel = dataChannel(guild);
  if (!channel) return false;

  const accountKey = key(guild.id, userId);
  const content = `${USER_PREFIX}${guild.id}|${userId}|${enc(packUser(getUser(guild.id, userId)))}`;
  const id = userMessageIds.get(accountKey);

  if (id) {
    const edited = await channel.messages.edit(id, {
      content,
      allowedMentions: { parse: [] },
    }).catch(() => null);
    if (edited) return true;
  }

  const message = await channel.send({ content, allowedMentions: { parse: [] } }).catch((error) => {
    console.error(`[bank] failed to persist user ${userId}:`, error);
    return null;
  });
  if (!message) return false;
  userMessageIds.set(accountKey, message.id);
  return true;
}

async function persistMarket(guild) {
  const channel = dataChannel(guild);
  if (!channel) return false;

  const market = markets.get(guild.id) || newMarket();
  const content = `${MARKET_PREFIX}${guild.id}|${enc(packMarket(market))}`;
  const id = marketMessageIds.get(guild.id);

  if (id) {
    const edited = await channel.messages.edit(id, {
      content,
      allowedMentions: { parse: [] },
    }).catch(() => null);
    if (edited) return true;
  }

  const message = await channel.send({ content, allowedMentions: { parse: [] } }).catch((error) => {
    console.error('[bank] failed to persist market:', error);
    return null;
  });
  if (!message) return false;
  marketMessageIds.set(guild.id, message.id);
  return true;
}

async function withLock(lockKey, fn) {
  const previous = locks.get(lockKey) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  locks.set(lockKey, queued);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(lockKey) === queued) locks.delete(lockKey);
  }
}

async function withLocks(lockKeys, fn) {
  const ordered = [...new Set(lockKeys)].sort();
  const take = async (index) => {
    if (index >= ordered.length) return fn();
    return withLock(ordered[index], () => take(index + 1));
  };
  return take(0);
}

function updateMarket(guildId) {
  const market = markets.get(guildId) || newMarket();
  const steps = Math.min(18, Math.floor(Math.max(0, Date.now() - market.updatedAt) / MARKET_STEP));
  for (let i = 0; i < steps; i += 1) {
    const momentum = market.history.length > 1
      ? (market.history.at(-1) - market.history.at(-2)) / Math.max(1, market.history.at(-2))
      : 0;
    const move = clamp((Math.random() * 0.15) - 0.065 + momentum * 0.12, -0.10, 0.11);
    market.price = clamp(Math.round(market.price * (1 + move)), 25, 1200);
    market.history.push(market.price);
    market.history = market.history.slice(-24);
    market.updatedAt += MARKET_STEP;
  }
  markets.set(guildId, market);
  return { market, changed: steps > 0 };
}

async function replyImage(message, buffer, name, content = null, components = []) {
  return message.reply({
    content: content || undefined,
    files: [{ attachment: buffer, name }],
    components,
    allowedMentions: { repliedUser: false, parse: [] },
  });
}

async function replyInfo(message, title, text, content = null) {
  return replyImage(message, infoCard(title, text), `bank-info-${Date.now()}.png`, content);
}

async function commitCard(message, persistPromise, cardPromise, fileName, content) {
  const [persisted, image] = await Promise.all([persistPromise, cardPromise]);
  if (!persisted) {
    console.error(`[bank] persistence failed before success reply: ${fileName}`);
    return replyInfo(message, 'تعذر حفظ العملية', 'لم يتم تأكيد العملية • جرّب مرة ثانية');
  }
  return replyImage(message, image, fileName, content);
}

async function balance(message) {
  const target = message.mentions.users.first() || message.author;
  const existed = users.has(key(message.guildId, target.id));
  const { market, changed } = updateMarket(message.guildId);
  const state = getUser(message.guildId, target.id);
  const persistPromise = Promise.all([
    existed ? Promise.resolve(true) : persistUser(message.guild, target.id),
    changed ? persistMarket(message.guild) : Promise.resolve(true),
  ]).then((results) => results.every(Boolean));
  await commitCard(
    message,
    persistPromise,
    balanceCard(target, state, market.price),
    `neverless-balance-${target.id}.png`,
    `<@${target.id}> — حساب Neverless Bank`,
  );
}

async function income(message, type) {
  await withLock(accountLockKey(message.guildId, message.author.id), async () => {
    const state = getUser(message.guildId, message.author.id);
    const isSalary = type === 'salary';
    const at = isSalary ? state.salaryAt : state.tipAt;
    const cooldown = isSalary ? SALARY_CD : TIP_CD;
    const left = Math.max(0, Number(at) + cooldown - Date.now());
    if (left > 0) {
      await replyInfo(message, 'الأمر غير متاح', `الوقت الباقي ${formatDuration(left)}`);
      return;
    }

    const amount = isSalary ? 700 + Math.floor(Math.random() * 801) : 120 + Math.floor(Math.random() * 381);
    state.balance += amount;
    state.earned += amount;
    if (isSalary) state.salaryAt = Date.now();
    else state.tipAt = Date.now();

    await commitCard(
      message,
      persistUser(message.guild, message.author.id),
      rewardCard(message.author, isSalary ? 'راتب Neverless' : 'بخشيش Neverless', amount, state.balance, type),
      `${type}-${message.author.id}.png`,
      `<@${message.author.id}> — ${isSalary ? 'تم إيداع راتبك' : 'وصلتك مكافأة'}`,
    );
  });
}

async function transfer(message, raw) {
  const target = message.mentions.users.first();
  if (!target || target.bot || target.id === message.author.id) {
    await replyInfo(message, 'طريقة الاستخدام', 'تحويل @member 500');
    return;
  }

  await withLocks([
    accountLockKey(message.guildId, message.author.id),
    accountLockKey(message.guildId, target.id),
  ], async () => {
    const fromState = getUser(message.guildId, message.author.id);
    const amount = parseAmount(raw, fromState.balance);
    if (!Number.isFinite(amount)) {
      await replyInfo(message, 'مبلغ غير صالح', `رصيدك المتاح ${money(fromState.balance)}`);
      return;
    }

    const toState = getUser(message.guildId, target.id);
    fromState.balance -= amount;
    toState.balance += amount;

    const persistPromise = Promise.all([
      persistUser(message.guild, message.author.id),
      persistUser(message.guild, target.id),
    ]).then((results) => results.every(Boolean));
    await commitCard(
      message,
      persistPromise,
      transferCard(message.author, target, amount, fromState.balance, toState.balance),
      `transfer-${message.author.id}-${target.id}.png`,
      `<@${message.author.id}> → <@${target.id}> • ${money(amount)}`,
    );
  });
}

async function vault(message, action, raw) {
  await withLock(accountLockKey(message.guildId, message.author.id), async () => {
    const state = getUser(message.guildId, message.author.id);
    const source = action === 'deposit' ? state.balance : state.vault;
    const amount = parseAmount(raw, source);
    if (!Number.isFinite(amount)) {
      await replyInfo(message, 'مبلغ غير صالح', `المتاح ${money(source)}`);
      return;
    }

    if (action === 'deposit') {
      state.balance -= amount;
      state.vault += amount;
    } else {
      state.vault -= amount;
      state.balance += amount;
    }

    await commitCard(
      message,
      persistUser(message.guild, message.author.id),
      vaultCard(message.author, action, amount, state),
      `vault-${action}-${message.author.id}.png`,
      `<@${message.author.id}> — ${action === 'deposit' ? 'إيداع' : 'سحب'} ${money(amount)}`,
    );
  });
}

function randomOutcome(type, wager) {
  if (type === 'bet') {
    const won = Math.random() < 0.48;
    const multiplier = won ? 1.9 : 0;
    return { payout: won ? Math.floor(wager * multiplier) : 0, multiplier };
  }
  if (type === 'invest') {
    const percent = Math.floor(Math.random() * 71) - 30;
    return { payout: Math.max(0, Math.floor(wager * (1 + percent / 100))), percent };
  }
  if (type === 'dice') {
    const player = 1 + Math.floor(Math.random() * 6);
    const bank = 1 + Math.floor(Math.random() * 6);
    return { payout: player > bank ? wager * 2 : player === bank ? wager : 0, player, bank };
  }
  if (type === 'gamble') {
    const roll = Math.random();
    const multiplier = roll < 0.52 ? 0 : roll < 0.78 ? 1.5 : roll < 0.94 ? 2 : 5;
    return { payout: Math.floor(wager * multiplier), multiplier };
  }
  const percent = Math.floor(Math.random() * 51) - 22;
  return { payout: Math.max(0, Math.floor(wager * (1 + percent / 100))), percent };
}

async function moneyGame(message, type, raw) {
  const names = { bet: 'رهان', invest: 'استثمار', dice: 'نرد', gamble: 'قمار', trade: 'تداول' };
  await withLock(accountLockKey(message.guildId, message.author.id), async () => {
    const state = getUser(message.guildId, message.author.id);
    const left = commandCooldownLeft(state, type);
    if (left > 0) {
      await replyInfo(message, `${names[type]} غير متاح`, `الوقت الباقي ${formatDuration(left)}`);
      return;
    }

    const wager = parseAmount(raw, Math.min(state.balance, MAX_BET));
    if (!Number.isFinite(wager)) {
      await replyInfo(message, 'طريقة الاستخدام', `${names[type]} كامل / نص / ربع / 1000 • رصيدك ${money(state.balance)}`);
      return;
    }

    const out = randomOutcome(type, wager);
    const net = out.payout - wager;
    state.balance = state.balance - wager + out.payout;
    state.games += 1;
    if (net > 0) {
      state.wins += 1;
      state.earned += net;
    } else if (net < 0) {
      state.lost += -net;
    }
    setCommandCooldown(state, type);

    let cardPromise;
    if (type === 'invest') cardPromise = investmentCard(message.author, wager, out, net, state.balance);
    else if (type === 'bet') cardPromise = betCard(message.author, wager, out, net, state.balance);
    else if (type === 'dice') cardPromise = diceCard(message.author, wager, out, net, state.balance);
    else if (type === 'gamble') cardPromise = gambleCard(message.author, wager, out, net, state.balance);
    else cardPromise = tradeGameCard(message.author, wager, out, net, state.balance);

    const resultText = net > 0 ? `ربحت ${money(net)}` : net < 0 ? `خسرت ${money(-net)}` : 'تعادل';
    await commitCard(
      message,
      persistUser(message.guild, message.author.id),
      cardPromise,
      `${type}-${message.author.id}-${Date.now()}.png`,
      `<@${message.author.id}> — ${names[type]} • ${resultText}`,
    );
  });
}

async function roulette(message, raw) {
  await withLock(accountLockKey(message.guildId, message.author.id), async () => {
    const state = getUser(message.guildId, message.author.id);
    const left = commandCooldownLeft(state, 'roulette');
    if (left > 0) {
      await replyInfo(message, 'روليت غير متاح', `الوقت الباقي ${formatDuration(left)}`);
      return;
    }

    const wager = parseAmount(raw, Math.min(state.balance, MAX_BET));
    if (!Number.isFinite(wager)) {
      await replyInfo(message, 'طريقة الاستخدام', `روليت كامل / نص / ربع / 500 • رصيدك ${money(state.balance)}`);
      return;
    }

    const roll = Math.random();
    const multiplier = roll >= 0.95 ? 5 : roll >= 0.85 ? 2 : roll >= 0.65 ? 1.5 : roll >= 0.45 ? 1 : 0;
    const payout = Math.floor(wager * multiplier);
    const net = payout - wager;
    state.balance = state.balance - wager + payout;
    state.games += 1;
    if (net > 0) {
      state.wins += 1;
      state.earned += net;
    } else if (net < 0) {
      state.lost += -net;
    }
    setCommandCooldown(state, 'roulette');

    await commitCard(
      message,
      persistUser(message.guild, message.author.id),
      Promise.resolve(rouletteCard(multiplier, wager, payout, state.balance)),
      `roulette-${message.author.id}.png`,
      `<@${message.author.id}> — ${net > 0 ? `ربحت ${money(net)}` : net < 0 ? `خسرت ${money(-net)}` : 'عاد لك نفس المبلغ'}`,
    );
  });
}

function hiloButtons(nonce, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`nlbank:hilo:${nonce}:up`)
      .setLabel('أعلى')
      .setEmoji('📈')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`nlbank:hilo:${nonce}:down`)
      .setLabel('أقل')
      .setEmoji('📉')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  )];
}

async function hilo(message, raw) {
  const state = getUser(message.guildId, message.author.id);
  const wager = parseAmount(raw, Math.min(state.balance, MAX_BET));
  if (!Number.isFinite(wager)) {
    await replyInfo(message, 'طريقة الاستخدام', `هايلو كامل / نص / ربع / 500 • رصيدك ${money(state.balance)}`);
    return;
  }

  let started = false;
  await withLock(accountLockKey(message.guildId, message.author.id), async () => {
    const fresh = getUser(message.guildId, message.author.id);
    const left = commandCooldownLeft(fresh, 'hilo');
    if (left > 0) {
      await replyInfo(message, 'هايلو غير متاح', `الوقت الباقي ${formatDuration(left)}`);
      return;
    }
    if (fresh.balance < wager) {
      await replyInfo(message, 'رصيد غير كافٍ', `رصيدك ${money(fresh.balance)}`);
      return;
    }
    setCommandCooldown(fresh, 'hilo');
    if (!await persistUser(message.guild, message.author.id)) {
      await replyInfo(message, 'تعذر حفظ الجولة', 'جرّب مرة ثانية');
      return;
    }
    started = true;
  });
  if (!started) return;

  const current = 2 + Math.floor(Math.random() * 13);
  const nonce = crypto.randomBytes(4).toString('hex');
  const sent = await replyImage(
    message,
    hiloCard(current, null, null, wager),
    `hilo-${nonce}.png`,
    `<@${message.author.id}> — اختر أعلى أو أقل`,
    hiloButtons(nonce),
  );
  const collector = sent.createMessageComponentCollector({ time: 45_000 });

  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply({ content: 'هذه الجولة ليست لك.', ephemeral: true }).catch(() => {});
      return;
    }
    collector.stop('done');
    await interaction.deferUpdate().catch(() => {});
    const up = interaction.customId.endsWith(':up');
    let output;

    await withLock(accountLockKey(message.guildId, message.author.id), async () => {
      const fresh = getUser(message.guildId, message.author.id);
      if (fresh.balance < wager) {
        output = { error: `رصيدك أصبح أقل من ${money(wager)}.` };
        return;
      }

      let next = current;
      while (next === current) next = 2 + Math.floor(Math.random() * 13);
      const won = up ? next > current : next < current;
      const payout = won ? Math.floor(wager * 1.85) : 0;
      const net = payout - wager;
      fresh.balance = fresh.balance - wager + payout;
      fresh.games += 1;
      if (net > 0) {
        fresh.wins += 1;
        fresh.earned += net;
      } else if (net < 0) {
        fresh.lost += -net;
      }
      const persisted = await persistUser(message.guild, message.author.id);
      output = persisted ? { next, won, payout, net, balance: fresh.balance } : { error: 'تعذر حفظ نتيجة الجولة.' };
    });

    if (output.error) {
      await sent.edit({ content: output.error, components: hiloButtons(nonce, true) }).catch(() => {});
      return;
    }

    await sent.edit({
      content: `<@${message.author.id}> — ${output.won ? `ربحت ${money(output.net)}` : `خسرت ${money(wager)}`}`,
      files: [{ attachment: hiloCard(current, output.next, output.won, wager, output.balance), name: `hilo-result-${nonce}.png` }],
      attachments: [],
      components: hiloButtons(nonce, true),
      allowedMentions: { parse: [] },
    }).catch((error) => console.error('[bank] hilo result edit failed:', error));
  });

  collector.on('end', async (_, reason) => {
    if (reason !== 'done') await sent.edit({ components: hiloButtons(nonce, true) }).catch(() => {});
  });
}

function boxButtons(nonce, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    ...Array.from({ length: 5 }, (_, index) => new ButtonBuilder()
      .setCustomId(`nlbank:box:${nonce}:${index}`)
      .setLabel(String(index + 1))
      .setEmoji('🎁')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)),
  )];
}

async function boxes(message, raw) {
  const state = getUser(message.guildId, message.author.id);
  const wager = parseAmount(raw || '500', Math.min(state.balance, MAX_BET));
  if (!Number.isFinite(wager)) {
    await replyInfo(message, 'طريقة الاستخدام', `صناديق كامل / نص / ربع / 500 • رصيدك ${money(state.balance)}`);
    return;
  }

  let started = false;
  await withLock(accountLockKey(message.guildId, message.author.id), async () => {
    const fresh = getUser(message.guildId, message.author.id);
    const left = commandCooldownLeft(fresh, 'boxes');
    if (left > 0) {
      await replyInfo(message, 'الصناديق غير متاحة', `الوقت الباقي ${formatDuration(left)}`);
      return;
    }
    if (fresh.balance < wager) {
      await replyInfo(message, 'رصيد غير كافٍ', `رصيدك ${money(fresh.balance)}`);
      return;
    }
    setCommandCooldown(fresh, 'boxes');
    if (!await persistUser(message.guild, message.author.id)) {
      await replyInfo(message, 'تعذر حفظ الجولة', 'جرّب مرة ثانية');
      return;
    }
    started = true;
  });
  if (!started) return;

  const bomb = Math.floor(Math.random() * 5);
  const multipliers = [0.5, 0.8, 1.2, 2].sort(() => Math.random() - 0.5);
  const list = [];
  let multiplierIndex = 0;
  for (let index = 0; index < 5; index += 1) {
    list.push(index === bomb ? { bomb: true, mult: 0 } : { bomb: false, mult: multipliers[multiplierIndex++] });
  }

  const nonce = crypto.randomBytes(4).toString('hex');
  const sent = await replyImage(
    message,
    boxesCard(wager),
    `boxes-${nonce}.png`,
    `<@${message.author.id}> — اختر صندوقاً`,
    boxButtons(nonce),
  );
  const collector = sent.createMessageComponentCollector({ time: 45_000 });

  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply({ content: 'هذه الصناديق ليست لك.', ephemeral: true }).catch(() => {});
      return;
    }
    collector.stop('done');
    await interaction.deferUpdate().catch(() => {});
    const pickedIndex = Number(interaction.customId.split(':')[3]);
    const picked = list[pickedIndex];
    let output;

    await withLock(accountLockKey(message.guildId, message.author.id), async () => {
      const fresh = getUser(message.guildId, message.author.id);
      if (fresh.balance < wager) {
        output = { error: `رصيدك أصبح أقل من ${money(wager)}.` };
        return;
      }
      const payout = picked.bomb ? 0 : Math.floor(wager * picked.mult);
      const net = payout - wager;
      fresh.balance = fresh.balance - wager + payout;
      fresh.games += 1;
      if (net > 0) {
        fresh.wins += 1;
        fresh.earned += net;
      } else if (net < 0) {
        fresh.lost += -net;
      }
      const persisted = await persistUser(message.guild, message.author.id);
      output = persisted ? { payout, net, balance: fresh.balance } : { error: 'تعذر حفظ نتيجة الجولة.' };
    });

    if (output.error) {
      await sent.edit({ content: output.error, components: boxButtons(nonce, true) }).catch(() => {});
      return;
    }

    const content = picked.bomb
      ? `<@${message.author.id}> — الصندوق انفجر وخسرت ${money(wager)}`
      : output.net > 0
        ? `<@${message.author.id}> — x${picked.mult} • ربحت ${money(output.net)}`
        : output.net === 0
          ? `<@${message.author.id}> — عاد لك نفس المبلغ`
          : `<@${message.author.id}> — عاد ${money(output.payout)} • خسارة ${money(-output.net)}`;

    await sent.edit({
      content,
      files: [{ attachment: boxesCard(wager, list, pickedIndex, output.balance), name: `boxes-result-${nonce}.png` }],
      attachments: [],
      components: boxButtons(nonce, true),
      allowedMentions: { parse: [] },
    }).catch((error) => console.error('[bank] boxes result edit failed:', error));
  });

  collector.on('end', async (_, reason) => {
    if (reason !== 'done') await sent.edit({ components: boxButtons(nonce, true) }).catch(() => {});
  });
}

async function stock(message) {
  await withLock(marketLockKey(message.guildId), async () => {
    const { market, changed } = updateMarket(message.guildId);
    if (changed && !await persistMarket(message.guild)) {
      await replyInfo(message, 'تعذر تحديث السوق', 'جرّب مرة ثانية');
      return;
    }
    await replyImage(message, marketCard(market), `market-${message.guildId}.png`, '📈 سوق Neverless الحالي');
  });
}

async function tradeStock(message, action, raw) {
  await withLocks([
    marketLockKey(message.guildId),
    accountLockKey(message.guildId, message.author.id),
  ], async () => {
    const { market, changed } = updateMarket(message.guildId);
    const state = getUser(message.guildId, message.author.id);
    const maxShares = action === 'buy' ? Math.floor(state.balance / market.price) : state.shares;
    const count = parseShareAmount(raw, maxShares);
    if (!Number.isFinite(count)) {
      await replyInfo(
        message,
        'طريقة الاستخدام',
        `${action === 'buy' ? 'شراء سهم' : 'بيع سهم'} 5 / كامل / نص / ربع • المتاح ${maxShares} سهم`,
      );
      return;
    }

    const total = count * market.price;
    if (action === 'buy') {
      if (state.balance < total) {
        await replyInfo(message, 'رصيد غير كافٍ', `تحتاج ${money(total)} • رصيدك ${money(state.balance)}`);
        return;
      }
      state.balance -= total;
      state.shares += count;
    } else {
      if (state.shares < count) {
        await replyInfo(message, 'أسهم غير كافية', `لديك ${state.shares} سهم`);
        return;
      }
      state.shares -= count;
      state.balance += total;
    }

    const persistPromise = Promise.all([
      persistUser(message.guild, message.author.id),
      changed ? persistMarket(message.guild) : Promise.resolve(true),
    ]).then((results) => results.every(Boolean));
    await commitCard(
      message,
      persistPromise,
      stockTradeCard(message.author, action, count, total, market.price, state),
      `stock-${action}-${message.author.id}.png`,
      `<@${message.author.id}> — ${action === 'buy' ? 'شراء' : 'بيع'} ${count} سهم • ${money(total)}`,
    );
  });
}

async function top(message, client) {
  await withLock(marketLockKey(message.guildId), async () => {
    const { market, changed } = updateMarket(message.guildId);
    const rows = [];
    for (const [accountKey, state] of users) {
      if (!accountKey.startsWith(`${message.guildId}:`)) continue;
      const userId = accountKey.slice(message.guildId.length + 1);
      rows.push({ userId, state, net: state.balance + state.vault + state.shares * market.price });
    }
    rows.sort((a, b) => b.net - a.net);

    const enriched = await Promise.all(rows.slice(0, 5).map(async (row) => {
      const user = client.users.cache.get(row.userId) || await client.users.fetch(row.userId).catch(() => null);
      return {
        ...row,
        user: user || { id: row.userId, username: `member-${row.userId.slice(-4)}`, globalName: null },
      };
    }));

    if (changed && !await persistMarket(message.guild)) {
      await replyInfo(message, 'تعذر تحديث الترتيب', 'جرّب مرة ثانية');
      return;
    }
    await replyImage(message, await topCard(enriched, market.price), `top-${message.guildId}.png`, '🏆 أغنى 5 أعضاء في Neverless Bank');
  });
}

function normalized(content) {
  return digits(content)
    .trim()
    .replace(/^[-#]+\s*/u, '')
    .replace(/^<@!?\d{15,22}>\s*/u, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

async function handleBankMessage(message, client) {
  if (!message?.guildId || message.author?.bot || !BANK_CHANNELS.has(message.channelId)) return false;
  const text = normalized(message.content);
  if (!text) return false;

  const known = /^(?:اوامر|أوامر|bank|bank help|رصيد|balance|bal|بروفايل|profile|محفظة|wallet|ثروتي|وقت|cooldowns?|راتب|salary|daily|بخشيش|tip|توب|top|سهم|اسهم|أسهم|stock|تحويل|transfer|ايداع|إيداع|deposit|سحب|withdraw|رهان|bet|استثمار|invest|نرد|dice|قمار|gamble|تداول|تدوال|trade|روليت|roulette|هايلو|هاي لو|hilo|صناديق|boxes|شراء سهم|شراء اسهم|شراء أسهم|buy|بيع سهم|بيع اسهم|بيع أسهم|sell)(?:\s|$)/u.test(text);
  if (!known) return false;

  try {
    await ensureLoaded(message.guild);

    if (/^(?:اوامر|أوامر|bank|bank help)$/u.test(text)) {
      await replyImage(message, helpCard(), 'neverless-bank-commands.png', '🏦 أوامر Neverless Bank');
      return true;
    }
    if (/^(?:رصيد|balance|bal|بروفايل|profile|محفظة|wallet|ثروتي)(?:\s|$)/u.test(text)) {
      await balance(message);
      return true;
    }
    if (/^(?:وقت|cooldowns?)$/u.test(text)) {
      await replyImage(
        message,
        statusCard(message.author, getUser(message.guildId, message.author.id)),
        `bank-time-${message.author.id}.png`,
        `<@${message.author.id}> — حالة الأوامر`,
      );
      return true;
    }
    if (/^(?:راتب|salary|daily)$/u.test(text)) {
      await income(message, 'salary');
      return true;
    }
    if (/^(?:بخشيش|tip)$/u.test(text)) {
      await income(message, 'tip');
      return true;
    }
    if (/^(?:توب|top)$/u.test(text)) {
      await top(message, client);
      return true;
    }
    if (/^(?:سهم|اسهم|أسهم|stock)$/u.test(text)) {
      await stock(message);
      return true;
    }

    let match = text.match(/^(?:تحويل|transfer)\s+<@!?\d{15,22}>\s+(.+)$/u);
    if (match) {
      await transfer(message, match[1]);
      return true;
    }

    match = text.match(/^(?:ايداع|إيداع|deposit)\s+(.+)$/u);
    if (match) {
      await vault(message, 'deposit', match[1]);
      return true;
    }

    match = text.match(/^(?:سحب|withdraw)\s+(.+)$/u);
    if (match) {
      await vault(message, 'withdraw', match[1]);
      return true;
    }

    const moneyGames = [
      [/^(?:رهان|bet)\s+(.+)$/u, 'bet'],
      [/^(?:استثمار|invest)\s+(.+)$/u, 'invest'],
      [/^(?:نرد|dice)\s+(.+)$/u, 'dice'],
      [/^(?:قمار|gamble)\s+(.+)$/u, 'gamble'],
      [/^(?:تداول|تدوال|trade)\s+(.+)$/u, 'trade'],
    ];
    for (const [pattern, type] of moneyGames) {
      match = text.match(pattern);
      if (match) {
        await moneyGame(message, type, match[1]);
        return true;
      }
    }

    match = text.match(/^(?:روليت|roulette)\s+(.+)$/u);
    if (match) {
      await roulette(message, match[1]);
      return true;
    }

    match = text.match(/^(?:هايلو|هاي لو|hilo)\s+(.+)$/u);
    if (match) {
      await hilo(message, match[1]);
      return true;
    }

    match = text.match(/^(?:صناديق|boxes)(?:\s+(.+))?$/u);
    if (match) {
      await boxes(message, match[1] || '500');
      return true;
    }

    match = text.match(/^(?:شراء سهم|شراء اسهم|شراء أسهم|buy)\s+(.+)$/u);
    if (match) {
      await tradeStock(message, 'buy', match[1]);
      return true;
    }

    match = text.match(/^(?:بيع سهم|بيع اسهم|بيع أسهم|sell)\s+(.+)$/u);
    if (match) {
      await tradeStock(message, 'sell', match[1]);
      return true;
    }

    await replyInfo(message, 'الأمر غير مكتمل', 'اكتب اوامر لعرض جميع أوامر البنك');
    return true;
  } catch (error) {
    console.error('[bank] command failed:', error);
    await replyInfo(message, 'خطأ مؤقت', 'تعذر تنفيذ الأمر الآن • جرّب مرة ثانية').catch(() => {});
    return true;
  }
}

function warmBank(client) {
  const guilds = [...client.guilds.cache.values()];
  if (!guilds.length) return;
  Promise.allSettled(guilds.map((guild) => ensureLoaded(guild)))
    .then((results) => {
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed) console.warn(`[bank] warmup finished with ${failed} failure(s)`);
      else console.log(`[bank] warmup ready for ${guilds.length} guild(s)`);
    })
    .catch(() => {});
}

function installBankSystem(client) {
  if (client.__neverlessBankInstalled) return;
  client.__neverlessBankInstalled = true;

  client.on('messageCreate', (message) => {
    handleFriendshipMessage(message).catch((error) => console.error('[friendship] unhandled:', error));
    handleBankMessage(message, client).catch((error) => console.error('[bank] unhandled:', error));
  });

  client.on('guildCreate', (guild) => {
    ensureLoaded(guild).catch((error) => console.error('[bank] guild warmup failed:', error));
  });

  if (client.isReady?.()) setImmediate(() => warmBank(client));
  else client.once('ready', () => setImmediate(() => warmBank(client)));

  console.log(`[bank] installed for ${[...BANK_CHANNELS].join(', ')}`);
}

module.exports = {
  installBankSystem,
  handleBankMessage,
  parseAmount,
  parseShares,
  parseRecord,
  unpackUser,
  commandCooldownLeft,
  cooldownStatus,
  BANK_CHANNEL_ID,
  BANK_TEST_CHANNEL_ID,
  BANK_EXTRA_CHANNEL_ID,
  COMMAND_CD,
};
