'use strict';

const { Client } = require('discord.js');
const { handleGenshinMessage } = require('./assistant');

const originalLogin = Client.prototype.login;

Client.prototype.login = function neverlessGenshinLogin(token) {
  if (!this.__neverlessGenshinInstalled) {
    this.__neverlessGenshinInstalled = true;
    this.on('messageCreate', (message) => {
      handleGenshinMessage(message).catch((error) => {
        console.error('[genshin] Unhandled message error:', error);
      });
    });
    console.log('[genshin] Neverless Genshin module installed.');
  }

  return originalLogin.call(this, token);
};
