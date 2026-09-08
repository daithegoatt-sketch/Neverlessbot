'use strict';

const { Client, GatewayIntentBits } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const workerId = String(process.env.MUSIC_WORKER_ID || '').trim();

if (!token) throw new Error('MUSIC_RESET_MISSING_DISCORD_TOKEN');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`[music-reset ${workerId || '?'}] ${client.user.tag} online in reset/idle mode.`);
});

client.login(token).catch((error) => {
  console.error(`[music-reset ${workerId || '?'}] Login failed:`, error);
  process.exitCode = 1;
});
