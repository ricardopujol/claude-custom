'use strict';
/* Q2 latency comparison point ONLY -- not shipped, not the C# helper.

   Identical to helper/hook-helper.js (Node baseline: connect, write the
   payload, exit) EXCEPT it also prints the
   { hookSpecificOutput: { hookEventName, updatedInput } } JSON line to
   stdout before exiting, exactly as an FF9 item-rewriting hook would.
   verify/measure-updated-input-latency.js benchmarks this against the
   unmodified Node baseline to isolate what the extra stdout write costs. */
const net = require('net');
const fs = require('fs');

let pipe = null, evt = null;
for (let i = 0; i < process.argv.length - 1; i++) {
  if (process.argv[i] === '--pipe') pipe = process.argv[i + 1];
  else if (process.argv[i] === '--event') evt = process.argv[i + 1];
}
if (!pipe || !evt) process.exit(0);

let payload = '';
try { payload = fs.readFileSync(0, 'utf8').trim(); } catch { /* no stdin */ }
if (!payload) payload = '{}';

let parsed = {};
try { parsed = JSON.parse(payload); } catch { /* keep {} */ }

let done = false;
function finish() {
  if (done) return;
  done = true;
  const updatedInput = { ...(parsed.tool_input || {}), model: 'haiku' };
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput },
  }));
  process.exit(0);
}

const sock = net.connect(pipe, () => {
  sock.end(JSON.stringify({ event: evt, payload: parsed }) + '\n');
});
sock.on('error', finish);
sock.on('close', finish);
setTimeout(finish, 200).unref();
