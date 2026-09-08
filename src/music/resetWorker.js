'use strict';

// BOT_MODE=music starts one isolated worker only.
// The worker publishes its own heartbeat; no second client or health shim is loaded.
require('./workerFinal');
