'use strict';
/**
 * The process-level decisions of the app lock, the crash-restore record and the quit (single-instance PR 3; out of app/main.js for PR #258
 * Miguel I4, so each path is behaviour under plain node and not a regex over main.js; app/project-lifecycle.js is the model). No Electron:
 * main hands in every effect.
 *
 *   ownsAppLock()          app.json names this process (pid AND start)
 *   quitIfEmpty()          no window and nothing opening: the app claim stops FIRST (a launch held on it hears no), then the quit
 *   onWindowAllClosed()    the last BrowserWindow closed: with an open in flight (a launch already told ok), wait for the queue to go idle
 *                          and quit only if no window came up (PR #258 Dexter 7 / Miguel I2); else quit at once, as before
 *   decideRestore(root)    after the lock: which windows come back. WRITES NOTHING (PR #258 Dexter 8 / Miguel I1): a launch that ends
 *                          before it settles (elsewhere, a refused port, attach-only) must leave the crash list for the next one
 *   beginRecord()          once this process stays (after quitIfEmpty said no): the record's first write, `restoring` as decided
 *   runRestores(list)      the restores through openProject (hidden ones hidden), then endRestore with the windows open now
 *   markRecordClean()      a quit (before-quit, before the claims stop) or a session end: the record clean, final until reopened
 *   syncRecord()           a window change: the record follows
 *   quitCancelled()        a quit cancelled after before-quit: quitting back, the gate reset, every claim resumed, and the record
 *                          REOPENED (not clean) once the app claim is back (PR #258 Dexter 9 / Miguel S5)
 *   gateWindows()          what the one quit question asks about: windows whose window is still there (PR #258 Dexter 6: the last window,
 *                          closed with its own Discard, stays registered with stale text; it is never asked about again)
 *   dirtyParent()          the window the question sits on: the dirty one used last, else the first dirty one; only a live window
 *   reclaimTick()          while running and not owning app.json (passed by, then left by the displacer): claim again, and write the
 *                          record once it is ours (PR #258 Dexter 2)
 *   refuseLaunches()       while the quit question is up, launches are refused, so none is quit with this process (PR #258 Dexter 13)
 *   currentWindows()       [{ root, cwd, hidden }] of the registered windows
 *
 * deps: registry, openQueue { busy(), onIdle(fn) }, appClaim { stop, resume, reclaim }, lockOn, pid, ownStart(), readLockOwner(),
 *       readRecord(), proveOwner(owner), decide(record, proof, launchRoot) -> restoreDecision's answer, makeWriter({ owner, owns }),
 *       openProject(o), quit(), getLaunchWindow(), quitGate { reset(), asking() }, setQuitting(v), isQuitting(), log;
 *       optional (Jiandu Home): homeOpen() (an open Home keeps the process: quitIfEmpty and the wait for an open in flight say no),
 *       showHome({ hidden }) (a restore whose record had Home open shows it first, H9, hidden when it was hidden; never when this launch
 *       already made one; the launch window still ends in front).
 */

const { cleanWindows } = require('../host/open-windows');

function createAppLifecycle(deps) {
  const { registry, openQueue, appClaim, lockOn, pid, ownStart, readLockOwner, readRecord, proveOwner, decide, makeWriter, openProject, quit,
    getLaunchWindow, quitGate, setQuitting, isQuitting } = deps;
  const log = deps.log || (() => {});
  // Jiandu Home: an open Home is a window that keeps the process (H5), and a restore brings it back when the crashed run had it (H9)
  const homeOpen = () => { try { return typeof deps.homeOpen === 'function' && deps.homeOpen() === true; } catch { return false; } };
  const state = { start: null, writer: null, plan: { restore: [], keep: [], home: false } };

  const live = (p) => !!p.win && !p.win.isDestroyed();

  function ownsAppLock() {
    if (!lockOn || typeof state.start !== 'string') return false;
    const o = readLockOwner();
    return !!o && o.pid === pid && o.start === state.start;
  }

  const currentWindows = () => registry.list().map((p) => ({ root: p.root, cwd: p.launchCwd, hidden: live(p) && !p.win.isVisible() }));

  function quitIfEmpty() {
    if (registry.size() > 0 || openQueue.busy() || homeOpen()) return false;
    appClaim.stop();
    quit();
    return true;
  }

  function onWindowAllClosed() {
    if (!openQueue.busy()) { quit(); return; }
    log('[main] the last window closed while a project was opening: waiting for it before quitting');
    // the same rule as quitIfEmpty (PR #263 Dexter 3): a Home opened again while the open ran keeps the process
    openQueue.onIdle(() => { if (!registry.list().some(live) && !homeOpen()) quit(); });
  }

  async function decideRestore(launchRoot) {
    if (!lockOn) return [];
    let start = null;
    try { start = await ownStart(); } catch { start = null; }
    if (typeof start !== 'string') return [];
    state.start = start;
    if (!ownsAppLock()) return [];
    const record = readRecord();
    const owner = record && typeof record === 'object' ? record.owner : null;
    const proof = owner && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.start === 'string'
      ? await proveOwner({ pid: owner.pid, start: owner.start }) : null;
    const d = decide(record, proof, launchRoot);
    log(`[main] restore       : ${d.reason}${d.restore.length ? ` (${d.restore.length} window${d.restore.length === 1 ? '' : 's'})` : ''}`);
    for (const s of d.skipped || []) log(`[main] restore skipped ${JSON.stringify(s.root)}: ${s.reason}`);
    state.plan = { restore: d.restore, keep: d.restore.length && record ? cleanWindows(record.windows) : [], home: d.home === true,
      homeHidden: d.homeHidden === true };
    return d.restore;
  }

  function beginRecord() {
    if (!lockOn || typeof state.start !== 'string' || state.writer) return;
    state.writer = makeWriter({ owner: { pid, start: state.start }, owns: ownsAppLock });
    // `restoring: true` is written BEFORE the first restored window: a restore that crashes is not run again (plan risk 7)
    state.writer.begin({ restoring: state.plan.restore.length > 0, keep: state.plan.keep });
  }

  async function runRestores(list) {
    // Home comes back as it was (hidden to the tray, or shown: Miguel G1), and a Home this launch already made (a --home launch, maybe
    // under Start minimised) is left as the launch made it
    let homeShown = false;
    if (state.plan.home && typeof deps.showHome === 'function' && !homeOpen()) {
      try { deps.showHome({ hidden: state.plan.homeHidden === true }); homeShown = state.plan.homeHidden !== true; }
      catch (err) { log(`[main] restore: Home did not show: ${err && err.message}`); }
    }
    try { await Promise.all(list.map((w) => openProject({ cwd: w.cwd, show: w.hidden ? 'hidden' : 'shown' }))); } catch { /* each open logs its own */ }
    if (state.writer) state.writer.endRestore(currentWindows());
    // the launch window ends in front, a shown Home included (PR #263 Dexter 4)
    const lw = getLaunchWindow();
    if ((list.length || homeShown) && lw && lw.win && !lw.win.isDestroyed() && lw.win.isVisible()) lw.focusWindow();
  }

  const markRecordClean = () => { if (state.writer) state.writer.markClean(); };
  const syncRecord = () => { if (state.writer) state.writer.sync(currentWindows()); };

  function quitCancelled() {
    setQuitting(false);
    quitGate.reset();
    Promise.resolve().then(() => appClaim.resume()).catch(() => {}).then(() => { if (state.writer) state.writer.reopen(currentWindows()); });
    registry.forEach((p) => { p.allowClose(false); if (live(p)) p.claim.resume().catch(() => {}); });
  }

  function gateWindows() {
    return registry.list().filter(live).map((p) => ({
      label: p.label,
      unsaved: () => p.readerUnsaved.all().map((u) => u.path),
      saveAll: () => p.saveReaders(),
      allowClose: () => p.allowClose(true),
      pw: p,
    }));
  }

  function dirtyParent() {
    const dirty = registry.list().filter((p) => live(p) && p.readerUnsaved.all().length > 0);
    const last = registry.lastUsed();
    return dirty.includes(last) ? last : (dirty[0] || null);
  }

  async function reclaimTick() {
    if (!lockOn || isQuitting() || typeof state.start !== 'string' || ownsAppLock()) return false;
    let ok = false;
    try { ok = (await appClaim.reclaim()) === true; } catch { ok = false; }
    if (ok && state.writer) state.writer.reopen(currentWindows());
    return ok;
  }

  const refuseLaunches = () => quitGate.asking() === true;

  return { ownsAppLock, quitIfEmpty, onWindowAllClosed, decideRestore, beginRecord, runRestores, markRecordClean, syncRecord, quitCancelled,
    gateWindows, dirtyParent, reclaimTick, refuseLaunches, currentWindows };
}

module.exports = { createAppLifecycle };
