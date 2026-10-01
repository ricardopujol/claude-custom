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

const MIN = { side: 120, wide: 80 };
const isSide = z => z === 'left' || z === 'right';
const minFor = z => (isSide(z) ? MIN.side : MIN.wide);
const zoneOf = (layout, id) => ZONES.find(z => layout.zones[z].includes(id)) || null;

// A working copy deep enough that the edits below never reach the caller's layout.
function copy(layout) {
  const zones = {};
  for (const z of ZONES) zones[z] = [...layout.zones[z]];
  return { ...layout, zones, active: { ...layout.active }, hidden: [...layout.hidden], size: { ...layout.size } };
}

/**
 * S2: the first launch after the upgrade. Today's window kept its tab and its
 * width in per-window localStorage (`sideTab`, `rosterWidth`); the first global
 * layout starts from them, so nobody's window changes under them.
 */
function fromLegacy(legacy, moduleIds) {
  const l = defaultLayout(moduleIds);
  const rec = isObject(legacy) ? legacy : {};
  if (rec.sideTab === '') l.active.right = null;
  else if (typeof rec.sideTab === 'string' && moduleIds.includes(rec.sideTab)) l.active.right = rec.sideTab;
  // Strict: `Number('')` and `Number(null)` are 0, a confident wrong width.
  const w = typeof rec.rosterWidth === 'string' && rec.rosterWidth.trim() !== '' ? Number(rec.rosterWidth) : NaN;
  if (isSize(w)) l.size.right = Math.round(w);
  return normalizeLayout(l, moduleIds);
}

/** A tab click: show that module in its zone, or collapse the zone if it is already showing. */
function selectModule(layout, id) {
  const z = zoneOf(layout, id);
  if (!z) return layout;
  const l = copy(layout);
  l.active[z] = l.active[z] === id ? null : id;
  l.restore = null;
  return l;
}

/** Move a module to a zone (it becomes that zone's showing module) or to 'hide'. */
function moveModule(layout, id, target) {
  if (target !== 'hide' && !ZONES.includes(target)) return layout;
  const from = zoneOf(layout, id);
  const wasHidden = layout.hidden.includes(id);
  if (!from && !wasHidden) return layout;                     // unknown module
  if (from === target || (wasHidden && target === 'hide')) return layout;

  const l = copy(layout);
  if (from) {
    l.zones[from] = l.zones[from].filter(m => m !== id);
    if (l.active[from] === id) l.active[from] = l.zones[from].length ? l.zones[from][0] : null;
  } else {
    l.hidden = l.hidden.filter(m => m !== id);
  }
  if (target === 'hide') {
    l.hidden.push(id);
  } else {
    l.zones[target].push(id);
    l.active[target] = id;
    l.restore = null;                                         // a zone was opened by hand
  }
  return l;
}

/** The size the user dragged a zone to (stored, not fitted: see fitSizes). */
function setSize(layout, zone, px) {
  if (!ZONES.includes(zone) || typeof px !== 'number' || !Number.isFinite(px)) return layout;
  const l = copy(layout);
  l.size[zone] = Math.max(minFor(zone), Math.round(px));
  return l;
}

/**
 * Ctrl+B / the header hint. Any zone open: collapse them all, remembering what
 * each showed. None open: bring them back as remembered. A remembered module
 * that has since left its zone falls back to that zone's first module, and the
 * result is never "everything still collapsed" -- that would be a key that does
 * nothing, which reads as broken.
 */
function toggleAll(layout) {
  const l = copy(layout);
  if (ZONES.some(z => l.active[z] !== null)) {
    l.restore = { ...l.active };
    for (const z of ZONES) l.active[z] = null;
    return l;
  }
  const memory = layout.restore;
  for (const z of ZONES) {
    if (!l.zones[z].length) continue;
    if (!memory) { l.active[z] = l.zones[z][0]; continue; }
    const want = memory[z];
    if (want === null) continue;                              // it was collapsed
    l.active[z] = l.zones[z].includes(want) ? want : l.zones[z][0];
  }
  if (!ZONES.some(z => l.active[z] !== null)) {
    for (const z of ZONES) if (l.zones[z].length) l.active[z] = l.zones[z][0];
  }
  l.restore = null;
  return l;
}

const API = {
  ZONES, MIN, DEFAULT_SIZE, defaultLayout, normalizeLayout, fromLegacy, selectModule, moveModule, setSize, toggleAll,
};

// One namespace on the page (`window.dockLayout`), not ten loose globals.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockLayout = API;

})(typeof window !== 'undefined' ? window : globalThis);
