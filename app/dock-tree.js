'use strict';
/**
 * The dock tree (BACKLOG #53, dockable panels D1): every side panel is a module
 * in a tabbed group, and the groups, the terminal and the splits between them
 * form one tree. The terminal is a fixed cell of that tree: it can be split
 * around but never moved, hidden, joined or floated over by the layout itself.
 *
 * Pure. Every rule about where a module is, how a drop splits a cell, what a
 * cell's minimum is and how a layout fits a window lives here;
 * app/dock-tree-display.js only draws the result. Every function takes a
 * layout, never changes it, and returns a NORMALIZED one, so nothing downstream
 * ever sees a module twice, a module nowhere, two terminals, an empty group or
 * a split with one child.
 *
 * Read anything stored with suspicion: a layout saved by another branch (or a
 * newer build) can name modules this build doesn't have, and a damaged file can
 * hold any value where a size should be (`Number(null)` is 0, a confident wrong
 * size), so every stored size goes through a strict typeof check.
 */

/*
 * WRAPPED IN AN IIFE: the renderer loads this as a plain <script> sharing one
 * global scope (test/renderer-scope.test.js). The page sees one name, `dockTree`.
 */
(function (root) {

// Loaded the way app/dock-zones-display.js loads it: required under Node, a page global in the window.
const layoutApi = typeof module !== 'undefined' && module.exports
  ? require('./dock-layout')
  : root.dockLayout;

const VERSION = 2;
const MIN = { width: 120, height: 80 };               // a panel
const TERM_MIN = { width: 320, height: 160 };         // the terminal wins
const RAIL = { side: 28, wide: 30 };
const GUTTER = 5;
const DEFAULT_SIZE = { row: 180, col: 160 };          // a new cell beside / under the terminal
// No screen is wider than this; a bigger stored size (1e306 from a damaged file)
// overflowed L1's fitting arithmetic into NaN.
const MAX_SIZE = 10000;
const MAX_DEPTH = 12;                                 // junk input must not recurse without end
const SIDES = ['left', 'right', 'top', 'bottom', 'center'];

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isSize = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const TERM = () => ({ type: 'term' });

function defaultLayout(ids) {
  const tabs = [...ids];
  const rootNode = tabs.length
    ? { type: 'split', dir: 'row', kids: [TERM(), { type: 'group', id: 'right', tabs }], sizes: [0, DEFAULT_SIZE.row] }
    : TERM();
  return { version: VERSION, root: rootNode, floats: [], hidden: [], seat: {} };
}

const hasTerm = n => n.type === 'term' || (n.type === 'split' && n.kids.some(hasTerm));
function walk(n, fn) { fn(n); if (n.type === 'split') n.kids.forEach(k => walk(k, fn)); }
function groups(layout) { const out = []; walk(layout.root, (n) => { if (n.type === 'group') out.push(n); }); return out; }
function count(layout, type) { let c = 0; walk(layout.root, (n) => { if (n.type === type) c += 1; }); return c; }
function freshId(used) { let i = 1; while (used.has('g' + i)) i += 1; used.add('g' + i); return 'g' + i; }

// One pass that enforces I1-I4 on a subtree. `st` carries what has been seen.
function clean(n, st, depth) {
  if (!isObject(n) || depth > MAX_DEPTH) return null;
  if (n.type === 'term') { if (st.term) return null; st.term = true; return TERM(); }
  if (n.type === 'group') {
    const tabs = (Array.isArray(n.tabs) ? n.tabs : []).filter(id => st.claim(id));
    if (!tabs.length) return null;
    const id = typeof n.id === 'string' && n.id && !st.ids.has(n.id) ? n.id : null;
    if (id) st.ids.add(id);                         // an unnamed group is named after the pass, when every kept id is known
    return { type: 'group', id, tabs };
  }
  if (n.type !== 'split' || (n.dir !== 'row' && n.dir !== 'col') || !Array.isArray(n.kids)) return null;
  const rawSizes = Array.isArray(n.sizes) ? n.sizes : [];
  const kids = [];
  const sizes = [];
  n.kids.forEach((k, i) => {
    const c = clean(k, st, depth + 1);
    if (!c) return;
    const asked = isSize(rawSizes[i]) ? Math.min(MAX_SIZE, rawSizes[i]) : DEFAULT_SIZE[n.dir];
    if (c.type === 'split' && c.dir === n.dir) {
      // Flatten. A nested spine keeps its own pixel sizes; anything else shares this slot in proportion.
      const spine = hasTerm(c);
      const tot = c.sizes.reduce((a, b) => a + b, 0) || 1;
      c.kids.forEach((kk, j) => { kids.push(kk); sizes.push(spine ? c.sizes[j] : asked * c.sizes[j] / tot); });
    } else {
      kids.push(c);
      sizes.push(hasTerm(c) ? 0 : asked);           // the spine flexes: the kid holding the terminal takes what is left
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  return { type: 'split', dir: n.dir, kids, sizes };
}

const SEAT_SIDES = new Set(SIDES);
function cleanSeat(raw, hidden) {
  const seat = {};
  if (!isObject(raw)) return seat;
  for (const id of hidden) {
    const s = raw[id];
    const nameOrNull = v => v === null || typeof v === 'string';
    if (isObject(s) && nameOrNull(s.group) && nameOrNull(s.beside) && SEAT_SIDES.has(s.side)) {
      seat[id] = { group: s.group, beside: s.beside, side: s.side };
    }
  }
  return seat;
}

/** Anything stored becomes a valid layout of exactly these modules (I1-I5). */
function normalize(raw, ids) {
  if (!isObject(raw) || raw.version !== VERSION) return defaultLayout(ids);
  const known = new Set(ids);
  const placed = new Set();
  const st = {
    known, ids: new Set(), term: false,
    // Each known id once, in the first place that lists it.
    claim(id) {
      if (typeof id !== 'string' || !known.has(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    },
  };
  let r = clean(raw.root, st, 0);
  if (r) walk(r, (n) => { if (n.type === 'group' && n.id === null) n.id = freshId(st.ids); });

  if (!st.term) {
    if (!r) r = TERM();
    else if (r.dir === 'row') r = { type: 'split', dir: 'row', kids: [TERM(), ...r.kids], sizes: [0, ...r.sizes] };
    else r = { type: 'split', dir: 'row', kids: [TERM(), r], sizes: [0, DEFAULT_SIZE.row] };
  }

  const hidden = (Array.isArray(raw.hidden) ? raw.hidden : []).filter(id => st.claim(id));
  const missing = [...known].filter(id => !placed.has(id));
  if (missing.length) {
    let first = null;
    walk(r, (n) => { if (!first && n.type === 'group') first = n; });
    if (first) first.tabs.push(...missing);
    else r = { type: 'split', dir: 'row', kids: [r, { type: 'group', id: freshId(st.ids), tabs: missing }], sizes: [0, DEFAULT_SIZE.row] };
  }

  return { version: VERSION, root: r, floats: [], hidden, seat: cleanSeat(raw.seat, hidden) };
}

// Only a plain object of string -> string survives; nothing else a window stored is trusted.
function stringMap(o) {
  const out = {};
  if (!isObject(o)) return out;
  for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * L1's four zones as a tree: col[top, row[left, term, right], bottom], each
 * non-empty zone one group named after its zone, sizes carried, hidden carried.
 * L1's own normalizer reads the input first, so its rules (unknown modules
 * dropped, missing ones back on the right) clean it before it becomes a tree.
 */
function fromV1(raw, ids) {
  const l = layoutApi.normalizeLayout(raw, ids);
  const zone = z => (l.zones[z].length ? { type: 'group', id: z, tabs: l.zones[z] } : null);
  const strip = (kids, sizes, dir) => ({
    type: 'split', dir, kids: kids.filter(Boolean), sizes: sizes.filter((_, i) => kids[i]),
  });
  const middle = strip([zone('left'), TERM(), zone('right')], [l.size.left, 0, l.size.right], 'row');
  const tree = strip([zone('top'), middle, zone('bottom')], [l.size.top, 0, l.size.bottom], 'col');
  return normalize({ version: VERSION, root: tree, hidden: l.hidden, seat: {} }, ids);
}

/** A stored layout of either generation: version 2 as is, an L1 shape migrated, else the default. */
function readAny(raw, ids) {
  if (isObject(raw) && raw.version === VERSION) return normalize(raw, ids);
  if (isObject(raw) && isObject(raw.zones)) return fromV1(raw, ids);
  return defaultLayout(ids);
}

/** A window's L1 selection as a tree selection: group ids are the zone names, so it maps straight across. */
function selectionFromV1(raw) {
  return { active: stringMap(isObject(raw) ? raw.active : null), foldAll: false };
}

const API = {
  VERSION, MIN, TERM_MIN, RAIL, GUTTER, DEFAULT_SIZE, defaultLayout, normalize, groups, count, hasTerm,
  fromV1, readAny, selectionFromV1,
};

// One namespace on the page (`window.dockTree`), not a dozen loose globals.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockTree = API;

})(typeof window !== 'undefined' ? window : globalThis);
