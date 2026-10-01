'use strict';
/**
 * A tab's own layout (layout pass L1, S6): set with *Just this tab*, kept by
 * this host in memory only. That is the lifetime the design asks for -- it
 * survives the window closing and reattaching (the host keeps running) and is
 * gone when the session ends (the host exits with its claude).
 *
 * The host doesn't judge the layout's shape: every page runs it through
 * app/dock-layout.js normalizeLayout before drawing it, and a newer build may
 * know modules this host has never heard of. It only refuses what could hurt
 * the host itself -- something that isn't a layout-shaped value at all, or one
 * big enough to bloat every hello and broadcast.
 */

const MAX_OVERRIDE_BYTES = 8192;

function acceptOverride(raw) {
  if (raw === null) return { ok: true, value: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  let json;
  try { json = JSON.stringify(raw); } catch { return { ok: false }; }
  if (Buffer.byteLength(json, 'utf8') > MAX_OVERRIDE_BYTES) return { ok: false };
  return { ok: true, value: raw };
}

module.exports = { acceptOverride, MAX_OVERRIDE_BYTES };
