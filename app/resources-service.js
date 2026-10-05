'use strict';
/**
 * What main does with the resource sampler (BACKLOG #63, documentation/DESIGN_RESOURCE_PANEL.md): which of this
 * window's pages want the panel, the payload every page gets, the per-tab warning counters, and Stop. Everything
 * it touches (the sampler, the tab list, the identity files, the IPC send, the kill) is handed in, so the whole
 * of it is tested without Electron; app/main.js only builds those and registers the IPC.
 *
 * WHO WANTS WHAT (the design's polling rule). The full sample, the process tree, runs only while the SELECTED
 * tab's page says its Resources panel is showing: a page for another tab is hidden, and nobody is looking. The
 * machine-only sample feeds the top bar's chip, and stops only when the window is minimised.
 *
 * THE WARNING needs the process tree, so it only exists while the panel is showing. When the full sample stops
 * (the panel is hidden, or three samples in a row failed) the counters are cleared and the strip told, rather than
 * leaving a chip with an old percentage on it: a number nobody can measure any more is not a warning.
 */

const sample = require('../host/resource-sample');
const model = require('../host/resource-model');
const tree = require('../host/resource-tree');
const warning = require('../host/resource-warning');
const stopper = require('../host/resource-stop');

const basename = (p) => {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
};

function createResourcesService({
  sampler, tabs, claims, installDirs, ownPid, cores, labelOf = basename, send, isSelectedView, kill,
  refreshStrip = () => {}, now = Date.now, log = () => {},
  // The warning's CPU threshold, 40 by default. A verification seam (CLAUDE_CUSTOM_RESOURCE_WARN_AT in app/main.js), so a
  // probe on a busy machine can show the chip without pinning 40% of it; nothing in the UI sets it.
  warnAt = warning.THRESHOLD,
}) {
  const shown = new Map();     // webContents id -> its page says the panel is showing
  let minimised = false;
  let warnings = new Map();    // tab key -> host/resource-warning.js state
  let lastPayload = null;
  let lastSignature = '';

  const panelWanted = () => [...shown].some(([id, v]) => v === true && isSelectedView(id));
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
      const next = new Map();
      for (const row of built.project.rows) {
        next.set(row.key, warning.step(warnings.get(row.key) || warning.initial(), row.cpu, { threshold: warnAt }));
      }
      setWarnings(next);
    } else {
      setWarnings(new Map());
    }

    lastPayload = { model: built, status, machine };
    send(lastPayload);
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
    setShown(id, on) { shown.set(id, on === true); refresh(); },
    forget(id) { shown.delete(id); refresh(); },
    setMinimised(on) { minimised = on === true; refresh(); },
    refresh,
    onUpdate,
    get: () => lastPayload,
    warnFor(key) {
      const s = warnings.get(key);
      return s && s.on ? { pct: s.pct, level: s.level } : null;
    },
    stop,
  };
}

module.exports = { createResourcesService };
