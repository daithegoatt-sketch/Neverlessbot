'use strict';

let installed = false;

function shouldGuard(interaction) {
  if (!interaction?.isChatInputCommand?.()) return false;
  if (interaction.commandName !== 'automod') return false;
  let subcommand = null;
  try { subcommand = interaction.options.getSubcommand(); } catch { return false; }
  return subcommand === 'addword' || subcommand === 'removeword';
}

function stripReplyOnlyFields(payload) {
  if (typeof payload === 'string') return { content: payload };
  const next = { ...(payload || {}) };
  delete next.ephemeral;
  if (Number(next.flags) === 64) delete next.flags;
  return next;
}

function installInteractionAckGuard(client) {
  if (installed) return;
  installed = true;

  client.prependListener('interactionCreate', (interaction) => {
    if (!shouldGuard(interaction) || interaction.replied || interaction.deferred) return;

    const originalEditReply = interaction.editReply.bind(interaction);
    const deferred = interaction.deferReply({ ephemeral: true });

    // Existing AutoMod behavior stays untouched. Its later reply is transparently
    // converted into editReply after the interaction has already been acknowledged.
    interaction.reply = async (payload) => {
      await deferred;
      return originalEditReply(stripReplyOnlyFields(payload));
    };

    deferred.catch((error) => {
      console.warn(`[interaction-ack] Could not defer /automod ${interaction.options?.getSubcommand?.() || ''}: ${error.message}`);
    });
  });
}

module.exports = { installInteractionAckGuard, shouldGuard, stripReplyOnlyFields };
