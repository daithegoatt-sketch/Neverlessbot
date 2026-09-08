'use strict';

// BOT_MODE=music starts one isolated worker only.
// Runtime guard is loaded first so Lavalink voice connect cannot block the worker
// after Discord has already moved the bot into the target voice channel.
require('./workerRuntimeGuard');
// Queue guard enables automatic next-track playback and makes explicit stop leave voice.
require('./workerQueueGuard');
// The health bridge hooks into the same Discord client used by workerFinal; it does
// not create a second login. It publishes fresh STATUS snapshots so the main
// controller never loses healthy workers when Discord message edits fall out of cache.
require('./workerHealthBridge');
require('./workerFinal');
