'use strict';

// BOT_MODE=music starts only the isolated music worker process.
// User commands are handled by the main Neverless bot; workers only consume the private music bus.
require('./workerDirectBusV2');
