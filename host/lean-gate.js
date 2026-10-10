'use strict';
/**
 * Which viewers of this host are in lean mode (BACKLOG #62, PR #140 Dexter F5, the hub's call: while lean, STOP the host's local-model
 * summary job; its only reader, the terminal bar's where-are-we panel, is hidden).
 *
 *   createLeanGate() -> { set(ws, on), drop(ws), paused(attached) }
 *
 * The page tells the host `{ type: 'lean', on }`. The gate is `paused` only when EVERY attached viewer is lean (and there is at least
 * one): a second window that is not lean still wants its summary. A viewer that detaches is dropped, so a closed window cannot keep the
 * summary job off. Nothing else is stopped here: main's process-tree sampler KEEPS running while lean on purpose, because it drives
 * Leftovers' 15-minute auto-reap, which matters most overnight (app/resources-service.js).
 */
function createLeanGate() {
  const lean = new Set();
  return {
    set(ws, on) { if (on === true) lean.add(ws); else lean.delete(ws); },
    drop(ws) { lean.delete(ws); },
    paused(attached) { return lean.size > 0 && Number.isInteger(attached) && lean.size >= attached; },
  };
}

module.exports = { createLeanGate };
