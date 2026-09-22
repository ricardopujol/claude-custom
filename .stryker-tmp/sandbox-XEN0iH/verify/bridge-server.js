// @ts-nocheck
'use strict';
/* Standalone bridge process for the latency benchmark.

   It MUST be a separate process. Running the bridge in the same process that
   spawns the helpers means spawnSync blocks the event loop, the server cannot
   accept, and every connect past libuv's pre-created pipe instances times out.
   That is what made the first benchmark report 4/35 delivery and ~158ms
   "native" timings that were really the helper's 80ms connect timeout.

   Production has the same shape as this: the host is its own process and its
   event loop is free while Claude Code spawns a hook. */
const { createHookBridge } = require('../host/hook-bridge');

const pipeName = process.argv[2];
let events = 0, parseErrors = 0, lastPayload = null;

(async () => {
  const bridge = createHookBridge({ pipeName });
  await bridge.listening;
  bridge.on('event', e => { events++; lastPayload = e; });
  bridge.on('parse-error', () => { parseErrors++; });

  process.on('message', msg => {
    if (msg === 'stats') process.send({ events, parseErrors, lastPayload });
    if (msg === 'reset') { events = 0; parseErrors = 0; process.send({ reset: true }); }
    if (msg === 'quit') bridge.close().then(() => process.exit(0));
  });

  process.send({ ready: true });
})();
