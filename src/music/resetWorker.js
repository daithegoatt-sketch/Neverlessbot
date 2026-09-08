'use strict';

// BOT_MODE=music starts only the isolated music worker process.
// User commands are handled by the main Neverless bot; workers only consume the private music bus.
// The health bridge keeps the main controller aware of live workers even when Discord
// does not deliver message-update heartbeats for an old status message.
require('./workerHealthBridge');
require('./workerLavalinkV4');
