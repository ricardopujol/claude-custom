// @ts-nocheck
'use strict';
/**
 * Receives hook events from the native helper over a Windows named pipe.
 *
 * The helper is spawned by Claude Code once per matched tool call, writes a
 * single newline-terminated JSON line, and exits. This bridge is the long-lived
 * listener on the other end, feeding the mood state machine.
 *
 * It lives in the host process, so it is written to survive bad input rather
 * than propagate it: a hook emitting junk must never take the session down.
 */

const net = require('net');
const { EventEmitter } = require('events');

function createHookBridge({ pipeName }) {
  if (!pipeName) throw new Error('createHookBridge: pipeName is required');

  const bridge = new EventEmitter();
  const sockets = new Set();

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sockets.delete(sock));

    // A pipe write can split anywhere, so events are reassembled by newline
    // rather than parsed per chunk.
    let buffer = '';
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          bridge.emit('event', JSON.parse(line));
        } catch (err) {
          bridge.emit('parse-error', { line, error: err });
        }
      }
    });
  });

  server.on('error', err => bridge.emit('error', err));

  bridge.listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, () => resolve(bridge));
  });

  bridge.close = () =>
    new Promise((resolve) => {
      for (const s of sockets) { try { s.destroy(); } catch {} }
      sockets.clear();
      server.close(() => resolve());
    });

  return bridge;
}

module.exports = { createHookBridge };
