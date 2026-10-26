'use strict';
/**
 * Reading what L1 saved (BACKLOG #22 layout pass L1 -> #53 dockable panels D4). L1's four fixed zones
 * (app/dock-layout.js, removed in D4) stored `{ version: 1, zones, active, hidden, size, restore }`; the tree
 * (app/dock-tree.js) is the only reader of that shape now, through `fromV1`. This keeps exactly what the tree
 * takes from it -- which zone holds which modules, what is hidden, how big each zone was -- under the rules L1's
 * own normalizer applied (test/dock-migrate.test.js pins them, and the saved files they have to open).
 *
 * `active` (what each zone showed) and `restore` (Ctrl+B's memory) are a window's SELECTION, not placement; the
 * tree keeps those in localStorage and seeds them from L1's own key (`selectionFromV1`), so they are not read here.
 *
 * Read anything stored with suspicion: a layout saved by another branch (or a newer build) can name modules this
 * build doesn't have, and a damaged file can hold any value where a size should be (`Number(null)` is 0, a
 * confident wrong size).
 */

/*
 * WRAPPED IN AN IIFE: the renderer loads this as a plain <script> sharing one
 * global scope (test/renderer-scope.test.js). The page sees one name, `dockMigrate`.
 */
(function (root) {

const ZONES = ['left', 'right', 'top', 'bottom'];
const DEFAULT_SIZE = { left: 180, right: 180, top: 160, bottom: 160 };
const MIN = { side: 120, wide: 80 };
// No screen is wider than this; a bigger stored size (1e306 from a damaged file) overflowed the fitting arithmetic into NaN.
const MAX_SIZE = 10000;

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isSize = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const minFor = z => (z === 'left' || z === 'right' ? MIN.side : MIN.wide);
// Held to the minimum: a stored 5e-324 is "positive" but rounds to 0, and a second read would swap it for the default.
const clampSize = (z, px) => Math.min(MAX_SIZE, Math.max(minFor(z), Math.round(px)));

/** L1's first layout: everything on the right, its default sizes. */
function defaultV1(moduleIds) {
  return {
    version: 1,
    zones: { left: [], right: [...moduleIds], top: [], bottom: [] },
    hidden: [],
    size: { ...DEFAULT_SIZE },
  };
}

/** Anything stored by L1 as a whole layout of exactly these modules: each once, unknown ids dropped, missing ones on the right. */
function normalizeV1(raw, moduleIds) {
  if (!isObject(raw)) return defaultV1(moduleIds);
  const known = new Set(moduleIds);
  const placed = new Set();
  // Each known id once, in the first place that lists it.
  const claim = list => (Array.isArray(list) ? list : []).filter((id) => {
    if (typeof id !== 'string' || !known.has(id) || placed.has(id)) return false;
    placed.add(id);
    return true;
  });

  const rawZones = isObject(raw.zones) ? raw.zones : {};
  const zones = {};
  for (const z of ZONES) zones[z] = claim(rawZones[z]);
  const hiddenIds = claim(raw.hidden);
  for (const id of moduleIds) if (!placed.has(id)) { zones.right.push(id); placed.add(id); }

  const rawSize = isObject(raw.size) ? raw.size : {};
  const size = {};
  for (const z of ZONES) size[z] = isSize(rawSize[z]) ? clampSize(z, rawSize[z]) : DEFAULT_SIZE[z];
  return { version: 1, zones, hidden: hiddenIds, size };
}

/**
 * The first launch after L1 (S2): today's window kept its tab and its width in per-window localStorage
 * (`sideTab`, `rosterWidth`); the first global layout starts from the width, so nobody's window changes under them.
 */
function fromLegacy(legacy, moduleIds) {
  const l = defaultV1(moduleIds);
  const rec = isObject(legacy) ? legacy : {};
  // Strict: `Number('')` and `Number(null)` are 0, a confident wrong width.
  const w = typeof rec.rosterWidth === 'string' && rec.rosterWidth.trim() !== '' ? Number(rec.rosterWidth) : NaN;
  if (isSize(w)) l.size.right = Math.round(w);
  return normalizeV1(l, moduleIds);
}

const API = { defaultV1, normalizeV1, fromLegacy };

// One namespace on the page (`window.dockMigrate`).
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockMigrate = API;

})(typeof window !== 'undefined' ? window : globalThis);
