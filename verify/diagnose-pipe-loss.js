'use strict';
/* measure-hook-latency.js delivered only 4 of 35 events for EVERY helper, and
   the native timings sat at roughly (process startup + the 80ms connect
   timeout). That points at the bridge refusing connections rather than at slow
   helpers. This isolates which.

   Counts, per sequential invocation: did the server see a connection at all,
   and did a parsed event follow it. */
const { spawnSync } = require('child_process');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');

const REPO = path.join(__dirname, '..');
const NATIVE = path.join(REPO, '.harness', 'hook-helper.exe');
const PIPE = `\\\\.\\pipe\\claude-custom-diag-${process.pid}`;
const N = 12;

let connections = 0, events = 0, errors = [];

const bridge = new EventEmitter();
const server = net.createServer((sock) => {
  connections++;
  let buf = '';
  sock.on('data', c => {
    buf += c.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { JSON.parse(line); events++; } catch (e) { errors.push('parse'); } }
    }
  });
  sock.on('error', e => errors.push('sock:' + e.code));
});
server.on('error', e => errors.push('server:' + e.code));

server.listen(PIPE, () => {
  console.log('bridge listening on', PIPE, '\n');

  const run = (label, extraDelayMs) => {
    connections = 0; events = 0; errors = [];
    const times = [];
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      spawnSync(NATIVE, ['--pipe', PIPE, '--event', 'PreToolUse'], {
        input: '{"tool_name":"Agent"}', windowsHide: true,
      });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (extraDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, extraDelayMs);
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    setTimeout(() => {
      console.log(`${label}`);
      console.log(`  connections seen : ${connections}/${N}`);
      console.log(`  events parsed    : ${events}/${N}`);
      console.log(`  mean wall time   : ${mean.toFixed(1)}ms`);
      console.log(`  errors           : ${errors.length ? errors.slice(0, 5).join(', ') : 'none'}\n`);
    }, 300);
  };

  run('back-to-back (no gap)', 0);
  setTimeout(() => run('with 50ms gap between invocations', 50), 1200);
  setTimeout(() => { server.close(); process.exit(0); }, 4000);
});
