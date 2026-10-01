'use strict';
/**
 * Is a host listening on this port? Three answers, because the tab shell
 * removes a merged worktree's folder on ONE poll that says its host is gone
 * (host/tab-lifecycle.js, `listening: false`). PR 3, plan S3.
 *
 *   'listening'  something accepted the connection
 *   'refused'    ECONNREFUSED on 127.0.0.1: nothing is bound there. A host
 *                exits with its `claude` (host/host.js t.onExit), so this is
 *                "the session ended".
 *   'unknown'    a timeout, any other error, or a port that isn't one. A busy
 *                host can be slow to accept; that is NOT "gone".
 *
 * Collapsing timeout into refused would delete a folder because a machine was
 * busy. Never throws; always destroys its socket.
 */

const DEFAULT_TIMEOUT_MS = 400;

const isPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;

function probePort(port, { net = require('net'), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!isPort(port)) return resolve('unknown');
    let sock;
    try {
      sock = net.connect({ host: '127.0.0.1', port });
    } catch {
      return resolve('unknown');
    }
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve(answer);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish('listening'));
    sock.once('timeout', () => finish('unknown'));
    sock.once('error', (err) => finish(err && err.code === 'ECONNREFUSED' ? 'refused' : 'unknown'));
  });
}

module.exports = { probePort, DEFAULT_TIMEOUT_MS };
