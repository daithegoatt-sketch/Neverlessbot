
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
