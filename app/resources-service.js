'use strict';
/**
 * What main does with the resource sampler (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md): which of this
 * window's pages want the panel, the payload every page gets, the per-tab warning counters, and Stop. Everything
 * it touches (the sampler, the tab list, the identity files, the IPC send, the kill) is handed in, so the whole
 * of it is tested without Electron; app/main.js only builds those and registers the IPC.
 *
 * WHO WANTS WHAT (Round 3 Q1, Ricardo, PR #113: this supersedes the design's "only while the panel is shown"). The full
 * sample, the process tree, runs ALWAYS, every 10 s, panel open or not, so the tab warning works with the panel closed.
 * It stops only while the window is minimised. What a page says about its own panel decides nothing.
 *
 * THE WARNING needs the process tree. When the full sample stops (the window is minimised, or three samples in a row
 * failed) the counters are cleared and the strip told, rather than leaving a chip with an old percentage on it: a number
 * nobody can measure any more is not a warning.
 */

const sample = require('../host/resource-sample');
const model = require('../host/resource-model');
const tree = require('../host/resource-tree');
const warning = require('../host/resource-warning');
const stopper = require('../host/resource-stop');
const { createHistory } = require('../host/resource-history');
const leftovers = require('../host/leftovers');
const taskLogsLib = require('../host/task-logs');

const HALF_CADENCE_MS = 5000;

const basename = (p) => {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
};

function createResourcesService({
  sampler, tabs, claims, installDirs, ownPid, cores, labelOf = basename, send, kill,
  refreshStrip = () => {}, now = Date.now, log = () => {},
  // The history is ordered and spaced by a MONOTONIC clock (ms), never the wall clock: one wall-clock step must not freeze it (PR #114 D1).
  mono = () => performance.now(),
  // Q2: the top-bar chip's on/off, kept install-wide. `read()` -> true | false | null (null: never set or unreadable), `write(on)`.
  chipStore = { read: () => null, write: () => {} },
  // The warning's CPU threshold, 40 by default. A verification seam (CLAUDE_CUSTOM_RESOURCE_WARN_AT in app/main.js), so a
  // probe on a busy machine can show the chip without pinning 40% of it; nothing in the UI sets it.
  warnAt = warning.THRESHOLD,
  // Leftovers (#74 item 6): `ledger()` -> the pid ledger's entries (host/pid-ledger.js readLedger); `reap` = the seams of
  // host/leftovers.js createReaper: { kill(pid, start) (host/kill-tree.js killProvenAsync), launcherGone(entry), isRunning(pid, start),
  // removeEntries(entries) }. With no `reap` the readout is shown and nothing is ever stopped, by the clock or by a click.
  ledger = () => [], reap = null,
  // Big task-output files (#74 F(3)): { scan() -> files (host/task-logs-fs.js scanTaskFiles), registry() -> { ok, entries },
  // remove(row) -> { deleted, failed, kept, freed } (the one guarded delete), everyMs }. Scanned on its own slow cadence, stat
  // only. With no `taskLogs` the group is simply absent.
  taskLogs = null,
}) {
  let minimised = false;
  let warnings = new Map();    // tab key -> host/resource-warning.js state
  let lastPayload = null;
  let chipOn = chipStore.read() !== false;   // ON by default: only a stored real `false` turns it off
  let lastLight = null;        // the same payload with no process model: what a page that is not showing the panel gets
  let lastSignature = '';
  const history = createHistory();   // the one-hour sparklines' data: in memory only, starts empty after a restart
  let lastRecordedSample = null;   // the sample object a point was last made from: a re-sent old one makes none
  let lastRecordMono = -Infinity;
  const reaper = reap ? leftovers.createReaper({ ...reap, now, log }) : null;
  const tracker = leftovers.createTracker({ now });
  let lastFound = null;           // the latest sample's leftovers (with their ledger entries): what a manual Stop is resolved against
  let tl = { files: [], registry: null, at: -Infinity, busy: false };   // the last task-output scan (stat only), when it ended, whether one is in flight
  let tlSeq = 0;               // fresh, full, non-stale samples counted so far (a re-sent old sample object counts once)
  let tlLastSample = null;
  let tlPending = null;        // a task-folder read waiting for a process sample taken wholly after it: { files, registry, afterSeq, at }
  let tlListed = null;         // the pids of the latest full, fresh sample: what "a session is alive" is judged against; null: nothing may be deleted
  const tlSeen = new Map();    // session id -> [{ pid, start }]: the processes the app SAW the session alive under; only these can be seen to END
  const tlBackoff = new Map(); // key -> when the app may try that file again after a delete that did not finish (locked, a live writer, a partial link set)
  const TL_BACKOFF_MS = 30 * 60_000;
  const tlObs = new Map();     // key -> { mtimeMs, bytes, ageAtSeen, monoSeen, first }: when this exact file state was first seen, on the MONOTONIC clock
  const tlDeleted = [];        // { name, bytes, at } of the files deleted lately (shown for an hour, like Stopped)
  const TL_EVERY_MS = (taskLogs && taskLogs.everyMs) || 60_000;
  let lastStepped = null;      // the sample the counters last stepped on: a re-sent old one must not step them again

  // A minimised window wants nothing: the page's visibility is a second witness the app does not trust alone
  // (app/playback-bridge.js), so a page that still says "showing" does not keep the process tree sampled.
  // Q1 (Ricardo, PR #113): the process tree is sampled ALWAYS, panel open or not, so the tab warning works with it closed.
  // The one exception is a minimised window.
  const panelWanted = () => !minimised;
  function refresh() { sampler.setWanted({ panel: panelWanted(), chip: !minimised }); }

  const tabList = () => (typeof tabs === 'function' ? tabs() : []).map(t => ({
    key: t.key, port: t.port, label: t.branch ? t.branch : basename(t.cwd),
  }));
  const hostOfPort = (proven, port) => {
    const h = proven.find(x => x.port === port);
    return h ? h.pid : null;
  };

  // The signature of what the strip draws, so it is told only when a chip appears, goes, or changes.
  function warnSignature() {
    return JSON.stringify([...warnings].filter(([, s]) => s.on).map(([k, s]) => [k, s.level, Math.round(s.pct)]));
  }
  function setWarnings(next) {
    warnings = next;
    const sig = warnSignature();
    if (sig === lastSignature) return;
    lastSignature = sig;
    try { refreshStrip(); } catch (err) { log('[resources] refreshStrip threw:', err && err.message); }
  }

  // One point per fresh sample; a failed one is a null point (a break in the line, never a 0). A re-sent old sample adds nothing.
  // Stop's off-cadence re-read adds its point only when it stands in for a cadence slot (the tick that fired while it was in
  // flight joined it and emits no sample of its own, PR #114 D4): when the last point is under half a cadence old it adds none.
  // A minimised window records nothing; setMinimised marks the break.
  function record(snap, built, machine) {
    const at = Math.round(mono());
    if (snap.adhoc === true && (snap.failures > 0 || at - lastRecordMono < HALF_CADENCE_MS)) return;
    if (snap.failures > 0) { history.recordFailure(at, now()); lastRecordMono = at; return; }
    const sampleObj = snap.machine && snap.machine.last;
    if (!sampleObj || sampleObj === lastRecordedSample || !machine) return;
    lastRecordedSample = sampleObj;
    lastRecordMono = at;
    const ours = built && built.machine ? built.machine.ours : null;
    history.record({
      at, wall: now(), cpu: machine.cpu,
      cpuOurs: ours ? ours.cpu : null, memOurs: ours ? ours.bytes : null,
      memUsed: machine.mem ? machine.mem.usedBytes : null, memTotal: machine.mem ? machine.mem.totalBytes : null,
    });
  }

  // Only the SELECTED page's payload carries the history (the other pages' chips aren't on screen), as one copy; `historyNow`
  // is the monotonic time the points are measured against.
  const withHistory = full => (full ? { ...full, history: history.points(), historyNow: Math.round(mono()) } : full);

  // ---- big task-output files (#74 F(3), host/task-logs.js decides, host/task-logs-fs.js touches the disk) ----
  // A null process table is passed on as null: classify reads it as "unknown", never as "everything is gone".
  // A file the app tried to delete and could not (locked, a writer still at it, some links left) reads "locked" and is not retried by
  // the clock for TL_BACKOFF_MS (Miguel I5); the person's Delete still tries it.
  const tlClassify = (listed = tlListed, read = tl) => taskLogsLib.classify({ files: read.files, registry: read.registry, listedPids: listed, seen: tlSeen, monoAge: tlMonoAge, now: now() })
    .map((r) => {
      const until = tlBackoff.get(r.key);
      if (until === undefined || now() >= until || r.why !== 'delete') return r;
      return { ...r, why: 'locked', deletable: false };
    });
  // A session whose registry entry names a running pid is alive now; remember it, so a later absence is an END that was observed.
  function tlMarkSeen(listed, read) {
    // "Ended" later means THAT pid is gone (or another process has it), never that a registry stopped listing the session.
    for (const { sessionId, pid, start } of taskLogsLib.aliveEntries(read.registry, listed)) {
      const recs = tlSeen.get(sessionId) || [];
      if (!recs.some(r => r.pid === pid && r.start === start)) tlSeen.set(sessionId, [...recs, { pid, start }]);
    }
  }
  // How long a file state has been idle by the monotonic clock (a wall-clock step cannot move it): its wall age at the first sighting
  // plus the monotonic time since. null until a SECOND judged read has seen the same size and mtime (Dexter #4).
  function tlMonoAge(key) {
    const o = tlObs.get(key);
    return !o || o.first ? null : o.ageAtSeen + (mono() - o.monoSeen);
  }
  function tlObserve(rows) {
    const t = mono();
    const keep = new Set();
    for (const r of rows) {
      keep.add(r.key);
      const o = tlObs.get(r.key);
      if (!o || o.mtimeMs !== r.mtimeMs || o.bytes !== r.bytes) tlObs.set(r.key, { mtimeMs: r.mtimeMs, bytes: r.bytes, ageAtSeen: Number.isFinite(r.ageMs) ? r.ageMs : 0, monoSeen: t, first: true });
      else o.first = false;
    }
    for (const k of [...tlObs.keys()]) if (!keep.has(k)) tlObs.delete(k);
  }
  function tlShownDeleted() {
    const t = now();
    for (let i = tlDeleted.length - 1; i >= 0; i--) if (t - tlDeleted[i].at >= 60 * 60_000) tlDeleted.splice(i, 1);
    while (tlDeleted.length > 10) tlDeleted.shift();
    return tlDeleted;
  }
  async function tlRemove(rows) {
    let ok = 0;
    for (const row of rows) {
      const res = await taskLogs.remove(row);
      const whole = !!res && !res.kept && !res.failed && !res.locked && (res.deleted > 0 || res.gone > 0);
      if (whole) {
        ok++;
        tlBackoff.delete(row.key);
        tl.files = tl.files.filter(f => !row.paths.includes(f.path));
        // Only what this call removed is listed as deleted; a link another window had already removed is not ours to report.
        if (res.deleted > 0) tlDeleted.push({ name: row.name, project: row.project, bytes: res.freed > 0 ? res.freed : row.bytes, held: res.held === true, at: now() });
      } else {
        // some links may be gone already: the file is still there through the others, and nothing was freed
        if (res && Array.isArray(res.deletedPaths)) tl.files = tl.files.filter(f => !res.deletedPaths.includes(f.path));
        tlBackoff.set(row.key, now() + TL_BACKOFF_MS);
        log('[resources] task log not deleted:', row.name, JSON.stringify(res));
      }
    }
    return { ok, failed: rows.length - ok };
  }
  async function tlRead() {
    const [files, registry] = await Promise.all([taskLogs.scan(), taskLogs.registry()]);
    return { files, registry };
  }
  // On the slow cadence, driven by FRESH samples only: the folders and the registry are read once; the file is JUDGED on the second
  // fresh sample after that read, so the process list it is held against was taken wholly after the registry (a session that
  // started between the two reads is in it: Dexter #2). A re-sent old sample, a stale or expired one, or Stop's re-read never gets here.
  function tlTick() {
    if (!taskLogs) return;
    tlSeq++;
    if (tlPending) {
      if (tl.busy) return;
      if (tlSeq >= tlPending.afterSeq + 2 && tlListed) tlJudge();
      else if (now() - tlPending.at > 4 * TL_EVERY_MS) tlPending = null;     // the window was minimised: stale, read again later
      return;
    }
    if (tl.busy || now() - tl.at < TL_EVERY_MS) return;
    tl.busy = true;
    (async () => {
      try {
        const read = await tlRead();
        tlPending = { ...read, afterSeq: tlSeq, at: now() };
      } catch (err) {
        log('[resources] the task-output scan failed:', (err && err.message) || err);
        tl.at = now();
      } finally {
        tl.busy = false;
      }
    })();
  }
  function tlJudge() {
    const read = tlPending;
    tlPending = null;
    tl.busy = true;
    (async () => {
      try {
        tl.files = read.files;
        tl.registry = read.registry;
        tlMarkSeen(tlListed, read);
        tlObserve(taskLogsLib.classify({ files: read.files, registry: read.registry, listedPids: tlListed, seen: tlSeen, now: now() }));
        await tlRemove(tlClassify(tlListed, read).filter(r => r.deletable));
      } catch (err) {
        log('[resources] the task-output delete failed:', (err && err.message) || err);
      } finally {
        tl.busy = false;
        tl.at = now();
      }
    })();
  }

  // The Leftovers section (#74 item 6): found in the same sample the tree came from, so it adds no poller. ANY failure in it
  // (an unreadable ledger, a malformed entry) costs the section only, said in the log: the model, the machine figures and the
  // chip are the panel's job and must go out whatever happens here (PR #132 Miguel I2). The stop does not run here: the caller
  // starts it after the payload is sent.
  function leftoversOf(snap, built) {
    try {
      let entries = [];
      try { entries = ledger(); } catch (err) { log('[resources] could not read the pid ledger:', err && err.message); }
      const procs = snap.sample.procs;
      tlListed = new Map(procs.map(p => [p.pid, p.start]));
      const proven = tree.provenHosts(procs, claims());
      const tabHosts = new Set(tabList().map(t => hostOfPort(proven, t.port)).filter(Number.isInteger));
      const attribution = tree.attribute(procs, {
        hosts: proven.map(h => (tabHosts.has(h.pid) ? { pid: h.pid, owner: ownPid } : { pid: h.pid })),
        installDirs: typeof installDirs === 'function' ? installDirs() : [], ownPids: [ownPid],
      });
      const mem = new Map([...snap.sample.perf].filter(([, v]) => typeof v.ws === 'number').map(([pid, v]) => [pid, v.ws]));
      // This window's tab hosts must never die with a row (a host an earlier window started can sit below a probe root).
      const found = tracker.stamp(leftovers.find({ procs, mem, ledger: entries, attribution, ownPid, protect: [...tabHosts], now: now() }), { advance: snap.adhoc !== true });
      const labels = new Map(built.project.rows.map(r => [`session:${r.hostPid}`, r.label]));
      for (const row of found.mcp.concat(found.shells)) if (row.session) row.session = labels.get(row.session) || row.session.replace('session:', 'session ');
      lastFound = found;
      return { payload: leftovers.present(found, reaper ? reaper.stopped() : [], { now: now(), taskLogs: taskLogs ? tlClassify() : [], deleted: tlShownDeleted() }), found };
    } catch (err) {
      log('[resources] the Leftovers section failed:', (err && err.stack) || err);
      lastFound = null;
      return null;
    }
  }

  function onUpdate(snap) {
    const last = snap.machine && snap.machine.last;
    const machine = last
      ? { cpu: sample.machineCpu(snap.machine.prev, last), mem: sample.machineMemory(last) }
      : null;
    const status = {
      stale: snap.stale === true, expired: snap.expired === true,
      ageMs: typeof snap.lastGoodAt === 'number' ? Math.max(0, now() - snap.lastGoodAt) : null,
    };

    let built = null;
    if (snap.mode === 'full' && snap.sample) {
      const proven = tree.provenHosts(snap.sample.procs, claims());
      const list = tabList().map(t => ({ key: t.key, label: t.label, hostPid: hostOfPort(proven, t.port) }));
      built = model.buildModel({
        sample: snap.sample, prev: snap.prev, cores, tabs: list, hosts: proven,
        installDirs: typeof installDirs === 'function' ? installDirs() : [], ownPid, labelOf,
      });
    }

    if (built && snap.expired !== true) {
      // Only a FRESH sample steps the counters. After a failed sample the sampler re-sends the last good one, and
      // stepping on it would count one real 50% reading three times (Dexter, PR #113 finding 3).
      // Stop's own re-read (`adhoc`) is off the 10 s cadence: shown, but not counted (Dexter, PR #113 N6).
      if (snap.sample !== lastStepped && snap.adhoc !== true) {
        lastStepped = snap.sample;
        const next = new Map();
        const present = new Set();
        for (const row of built.project.rows) {
          present.add(row.key);
          next.set(row.key, warning.step(warnings.get(row.key) || warning.initial(), row.cpu, { threshold: warnAt }));
        }
        // A tab with no row in THIS sample (its host could not be proven for one read) is neither over nor under: it
        // keeps its count. Only a tab that is gone from the strip loses it (finding 8).
        for (const t of tabList()) {
          if (!present.has(t.key) && warnings.has(t.key)) next.set(t.key, warnings.get(t.key));
        }
        setWarnings(next);
      }
    } else {
      lastStepped = null;
      setWarnings(new Map());
    }

    record(snap, built, machine);
    tlListed = null;     // set again by leftoversOf from THIS sample; an expired or machine-only one deletes nothing
    const left = built && snap.expired !== true ? leftoversOf(snap, built) : null;
    if (!left) lastFound = null;
    lastPayload = { model: built, status, machine, chipOn, leftovers: left ? left.payload : null };
    lastLight = { model: null, status, machine, chipOn };
    // Command lines (which can carry a token in argv) go only to the page that shows the panel (Miguel S5).
    send(withHistory(lastPayload), lastLight);
    // AFTER the send: the panel paints first. The stop waits a macrotask before each kill (host/leftovers.js), and an adhoc sample
    // (Stop's own re-read) never starts it.
    if (left && reaper && snap.adhoc !== true) reaper.run(left.found).catch(err => log('[resources] leftovers reap threw:', err && err.message));
    if (!left) tlListed = null;
    else if (snap.adhoc !== true && snap.stale !== true && snap.expired !== true && snap.sample !== tlLastSample) { tlLastSample = snap.sample; tlTick(); }
  }

  // The Stop on a Leftovers row, or "Stop N" on a group (B). The page names WHICH rows ({ rows: [{ pid, start }] } or { group }); main
  // resolves them against the latest sample's PROVABLE rows (ledger pid + start, launcher gone, not this window's own), so a page
  // can never name a process the app did not itself find provable. The stop re-proves the launcher and the start again, then a
  // fresh sample is taken so the section updates at once.
  const STOP_GROUPS = ['probes', 'shells'];
  async function stopLeftovers(req) {
    const refuse = text => ({ ok: false, text });
    // A big task-output file, by its key: re-scanned now and re-judged by the same rule as the automatic delete, so the page can
    // never name a file the app does not itself hold as abandoned.
    if (req && typeof req === 'object' && typeof req.taskLog === 'string') {
      if (!taskLogs) return refuse('deleting is not available');
      if (tl.busy) return refuse('the task folders are being scanned; try again in a moment');
      tl.busy = true;
      try {
        // The registry first, THEN a process list taken after it: the two are never read in the other order (Dexter #2).
        const read = await tlRead();
        const procs = await sampler.sampleNow();
        if (!Array.isArray(procs) || procs.length === 0) return refuse('the process list could not be read; try again');
        const listed = new Map(procs.map(p => [p.pid, p.start]));
        tlMarkSeen(listed, read);
        tl.files = read.files;
        tl.registry = read.registry;
        const rows = tlClassify(listed, read).filter(r => (r.deletable || r.manualDelete) && r.key === req.taskLog);
        if (rows.length === 0) return refuse('that file is not one this panel can delete');
        const res = await tlRemove(rows);
        return { ok: true, stopped: res.ok, failed: res.failed };
      } catch (err) {
        log('[resources] the task-output delete failed:', (err && err.message) || err);
        return refuse('the task folders could not be read');
      } finally {
        tl.busy = false;
        tl.at = now();
      }
    }
    if (!reaper) return refuse('stopping is not available');
    if (!lastFound) return refuse('there is nothing left over to stop');
    const provable = group => lastFound[group].filter(r => r.provable === true && r.entry);
    let rows;
    if (req && typeof req === 'object' && STOP_GROUPS.includes(req.group)) rows = provable(req.group);
    else if (req && typeof req === 'object' && Array.isArray(req.rows) && req.rows.length > 0 && req.rows.length <= 50) {
      const all = STOP_GROUPS.flatMap(provable);
      rows = req.rows.map(q => all.find(r => q && Number.isInteger(q.pid) && typeof q.start === 'string' && r.pid === q.pid && r.start === q.start));
      if (rows.some(r => !r)) return refuse('that is not a leftover this panel can stop');
    } else return refuse('that is not a leftover this panel can stop');
    if (rows.length === 0) return refuse('there is nothing left over to stop');
    const res = await reaper.stop(rows);
    try { await sampler.sampleNow(); } catch { /* the next sample on the cadence shows it */ }
    const stopped = res.results.filter(r => r.stopped).length;
    return { ok: true, stopped, failed: res.results.length - stopped };
  }

  // A page learns the chip's state from the payload; before the first sample there is none, so a bare one (no model, no
  // machine) carries it.
  function push() {
    const bare = { model: null, status: { stale: false, expired: false, ageMs: null }, machine: null };
    lastPayload = { ...(lastPayload || bare), chipOn };
    lastLight = { ...(lastLight || bare), chipOn };
    send(withHistory(lastPayload), lastLight);
  }

  async function stop(request) {
    return stopper.stop(request, {
      readProcs: () => sampler.sampleNow(),
      hostPids: (procs) => {
        const ports = new Set(tabList().map(t => t.port));
        return tree.provenHosts(procs, claims()).filter(h => ports.has(h.port)).map(h => h.pid);
      },
      kill,
    });
  }

  return {
    // A minimised window samples nothing, so no `onUpdate` would ever clear the counters: do it here, or the count (and a lit
    // chip) would carry across the gap and one reading after it could be "the third" (Dexter, PR #113 N4).
    setMinimised(on) {
      minimised = on === true;
      if (minimised) history.markBreak();
      if (minimised) { lastStepped = null; setWarnings(new Map()); }
      refresh();
    },
    refresh,
    onUpdate,
    /** The page that shows the chip changed (a tab was selected): it gets the last payload again, history included, at once. */
    resend: push,
    chipOn: () => chipOn,
    /** Q2: "Show CPU and memory in the top bar". Only a real boolean counts; saved, then every page is told at once. */
    setChip(on) {
      if (typeof on !== 'boolean') return chipOn;
      chipOn = on;
      try { chipStore.write(on); } catch (err) { log('[resources] could not save the chip setting:', err && err.message); }
      push();
      return chipOn;
    },
    /** Another window (another main process sharing the saved file) changed the setting: follow it, live, like the panels' own toggles. */
    reloadChip() {
      const next = chipStore.read() !== false;
      if (next === chipOn) return chipOn;
      chipOn = next;
      push();
      return chipOn;
    },
    get: (full = true) => (full ? withHistory(lastPayload) : lastLight),
    warnFor(key) {
      const s = warnings.get(key);
      return s && s.on ? { pct: s.pct, level: s.level } : null;
    },
    stop,
    stopLeftovers,
  };
}

/**
 * The probe seam's value (CLAUDE_CUSTOM_RESOURCE_WARN_AT), parsed STRICTLY: one to three digits and between 1 and 99, or
 * undefined (the default 40). `Number()` alone would take '0x1E', ' 4e1 ' and '1.5' (Dexter, PR #113 finding 14).
 */
function parseWarnAt(raw) {
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= 99 ? n : undefined;
}

module.exports = { createResourcesService, parseWarnAt };
