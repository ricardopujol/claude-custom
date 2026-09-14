'use strict';
/* Node equivalent of the native helper, kept ONLY as the latency baseline the
   design's "Node costs 60-100ms" claim is measured against. Not shipped. */
const net = require('net');

let pipe = null, evt = null;
for (let i = 0; i < process.argv.length - 1; i++) {
  if (process.argv[i] === '--pipe') pipe = process.argv[i + 1];
  else if (process.argv[i] === '--event') evt = process.argv[i + 1];
}
if (!pipe || !evt) process.exit(0);

let payload = '';
try { payload = require('fs').readFileSync(0, 'utf8').trim(); } catch {}
if (!payload) payload = '{}';

const sock = net.connect(pipe, () => {
  sock.end(JSON.stringify({ event: evt, payload: JSON.parse(payload) }) + '\n');
});
sock.on('error', () => process.exit(0));
sock.on('close', () => process.exit(0));
setTimeout(() => process.exit(0), 200).unref();
