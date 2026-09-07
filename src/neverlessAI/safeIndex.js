'use strict';

let runtime = null;
let loadError = null;

try {
  require('./ownerMode').installOwnerPatch();
  runtime = require('./indexV4');
} catch (error) {
  loadError = error;
  console.error('[neverless-ai] AI module failed to load; the rest of Neverless will continue:', error);
}

function installNeverlessAI(client) {
  if (!runtime?.installNeverlessAI) {
    console.warn('[neverless-ai] AI disabled because its isolated module did not load.', loadError?.message || 'unknown error');
    return;
  }
  try {
    runtime.installNeverlessAI(client);
  } catch (error) {
    console.error('[neverless-ai] AI installation failed; the rest of Neverless will continue:', error);
  }
}

module.exports = { installNeverlessAI };
