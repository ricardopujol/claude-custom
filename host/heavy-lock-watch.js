'use strict';
/**
 * The side process of a waiting heavy-lock acquire (host/heavy-lock.js, WHILE IT WAITS; BACKLOG #178 b).
 *
 *   node host/heavy-lock-watch.js '<json: scriptPath, workFile, parentPid, parentStart, startedAt, everyMs, maxMs>'
 *
 * The asker is blocked in one synchronous `heavy-lock.ps1 -Acquire` call that prints nothing for up to 20 minutes. Every
 * `everyMs` this process
 *   - ends if its asker is gone (pid not running, or running with another start time): nobody is waiting any more;
 *   - prints one line to stderr: how long the asker has waited and who holds the slot, so a wait is visible in an output
 *     file (a background shell) and never reads as a hang;
 *   - frees a holder that died during the wait, by reclaimDead's rules (asker AND recorded work gone, "can't tell" is never
 *     "dead", a manual owner is never touched). The asker's own ticket then takes the slot in the script's next poll, so
 *     its place in the queue is kept.
 * It never acquires, and never releases anything but a provably dead holder. It ends on its own after `maxMs` (the wait
 * plus 2 minutes), and the asker stops it by its handle as soon as the acquire returns.
 */
const heavy = require('./heavy-lock');

// One watch step. 'asker-gone' ends the watcher; 'waiting' carries on.
function watchTick({ run, startsOf, work, log, parentPid, parentStart, startedAt, now = Date.now }) {
  let starts = null;
  try { starts = startsOf([parentPid]); } catch { /* can't tell: carry on */ }
  if (starts && heavy.isGone(starts, parentPid, parentStart)) return 'asker-gone';
  const mins = Math.floor((now() - startedAt) / 60000);
  let st = null;
  try { st = run([], { timeoutMs: heavy.STATUS_TIMEOUT_MS }); } catch { st = null; }
  const text = (st && st.stdout) || '';
  const held = /^held: (.*)$/m.exec(text);
  const waiting = (text.match(/^queue \d+:/gm) || []).length;
  const q = waiting ? `; ${waiting} waiting, this one included` : '';
  const load = /^load: (.*)$/m.exec(text);
  if (held) log(`[heavy-lock] waited ${mins} min so far for the lock, held by ${held[1].trim()}${q}`);
  // A free slot that isn't granted: an earlier ticket goes first, or the script's load gate (8 GB free RAM, under 70% CPU) holds it.
  else if (/^free$/m.test(text)) {
    const why = waiting > 1 ? 'an earlier ticket goes first, or the load gate' : 'the load gate: it needs 8 GB free RAM and under 70% CPU';
    log(`[heavy-lock] waited ${mins} min so far for the lock: the slot is free${q} (${why}${load ? `; now ${load[1].trim()}` : ''})`);
  } else log(`[heavy-lock] waited ${mins} min so far for the lock (its status could not be read)`);
  if (held) { try { heavy.reclaimDead({ run, startsOf, log, work }); } catch { /* the next tick tries again */ } }
  return 'waiting';
}

function main(cfg, { log = (m) => process.stderr.write(`${m}\n`), exit = (c) => process.exit(c) } = {}) {
  const run = heavy.defaultRun(cfg.scriptPath, { timeoutMs: heavy.STATUS_TIMEOUT_MS });
  const work = heavy.createWorkStore(cfg.workFile);
  const deps = { run, startsOf: (pids) => heavy.queryStarts(pids), work, log, parentPid: cfg.parentPid, parentStart: cfg.parentStart, startedAt: cfg.startedAt };
  const deadline = Date.now() + cfg.maxMs;
  const loop = () => {
    if (Date.now() > deadline || watchTick(deps) === 'asker-gone') return exit(0);
    setTimeout(loop, cfg.everyMs);
  };
  setTimeout(loop, cfg.everyMs);
}

module.exports = { watchTick, main };

if (require.main === module) {
  let cfg = null;
  try { cfg = JSON.parse(process.argv[2]); } catch { /* bad call */ }
  if (!cfg || !Number.isInteger(cfg.parentPid) || !(cfg.everyMs > 0) || !(cfg.maxMs > 0)) process.exit(2);
  main(cfg);
}
