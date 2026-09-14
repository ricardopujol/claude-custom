'use strict';
/* Exactly 4 connections succeed then none, independent of pacing -- libuv's
   default pending named-pipe instance count. Question: are instances never
   recycled, and does explicitly releasing the server-side socket recycle them?

   Three server variants, same client, same load. */
const { spawnSync } = require('child_process');
const path = require('path');
const net = require('net');

const NATIVE = path.join(__dirname, '..', '.harness', 'hook-helper.exe');
const N = 12;

function makeServer(variant, pipe) {
  let connections = 0, events = 0;
  const server = net.createServer((sock) => {
    connections++;
    let buf = '';
    sock.on('data', c => {
      buf += c.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { JSON.parse(line); events++; } catch {} }
      }
      if (variant === 'destroy-after-data') sock.destroy();
    });
    if (variant === 'end-on-end') sock.on('end', () => sock.end());
    sock.on('error', () => {});
  });
  return { server, stats: () => ({ connections, events }) };
}

function drive(pipe) {
  for (let i = 0; i < N; i++) {
    spawnSync(NATIVE, ['--pipe', pipe, '--event', 'PreToolUse'],
      { input: '{"tool_name":"Agent"}', windowsHide: true });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  for (const variant of ['baseline', 'end-on-end', 'destroy-after-data']) {
    const pipe = `\\\\.\\pipe\\claude-custom-var-${process.pid}-${variant}`;
    const { server, stats } = makeServer(variant, pipe);
    await new Promise(r => server.listen(pipe, r));
    drive(pipe);
    await sleep(400);
    const s = stats();
    console.log(`${variant.padEnd(20)} connections ${s.connections}/${N}  events ${s.events}/${N}`);
    await new Promise(r => server.close(r));
  }
  process.exit(0);
})();
