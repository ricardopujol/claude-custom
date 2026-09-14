'use strict';
/* Do the per-agent career figures actually reach a client?

   Every headless check of this path passes trivially -- readAgentStats is a
   pure read and its tests are green. What this asks is the question those
   cannot: does the number survive the handshake, the control channel and the
   gatekeeper, and arrive at something that could draw it.

   That distinction is not academic here. The usage counter shipped with
   exactly one defect of this shape: the figure was computed correctly, carried
   correctly, and then never reached a client that attached before the first
   read landed -- because the boot broadcast fires with no clients and the
   refresh is gated on a change that had already happened. */
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const WebSocket = require('ws');
const REPO = 'C:/Users/ricar/VibeCode/claude-custom';
const PORT = 7811;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const token = () => { try { return fs.readFileSync(path.join(REPO,'.harness','session-token'),'utf8').trim(); } catch { return ''; } };

(async () => {
  const host = spawn(process.execPath, [path.join(REPO,'host','host.js')],
    { cwd: REPO, env: { ...process.env, CLAUDE_CUSTOM_PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(6000);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}?token=${encodeURIComponent(token())}`);
  let hello = null, pushed = null;
  ws.on('message', (d, isBin) => {
    if (isBin) return;
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.type === 'hello') hello = m;
    if (m.type === 'agentStats') pushed = m.stats;
  });
  await new Promise(r => ws.on('open', r));
  await sleep(4000);
  const stats = (hello && hello.agentStats) || pushed;
  console.log('hello carried agentStats :', !!(hello && hello.agentStats && hello.agentStats.agents));
  console.log('pushed agentStats        :', !!pushed);
  if (stats && stats.agents && stats.agents.length) {
    console.log('ok=' + stats.ok, 'unresolved=' + stats.unresolved);
    for (const a of stats.agents.slice(0,5))
      console.log('   ' + a.agent.padEnd(20), String(a.runs).padStart(3)+' runs',
        ((a.tokens/1e6).toFixed(1)+'M').padStart(8), (Math.round(a.ms/60000)+'m').padStart(6));
  } else console.log('NO AGENTS IN PAYLOAD');
  ws.close(); host.kill();
  process.exit(0);
})();
