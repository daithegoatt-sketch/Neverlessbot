'use strict';

// Main-bot stability guard.
// Discord/Railway transport can occasionally fail a TLS handshake. Several subsystems
// already catch their own REST failures, but a library/background promise can still
// surface the same transport error as an unhandled rejection. Node 22 treats that as
// fatal by default. Suppress only known transient network/TLS rejections; every other
// unhandled rejection remains fatal so real code bugs are not hidden.

const INSTALL_KEY = Symbol.for('neverless.transient-network-guard');

function errorChain(reason) {
  const out = [];
  const seen = new Set();
  let current = reason;
  for (let i = 0; current && i < 6; i += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    out.push(current);
    current = current?.cause;
  }
  if (reason instanceof AggregateError) out.push(...reason.errors);
  return out;
}

function isTransientNetworkError(reason) {
  const codes = new Set([
    'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);

  return errorChain(reason).some((error) => {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || error || '').toLowerCase();
    return codes.has(code)
      || message.includes('sslv3 alert handshake failure')
      || message.includes('ssl3_read_bytes')
      || message.includes('socket hang up')
      || message.includes('client network socket disconnected before secure tls connection was established');
  });
}

function installTransientNetworkGuard() {
  if (globalThis[INSTALL_KEY]) return;
  globalThis[INSTALL_KEY] = true;

  process.on('unhandledRejection', (reason) => {
    if (isTransientNetworkError(reason)) {
      const code = reason?.code || reason?.cause?.code || 'TRANSIENT_NETWORK_ERROR';
      console.warn(`[network-guard] Ignored transient unhandled transport failure: ${code}`);
      return;
    }

    console.error('[network-guard] Fatal unhandled rejection:', reason);
    // Preserve fail-fast behavior for real programming errors so Railway can restart
    // the service instead of leaving a corrupted process alive.
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  });
}

installTransientNetworkGuard();

module.exports = { installTransientNetworkGuard, isTransientNetworkError };
