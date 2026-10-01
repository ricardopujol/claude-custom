'use strict';
/**
 * The dock layout (BACKLOG #22, layout pass L1): every side panel is a module
 * placed in one of four zones -- left, right, top, bottom -- each a tabbed
 * group showing one module at a time, or collapsed to its tab rail.
 *
 * Pure. Every rule about where a module is, which one a zone shows and how big
 * a zone may be lives here; app/dock-zones-display.js only draws the result.
 * Every function takes a layout, never changes it, and returns a NORMALIZED
 * one, so nothing downstream ever sees a module twice, a module nowhere, or a
 * zone showing a module it doesn't hold.
 *
 * Read anything stored with suspicion: a layout saved by another branch (or a
 * newer build) can name modules this build doesn't have. The `fog` tab saved
 * that way once blanked the whole sidebar, so unknown ids are dropped and known
 * ones missing everywhere come back in the right zone.
 */

/*
 * WRAPPED IN AN IIFE: the renderer loads this as a plain <script> sharing one
 * global scope (test/renderer-scope.test.js).
 */
(function (root) {

const ZONES = ['left', 'right', 'top', 'bottom'];
const DEFAULT_SIZE = { left: 180, right: 180, top: 160, bottom: 160 };

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isSize = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

function defaultLayout(moduleIds) {
  const ids = [...moduleIds];
  return {
    version: 1,
    zones: { left: [], right: ids, top: [], bottom: [] },
    active: { left: null, right: ids.length ? ids[0] : null, top: null, bottom: null },
    hidden: [],
    size: { ...DEFAULT_SIZE },
    restore: null,
  };
}

function normalizeLayout(raw, moduleIds) {
  if (!isObject(raw)) return defaultLayout(moduleIds);
  const known = new Set(moduleIds);
  const placed = new Set();
  // Each known id once, in the first place that lists it.
  const claim = (list) => (Array.isArray(list) ? list : []).filter((id) => {
    if (typeof id !== 'string' || !known.has(id) || placed.has(id)) return false;
    placed.add(id);
    return true;
  });

  const rawZones = isObject(raw.zones) ? raw.zones : {};
  const zones = {};
  for (const z of ZONES) zones[z] = claim(rawZones[z]);
  const hidden = claim(raw.hidden);
  for (const id of moduleIds) if (!placed.has(id)) { zones.right.push(id); placed.add(id); }

  const rawActive = isObject(raw.active) ? raw.active : {};
  const active = {};
  for (const z of ZONES) {
    const want = rawActive[z];
    if (!zones[z].length) active[z] = null;
    else if (want === null) active[z] = null;                      // collapsed on purpose
    else active[z] = zones[z].includes(want) ? want : zones[z][0];
  }

  const rawSize = isObject(raw.size) ? raw.size : {};
  const size = {};
  for (const z of ZONES) size[z] = isSize(rawSize[z]) ? Math.round(rawSize[z]) : DEFAULT_SIZE[z];

  let restore = null;
  if (isObject(raw.restore)) {
    restore = {};
    for (const z of ZONES) {
      const v = raw.restore[z];
      restore[z] = typeof v === 'string' && known.has(v) ? v : null;
    }
  }

  return { version: 1, zones, active, hidden, size, restore };
}

const API = { ZONES, DEFAULT_SIZE, defaultLayout, normalizeLayout };

// One namespace on the page (`window.dockLayout`), not ten loose globals.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockLayout = API;

})(typeof window !== 'undefined' ? window : globalThis);
