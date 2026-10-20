'use strict';
/**
 * What main does with the listener table (BACKLOG #119 A4): when to ask for it, and what each tab's page is told. Every effect is
 * handed in (the PowerShell call, the tab list, the block lookup, the IPC send, the clock), so the whole of it is tested without
 * Electron; app/main.js builds those.
 *
 * ONE CALL FOR EVERY TAB. The table is machine-wide, so a window asks once per sample and answers each tab from it
 * (host/dev-servers.js buildState). The call is made every 10 s while a window is in view, as the Resources panel's is; the gap
 * starts when a sample ENDS, so a slow one is never piled on. A minimised window stops the clock. A sample that fails keeps the last good
 * answer and marks it stale; three in a row make the answer UNKNOWN (no list at all), because a list that is empty reads as
 * "nothing is running".
 *
 * Only a change is sent: the page is told when the set of ports (or their owners) differs from what it was last told.
 */

const ds = require('../host/dev-servers');

const EXPIRE_AFTER = 3;

function createDevServersService({
  exec, tabs, portBaseOf, hostPidOf = () => null, send, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, log = () => {},
} = {}) {
  let running = false;
  let minimised = true;
  let inflight = false;
  let timer = null;
  let failures = 0;
  let table = null;                    // { listeners, procs, at } of the last good sample
  const last = new Map();              // tab key -> { sig, state }

  const tabList = () => { try { const t = tabs(); return Array.isArray(t) ? t : []; } catch { return []; } };
  const wantedNow = () => running && ds.wanted({ minimised, tabs: tabList().length });

  function clearClock() { if (timer) { clearTimer(timer); timer = null; } }

  function publish(stale, unknown) {
    const list = tabList();
    const keys = new Set(list.map(t => t.key));
    for (const k of [...last.keys()]) if (!keys.has(k)) last.delete(k);
    for (const t of list) {
      let state;
      if (unknown || !table) state = { ok: false };
      else {
        let base = null;
        try { base = portBaseOf(t.cwd); } catch { /* no block known */ }
        let hostPid = null;
        try { hostPid = hostPidOf(t.key); } catch { /* unknown */ }
        const built = ds.buildState({ listeners: table.listeners, procs: table.procs, base, hostPid });
        state = { ok: true, stale: stale === true, base: built.base, inBlock: built.inBlock, outside: built.outside, at: table.at };
      }
      const { at, ...rest } = state;      // the time of the sample is not a change
      const sig = JSON.stringify(rest);
      const prev = last.get(t.key);
      if (prev && prev.sig === sig) { prev.state = state; continue; }
      last.set(t.key, { sig, state });
      try { send(t.key, state); } catch (err) { log('[dev-servers] send threw:', err && err.message); }
    }
  }

  async function sample() {
    inflight = true;
    try {
      const parsed = ds.parseTable(await exec(ds.SCRIPT));
      if (!parsed.ok) throw new Error('the listener table could not be read');
      table = { listeners: parsed.listeners, procs: parsed.procs, at: now() };
      failures = 0;
      publish(false, false);
    } catch (err) {
      failures++;
      log('[dev-servers] sample failed:', err && err.message);
      if (failures >= EXPIRE_AFTER) publish(false, true);
      else if (table) publish(true, false);
    } finally {
      inflight = false;
      clearClock();
      if (wantedNow()) timer = setTimer(() => { timer = null; evaluate(); }, ds.INTERVAL_MS);
    }
  }

  function evaluate() {
    if (!wantedNow()) { clearClock(); return; }
    if (inflight) return;
    // A tab the page has not been told about yet should not wait out the gap.
    const fresh = tabList().some(t => !last.has(t.key));
    if (timer && !fresh) return;
    clearClock();
    sample();
  }

  return {
    start() { running = true; evaluate(); },
    stop() { running = false; clearClock(); },
    setMinimised(on) { minimised = on === true; evaluate(); },
    refresh() { evaluate(); },
    snapshot(key) { const e = last.get(key); return e ? e.state : null; },
  };
}

module.exports = { createDevServersService, EXPIRE_AFTER };
