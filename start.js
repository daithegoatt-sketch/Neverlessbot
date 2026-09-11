'use strict';

const { spawnSync } = require('node:child_process');

const mode = String(process.env.BOT_MODE || 'main').trim().toLowerCase();

if (mode === 'music') {
  require('./src/music/resetWorker');
} else {
  // Install before any main-bot subsystem starts. This only suppresses known
  // transient TLS/network rejections; real code errors still terminate normally.
  require('./src/transientNetworkGuard');
  const prepare = spawnSync(process.execPath, ['prepare.js'], { stdio: 'inherit' });
  if (prepare.status !== 0) process.exit(prepare.status || 1);
  require('./src/voiceTopHook');
  require('./src/genshin/preload');
  require('./src/music/mainControllerHook');
  require('./index');
}
