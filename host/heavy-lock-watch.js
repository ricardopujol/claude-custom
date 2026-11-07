'use strict';
/**
 * The side process of a waiting heavy-lock acquire (host/heavy-lock.js, WHILE IT WAITS; BACKLOG #178 b).
 *
 *   node host/heavy-lock-watch.js '<json: scriptPath, workFile, parentPid, parentStart, startedAt, everyMs, maxMs>'
 *
 * The asker is blocked in one synchronous `heavy-lock.ps1 -Acquire` call that prints nothing for up to 20 minutes. Every
 * `everyMs` this process
 *   - ends if its asker is gone (process.kill(pid, 0) says ESRCH; no PowerShell): nobody is waiting any more;
 *   - prints one line to stderr: how long the asker has waited and who holds the slot, so a wait is visible in an output
 *     file (a background shell) and never reads as a hang;
 *   - frees a holder that died during the wait, by reclaimDead's rules (asker AND recorded work gone, "can't tell" is never
 *     "dead", a manual owner is never touched). The asker's own ticket then takes the slot in the script's next poll, so
 *     its place in the queue is kept.
 * It never acquires, and never releases anything but a provably dead holder. It ends on its own after `maxMs` (its one
 * -Acquire call's wait plus 2 minutes, a minute past that call's own kill timer), and the asker stops it by its handle as
 * soon as the acquire returns. A config without a pid, a script path, a start time, a cadence or a cap exits 2 at once.
 */
const heavy = require('./heavy-lock');

// Is the asker still running? process.kill(pid, 0) only tests liveness, as verify/lib/spinner.js does, and costs no
// PowerShell (#237 Miguel M1: a start query per tick per waiter fed the very load gate that kept them waiting). Only ESRCH
// is "gone"; EPERM (it runs, not ours to signal) or anything else is "can't tell", which carries on. A reused pid isn't
// caught here: the watcher's own cap (maxMs) is the net, and all it would do meanwhile is talk and free dead holders.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return !(err && err.code === 'ESRCH'); }
}

// One watch step. 'asker-gone' ends the watcher; 'waiting' carries on. The slot's status is read ONCE per tick and handed
// to the reclaim, so a tick costs one powershell, plus one start query only when a "(pid N start T)" holder is checked.
function watchTick({ run, startsOf, work, log, parentPid, startedAt, now = Date.now, alive = pidAlive }) {
  let up = true;
  try { up = alive(parentPid); } catch { /* can't tell: carry on */ }
  if (up === false) return 'asker-gone';
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
  if (held) { try { heavy.reclaimDead({ run, startsOf, log, work, status: text }); } catch { /* the next tick tries again */ } }
  return 'waiting';
}

// The loop: a tick every `everyMs`, ended by the deadline (`maxMs` after start) or by the asker being gone. The deadline is
// what guarantees an end when every tick says "can't tell, carry on" (#237 Dexter 9 a). Every outside effect is injectable.
function main(cfg, {
  log = (m) => process.stderr.write(`${m}\n`), exit = (c) => process.exit(c),
  run = heavy.defaultRun(cfg.scriptPath, { timeoutMs: heavy.STATUS_TIMEOUT_MS }),
  startsOf = (pids) => heavy.queryStarts(pids), work = heavy.createWorkStore(cfg.workFile),
  now = Date.now, setTimer = setTimeout, alive = pidAlive,
} = {}) {
  const deps = { run, startsOf, work, log, parentPid: cfg.parentPid, startedAt: cfg.startedAt, now, alive };
  const deadline = now() + cfg.maxMs;
  const loop = () => {
    if (now() > deadline || watchTick(deps) === 'asker-gone') return exit(0);
    setTimer(loop, cfg.everyMs);
  };
  setTimer(loop, cfg.everyMs);
}

// The command line's config, or null (#237 Miguel S9): a missing script path would run `powershell -File undefined` every
// tick, and a missing start time would print "NaN min".
function parseConfig(arg) {
  let cfg = null;
  try { cfg = JSON.parse(arg); } catch { return null; }
  const ok = cfg && typeof cfg === 'object'
    && Number.isInteger(cfg.parentPid) && cfg.parentPid > 0
    && typeof cfg.scriptPath === 'string' && cfg.scriptPath.length > 0
    && Number.isFinite(cfg.startedAt)
    && Number.isFinite(cfg.everyMs) && cfg.everyMs > 0
    && Number.isFinite(cfg.maxMs) && cfg.maxMs > 0;
  return ok ? cfg : null;
}

module.exports = { watchTick, main, parseConfig, pidAlive };

if (require.main === module) {
  const cfg = parseConfig(process.argv[2]);
  if (!cfg) process.exit(2);
  main(cfg);
}
