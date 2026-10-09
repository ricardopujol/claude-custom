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

function createPauser({ readProcs, hostPids, suspend, store, log = () => {} }) {
  const busy = new Set();      // pids of the subtrees being paused or resumed right now

  const run = async (action, targets) => {
    try { return await suspend(action, targets); } catch (err) {
      return targets.map(t => ({ pid: t.pid, status: 'failed', text: (err && err.message) || 'the suspend could not be run' }));
    }
  };
  const refuse = (reason, extra) => ({ ok: false, reason, text: reasonText(reason), ...extra });

  // Wake what was suspended, by the start each was proved with; extras carry the start the script read.
  const wake = async (done) => {
    const targets = done.filter(r => typeof r.start === 'string').map(r => ({ pid: r.pid, start: r.start }));
    return targets.length ? run('resume', targets) : [];
  };

  async function pause(request) {
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
      if (!mine || mine.status !== 'done') {
        if (suspended.length) await wake(suspended);
        if (mine && (mine.status === 'gone' || mine.status === 'reused')) return refuse(mine.status);
        return refuse('suspend-failed', { text: `${reasonText('suspend-failed')}${mine && mine.text ? `: ${mine.text}` : ''}` });
      }
      // A child that exited meanwhile ('gone') is fine; one that refused, or is another process now, makes the pause half done.
      const bad = results.filter(r => r.pid !== d.target.pid && (r.status === 'failed' || r.status === 'reused'));
      if (bad.length) {
        const back = await wake(suspended);
        const stuck = suspended.filter(r => !back.some(b => b.pid === r.pid && (b.status === 'done' || b.status === 'gone')) ).map(r => r.pid);
        const why = bad[0].text ? `: ${bad[0].text}` : '';
        log(`[pause] rolled back: PID ${bad[0].pid} ${bad[0].status}${why}${stuck.length ? `; still suspended: ${stuck.join(', ')}` : ''}`);
        return refuse('suspend-failed', {
          text: `${reasonText('suspend-failed')} (PID ${bad[0].pid} could not be suspended${why})${stuck.length ? `; PID ${stuck.join(', ')} could not be woken again` : ''}`,
          ...(stuck.length ? { stuck } : {}),
        });
      }
      const added = store.add({
        pid: d.target.pid, start: d.target.start, name: d.target.name,
        pids: suspended.filter(r => typeof r.start === 'string').map(r => ({ pid: r.pid, start: r.start })),
      });
      if (!added.ok) {
        await wake(suspended);
        return refuse(added.reason === 'already' ? 'already' : 'suspend-failed');
      }
      return { ok: true, pid: d.target.pid, name: d.target.name, since: store.list().find(e => e.pid === d.target.pid && e.start === d.target.start).since };
    } finally {
      busy.delete(request.pid);
      for (const pid of held) busy.delete(pid);
    }
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

  // The app is quitting: wake everything this window paused, so a quit never leaves a process frozen with nobody to wake it.
  async function resumeAll() {
    let resumed = 0;
    let failed = 0;
    for (const e of store.list()) {
      const r = await resume({ pid: e.pid, startTime: e.start });
      if (r.ok) resumed++;
      else if (r.reason === 'resume-failed') failed++;
    }
    return { resumed, failed };
  }

  return { pause, resume, resumeAll };
}

module.exports = { createPauser, reasonText };
