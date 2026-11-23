'use strict';
/**
 * "One at a time", per owner: the strip's ▾ menu takes ~1-2 s to list the background sessions and must not stack on itself, but a busy
 * menu in one project window must never block another window's (single-instance PR 2). `enter(owner)` is true the first time and false
 * while that owner is still inside; `leave(owner)` frees it. Pure.
 */
function createBusyGate() {
  const busy = new Set();
  return {
    enter(owner) { if (busy.has(owner)) return false; busy.add(owner); return true; },
    leave(owner) { busy.delete(owner); },
    has(owner) { return busy.has(owner); },
  };
}

module.exports = { createBusyGate };
