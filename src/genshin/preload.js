'use strict';

const { Client } = require('discord.js');
const { handleGenshinMessage } = require('./assistantV3');
const { handleRatingMessage } = require('./ratingV4');

const originalLogin = Client.prototype.login;

Client.prototype.login = function neverlessGenshinLogin(token) {
  if (!this.__neverlessGenshinInstalled) {
    this.__neverlessGenshinInstalled = true;
    this.on('messageCreate', (message) => {
      Promise.resolve()
        .then(() => handleRatingMessage(message))
        .then((handled) => handled ? true : handleGenshinMessage(message))
        .catch((error) => {
          console.error('[genshin] Unhandled message error:', error);
        });
    });
    console.log('[genshin] Neverless Genshin V3 + Rating V4 installed.');
  }
  return originalLogin.call(this, token);
};
