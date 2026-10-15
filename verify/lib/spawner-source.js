'use strict';
/**
 * The program (for `node <file>`) that a straddle test runs as its "user command": it starts a new marked sleeper every
 * `intervalMs`, so a tree kill that reads the tree once loses one (BACKLOG #72/#73).
 *
 * It must be cheap when nobody ends it (PR #135 Dexter N1: an orphaned spawner made thousands of live node.exe):
 *   - it exits when its parent is gone (polled every second), which is how a killed probe or test run ends it;
 *   - it keeps at most `liveMax` sleepers alive: past that it ends its OLDEST first, so spawning goes on (the straddle
 *     still happens at any moment) while the machine's cost stays flat;
 *   - and a wall-clock deadline far past any trial is the last backstop.
 * `statsFile`, when given, gets `{"spawned":n,"live":n}` once a second (the tests read it).
 */
function spawnerSource({ sleeperSrc, marker, readyFile, intervalMs, deadlineMs = 600000, parentPid, liveMax = 200, detached = false, statsFile = null }) {
  return `const { spawn } = require('child_process');
const fs = require('fs');
const t0 = Date.now();
const live = [];
let n = 0;
setInterval(() => {
  const c = spawn(process.execPath, ['-e', ${JSON.stringify(sleeperSrc)}, ${JSON.stringify(marker)}], { stdio: 'ignore', windowsHide: true${detached ? ', detached: true' : ''} });
  ${detached ? 'c.unref();' : ''}
  c.on('exit', () => { const i = live.indexOf(c); if (i >= 0) live.splice(i, 1); });
  live.push(c);
  while (live.length > ${Number(liveMax)}) { try { live.shift().kill(); } catch {} }
  if (++n === 3) fs.writeFileSync(${JSON.stringify(readyFile)}, 'ok');
  if (Date.now() - t0 > ${Number(deadlineMs)}) process.exit();
}, ${Number(intervalMs)});
setInterval(() => {
  try { process.kill(${Number(parentPid)}, 0); } catch (e) { if (e.code !== 'EPERM') process.exit(); }
  ${statsFile ? `try { fs.writeFileSync(${JSON.stringify(statsFile)}, JSON.stringify({ spawned: n, live: live.length })); } catch {}` : ''}
}, 1000);
`;
}

module.exports = { spawnerSource };
