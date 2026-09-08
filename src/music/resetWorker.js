'use strict';

// BOT_MODE=music starts one isolated worker only.
// The health bridge hooks into the same Discord client used by workerFinal; it does
// not create a second login. It publishes fresh STATUS snapshots so the main
// controller never loses healthy workers when Discord message edits fall out of cache.
require('./workerHealthBridge');
require('./workerFinal');
