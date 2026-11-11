'use strict';
/**
 * The per-project half of what main.js owns (single-instance PR 2, step 4): for each project window, its secret service (over its own
 * vault: the Q1 default, "unlocking in A leaves B locked"), its layout store, the two layout syncs, and the stops of the watchers that
 * follow its layout files. Made when a window is, stopped when it is disposed.
 *
 * The IPC handlers stay registered once in main; they reach a window's record through the window (stripOwner / viewOwner):
 *
 *   secretsOf(pw)           that window's secret service, or null
 *   scopeFor(registry, pick)  the `scopeFor(sender)` app/layout-bridge.js takes: { store, sync, send } of the window that owns the
 *                           sender, `pick` naming which sync ('layoutSync' | 'treeSync'), or null for a sender no window owns
 *
 * Pure: every effect (the vault, the stores, the watchers) is a factory handed in, so this loads under plain node.
 */

function createProjectRecords({ makeSecrets, makeLayoutStore, watch, pushToProject, log = () => {} }) {
  for (const [name, fn] of Object.entries({ makeSecrets, makeLayoutStore, watch, pushToProject })) {
    if (typeof fn !== 'function') throw new Error(`createProjectRecords: missing ${name}`);
  }
  const records = new Map();       // window -> record

  function make(pw) {
    if (records.has(pw)) return records.get(pw);
    const secrets = makeSecrets(pw);
    const layoutStore = makeLayoutStore(pw);
    const layoutSync = {};
    const treeSync = {};
    const send = pushToProject(pw);
    const stops = watch({ pw, layoutStore, layoutSync, treeSync, send }) || [];
    const record = { secrets, layoutStore, layoutSync, treeSync, stops };
    records.set(pw, record);
    return record;
  }

  function stop(pw) {
    const record = records.get(pw);
    if (!record) return;
    records.delete(pw);
    for (const stopOne of record.stops) { try { stopOne(); } catch (err) { log(`[main] stopping a layout watcher failed: ${err && err.message}`); } }
  }

  const get = (pw) => (pw ? records.get(pw) || null : null);

  return {
    make, stop, get,
    size: () => records.size,
    secretsOf: (pw) => { const r = get(pw); return r ? r.secrets : null; },
    /** `owner(sender)` is the window of that sender (a registry resolver); the answer is a layout-bridge scope, or null. */
    scopeFor: (owner, pick) => (sender) => {
      const pw = owner(sender);
      const r = get(pw);
      return r ? { store: r.layoutStore, sync: r[pick], send: pushToProject(pw) } : null;
    },
  };
}

module.exports = { createProjectRecords };
