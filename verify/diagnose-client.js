'use strict';
/* Is the 4-connection ceiling in the SERVER or in the C# client? Same server,
   same count, three clients: the C# exe, a spawned Node script, and an
   in-process Node connect (no spawn cost at all, isolating the protocol). */
const { spawnSync } = require('child_process');
const path = require('path');
const net = require('net');

const NATIVE = path.join(__dirname, '..', '.harness', 'hook-helper.exe');
const NODEH = path.join(__dirname, '..', 'helper', 'hook-helper.js');
const N = 12;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PIPE_PREFIX = ['', '', '.', 'pipe', ''].join('\\');   // \\.\pipe\
const pipeName = tag => PIPE_PREFIX + 'cc-diagc-' + process.pid + '-' + tag;

function server() {
  let connections = 0, events = 0;
  const s = net.createServer(sock => {
    connections++;
    let buf = '';
    sock.on('data', c => {
      buf += c.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const l = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (l) { try { JSON.parse(l); events++; } catch {} }
      }
    });
    sock.on('error', () => {});
  });
  return { s, stats: () => ({ connections, events }) };
}

function inProcClient(pipe) {
  return new Promise(resolve => {
    const sock = net.connect(pipe, () =>
      sock.end(JSON.stringify({ event: 'PreToolUse', payload: {} }) + '\n'));
    sock.on('close', resolve);
    sock.on('error', () => resolve());
  });
}

(async () => {
  console.log('pipe prefix:', JSON.stringify(PIPE_PREFIX), '\n');

  const drivers = [
    ['C# exe (spawned)', async p => {
      for (let i = 0; i < N; i++)
        spawnSync(NATIVE, ['--pipe', p, '--event', 'PreToolUse'], { input: '{}', windowsHide: true });
    }],
    ['node (spawned)', async p => {
      for (let i = 0; i < N; i++)
        spawnSync(process.execPath, [NODEH, '--pipe', p, '--event', 'PreToolUse'], { input: '{}', windowsHide: true });
    }],
    ['node (in-process)', async p => {
      for (let i = 0; i < N; i++) await inProcClient(p);
    }],
  ];

  for (const [label, drive] of drivers) {
    const pipe = pipeName(label.replace(/\W+/g, ''));
    const { s, stats } = server();
    await new Promise(r => s.listen(pipe, r));
    await drive(pipe);
    await sleep(400);
    const st = stats();
    console.log(label.padEnd(20), `connections ${st.connections}/${N}  events ${st.events}/${N}`);
    await new Promise(r => s.close(r));
  }
  process.exit(0);
})();
