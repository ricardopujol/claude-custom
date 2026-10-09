'use strict';
/**
 * The Resources panel's Pause and Resume (BACKLOG #19, documentation/DESIGN_ROUND_2026-10-09B.md "Rounds 5-6"). Like Stop
 * (host/resource-stop.js) it acts on a PID with its start time, never on a name.
 *
 * `pause` judges the request with Stop's own guard (stopDecision: still in a freshly read table with the SAME start time, a
 * descendant of one of THIS window's session hosts, not claude, a host, a ConPTY or Electron), then suspends the guarded
 * subtree, root first (host/process-suspend.js re-proves each process on a held handle at the moment it suspends it). The
 * answer is believed only as far as it goes: the target must be reported suspended; if anything below it could not be, the
 * pause is rolled back (what was suspended is woken again) and said, never left half done.
 *
 * `resume` wakes exactly the set the pause suspended, from the store (host/pause-state.js), and forgets it only when it is
 * woken; a resume that did not go through keeps the process paused, narrowed to what is still suspended, so it can be tried
 * again. Nothing that was not paused here is ever resumed.
 *
 * A subtree that holds something already paused is refused ('already'): it would be suspended twice and one Resume would
 * leave it frozen. Two requests whose subtrees overlap cannot run at once ('busy').
 */

const { stopDecision, reasonText: stopText } = require('./resource-stop');
const { keyOf } = require('./pause-state');

const TEXT = {
  already: 'it is already paused (or part of it is)',
  busy: 'another pause or resume of it is still running',
  'not-paused': 'it is not paused',
  'suspend-failed': 'the pause did not go through',
  'resume-failed': 'the resume did not go through',
  reused: 'that PID now belongs to a different process',
  gone: 'Already exited',
  unavailable: 'pausing is not available',
};
const reasonText = reason => TEXT[reason] || stopText(reason);

const asKey = r => (r && Number.isInteger(r.pid) ? keyOf(r.pid, r.startTime) : null);
const asTarget = r => ({ pid: r.pid, start: r.start });

function createPauser({ readProcs, hostPids, suspend, store, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const busy = new Set();      // pids of the subtrees being paused or resumed right now
  const inflight = new Set();  // the pauses still running: a quit waits for them (a suspend that lands after the quit's wake-up is never woken)

  // A run that threw says nothing about what it did first: UNKNOWN, not "nothing was suspended" (host/process-suspend.js).
  const run = async (action, targets) => {
    try { return await suspend(action, targets); } catch (err) {
      return targets.map(t => ({ pid: t.pid, status: 'failed', unknown: true, text: (err && err.message) || 'the suspend could not be run' }));
    }
  };
  const refuse = (reason, extra) => ({ ok: false, reason, text: reasonText(reason), ...extra });

  // Wake `list` ([{ pid, start }], each by the start it was proved with). -> the ones that could NOT be woken ('failed'): still suspended.
  const wake = async (list) => {
    const targets = list.filter(t => typeof t.start === 'string').map(t => ({ pid: t.pid, start: t.start }));
    if (!targets.length) return [];
    const res = await run('resume', targets);
    return targets.filter(t => (res.find(r => r.pid === t.pid) || { status: 'failed' }).status === 'failed');
  };
  // Never leave a frozen pid unrecorded (PR #158 Dexter 2 / 9, Miguel Y1): what could not be woken stays in the store, root-less if need be,
  // so Resume, a quit and the next start can try again.
  const keep = (root, stuck) => {
    if (stuck.length) store.add({ pid: root.pid, start: root.start, name: root.name, since: root.since, pids: stuck }, { rootInSet: false });
  };

  async function pauseBody(request) {
    const key = asKey(request);
    if (key === null) return refuse('invalid');
    if (busy.has(request.pid)) return refuse('busy');
    busy.add(request.pid);
    let held = [];
    try {
      let procs;
      try { procs = await readProcs(); } catch { procs = null; }
      if (!Array.isArray(procs)) return refuse('unreadable');
      const d = stopDecision(request, procs, { sessionHostPids: hostPids(procs) });
      if (!d.ok) return refuse(d.reason);
      // Marks are taken only once the whole set is free: a refused request must not release the marks of the one in flight.
      if (d.kill.some(k => k.pid !== request.pid && busy.has(k.pid))) return refuse('busy');
      held = d.kill.map(k => k.pid);
      for (const pid of held) busy.add(pid);
      if (store.holdsAny(d.kill)) return refuse('already');

      // Each process is named by the start it was proved with: the one asked for, or (an `extra`) the one the script read.
      const results = (await run('suspend', d.kill)).map((r) => {
        const asked = d.kill.find(k => k.pid === r.pid);
        return typeof r.start === 'string' || !asked ? r : { ...r, start: asked.start };
      });
      const mine = results.find(r => r.pid === d.target.pid && r.extra !== true);
      const suspended = results.filter(r => r.status === 'done');
      // What the script may have suspended: what it said it did, and every asked process it said NOTHING about (a cutoff, a run that threw).
      const touched = results.filter(r => r.status === 'done' || (r.unknown === true && r.extra !== true));
      const root = { pid: d.target.pid, start: d.target.start, name: d.target.name };
      const stuckText = stuck => (stuck.length ? `; PID ${stuck.map(t => t.pid).join(', ')} could not be woken again` : '');
      if (!mine || mine.status !== 'done') {
        const stuck = await wake(touched);
        keep(root, stuck);
        if (mine && (mine.status === 'gone' || mine.status === 'reused') && !stuck.length) return refuse(mine.status);
        return refuse('suspend-failed', {
          text: `${reasonText('suspend-failed')}${mine && mine.text ? `: ${mine.text}` : ''}${stuckText(stuck)}`,
          ...(stuck.length ? { stuck: stuck.map(t => t.pid) } : {}),
        });
      }
      // A child that exited meanwhile ('gone') is fine; one that refused, said nothing, or is another process now makes the pause half done.
      const bad = results.filter(r => r.pid !== d.target.pid && r.extra !== true && (r.status === 'failed' || r.status === 'reused'));
      if (bad.length) {
        const stuck = await wake(touched);
        keep(root, stuck);
        const why = bad[0].text ? `: ${bad[0].text}` : '';
        log(`[pause] rolled back: PID ${bad[0].pid} ${bad[0].status}${why}${stuck.length ? `; still suspended: ${stuck.map(t => t.pid).join(', ')}` : ''}`);
        return refuse('suspend-failed', {
          text: `${reasonText('suspend-failed')} (PID ${bad[0].pid} could not be suspended${why})${stuckText(stuck)}`,
          ...(stuck.length ? { stuck: stuck.map(t => t.pid) } : {}),
        });
      }
      const added = store.add({ ...root, pids: suspended.filter(r => typeof r.start === 'string').map(r => ({ pid: r.pid, start: r.start })) });
      if (!added.ok) {
        keep(root, await wake(suspended));
        return refuse(added.reason === 'already' ? 'already' : 'suspend-failed');
      }
      return { ok: true, pid: d.target.pid, name: d.target.name, since: added.since };
    } finally {
      busy.delete(request.pid);
      for (const pid of held) busy.delete(pid);
    }
  }

  function pause(request) {
    const p = pauseBody(request);
    inflight.add(p);
    p.then(() => inflight.delete(p), () => inflight.delete(p));
    return p;
  }

  async function resume(request) {
    const key = asKey(request);
    if (key === null) return refuse('invalid');
    if (busy.has(request.pid)) return refuse('busy');
    const entry = store.take(request.pid, request.startTime);
    if (!entry) return refuse('not-paused');
    busy.add(request.pid);
    try {
      const results = await run('resume', entry.pids);
      const still = results.filter(r => r.status === 'failed');
      if (still.length) {
        // Keep it paused, narrowed to what is still suspended.
        store.restore({ ...entry, pids: entry.pids.filter(p => still.some(r => r.pid === p.pid)) });
        const why = still[0].text ? `: ${still[0].text}` : '';
        log(`[pause] resume of PID ${entry.pid} incomplete: ${still.map(r => r.pid).join(', ')} still suspended${why}`);
        return refuse('resume-failed', { text: `${reasonText('resume-failed')} (PID ${still[0].pid}${why})` });
      }
      const mine = results.find(r => r.pid === entry.pid);
      if (mine && (mine.status === 'gone' || mine.status === 'reused')) return refuse(mine.status);
      return { ok: true, pid: entry.pid };
    } finally {
      busy.delete(request.pid);
    }
  }

  // The app is quitting: wake everything this window paused, so a quit never leaves a process frozen with nobody to wake it. A pause still in
  // flight is waited for first (its suspend would otherwise land after this wake-up). All entries at once, and no longer than `deadlineMs` in
  // all (PR #158 Miguel Y2): the quit is held for this and must not hang on a PowerShell that does not answer. -> { resumed, failed, timedOut?, left? }
  async function resumeAll({ deadlineMs = 10000 } = {}) {
    let resumed = 0;
    let failed = 0;
    const work = (async () => {
      await Promise.allSettled([...inflight]);
      await Promise.all(store.list().map(async (e) => {
        const r = await resume({ pid: e.pid, startTime: e.start });
        if (r.ok) resumed++;
        else if (r.reason === 'resume-failed') failed++;
      }));
      return 'done';
    })();
    let timer;
    const cutoff = new Promise((res) => { timer = setTimer(() => res('timeout'), deadlineMs); });
    const how = await Promise.race([work, cutoff]);
    clearTimer(timer);
    if (how === 'timeout') log(`[pause] quit: the wake-up did not finish in ${deadlineMs} ms; ${store.list().length} still recorded`);
    return how === 'timeout' ? { resumed, failed, timedOut: true, left: store.list().length } : { resumed, failed };
  }

  // Wake `pids` of an entry whose root is gone, or that an earlier run left behind: each by its proved start (a pid that is another process
  // now answers 'reused', nothing is touched). What could not be woken is recorded again.
  async function wakeEntry(e, pids) {
    const stuck = await wake(pids);
    keep({ pid: e.pid, start: e.start, name: e.name, since: e.since }, stuck);
    return stuck;
  }
  /** Members of ended entries whose root left but which are still alive and suspended (host/pause-state.js reconcile). */
  async function wakeOrphans(ended) {
    let woken = 0;
    let stuck = 0;
    for (const e of Array.isArray(ended) ? ended : []) {
      if (!Array.isArray(e.alive) || e.alive.length === 0) continue;
      const left = await wakeEntry(e, e.alive);
      woken += e.alive.length - left.length;
      stuck += left.length;
      log(`[pause] ${e.alive.length} suspended process(es) of PID ${e.pid} outlived it: ${e.alive.length - left.length} woken, ${left.length} still suspended`);
    }
    return { woken, stuck };
  }
  /** Entries a dead run of the app left on disk (host/pause-persist.js takeDead): wake them all. */
  async function wakeStale(entries) {
    let stuck = 0;
    for (const e of Array.isArray(entries) ? entries : []) stuck += (await wakeEntry(e, e.pids)).length;
    return { stuck };
  }

  return { pause, resume, resumeAll, wakeOrphans, wakeStale, pending: () => inflight.size };
}

module.exports = { createPauser, reasonText };
