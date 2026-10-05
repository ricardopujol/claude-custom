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
    lastPayload = { model: built, status, machine, chipOn };
    lastLight = { model: null, status, machine, chipOn };
    // Command lines (which can carry a token in argv) go only to the page that shows the panel (Miguel S5).
    send(withHistory(lastPayload), lastLight);
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
