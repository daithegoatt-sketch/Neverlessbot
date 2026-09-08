'use strict';

const { spawnSync } = require('node:child_process');

const mode = String(process.env.BOT_MODE || 'main').trim().toLowerCase();

if (mode === 'music') {
  require('./src/music/workerLavalink');
} else {
  const prepare = spawnSync(process.execPath, ['prepare.js'], { stdio: 'inherit' });
  if (prepare.status !== 0) process.exit(prepare.status || 1);
  require('./src/genshin/preload');
  require('./src/music/mainPreload');
  require('./index');
}
