'use strict';

const { Client } = require('discord.js');
const { handleGenshinMessage } = require('./assistantV3');

const originalLogin = Client.prototype.login;

Client.prototype.login = function neverlessGenshinLogin(token) {
  if (!this.__neverlessGenshinInstalled) {
    this.__neverlessGenshinInstalled = true;
    this.on('messageCreate', (message) => {
      handleGenshinMessage(message).catch((error) => {
        console.error('[genshin-v3] Unhandled message error:', error);
      });
    });
    console.log('[genshin] Neverless Genshin V3 module installed.');
  }
  return originalLogin.call(this, token);
};
