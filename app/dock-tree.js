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

// L1's saved shape is read by app/dock-migrate.js: required under Node, a page global in the window.
const migrateApi = typeof module !== 'undefined' && module.exports
  ? require('./dock-migrate')
  : root.dockMigrate;

const VERSION = 2;
const MIN = { width: 120, height: 80 };               // a panel
const TERM_MIN = { width: 320, height: 160 };         // the terminal wins
const RAIL = { side: 28, wide: 30 };
const GUTTER = 5;
const DEFAULT_SIZE = { row: 180, col: 160 };          // a new cell beside / under the terminal
// A module's OWN width when it gets a cell of its own beside the terminal (Ricardo, 2026-10-06, #71 question 1: Claude's panel docks itself at
// 320, the 180 above is too cramped for its question card). A column default and every other module stay as above.
const OWN_ROW_SIZE = Object.freeze({ canvas: 320 });
// No screen is wider than this; a bigger stored size (1e306 from a damaged file)
// overflowed L1's fitting arithmetic into NaN.
const MAX_SIZE = 10000;
const MAX_DEPTH = 12;                                 // junk input must not recurse without end
const SIDES = ['left', 'right', 'top', 'bottom', 'center'];
// Floating panels (D2): a float is a tab group hung over the dock area, outside the tree.
const FLOAT_MIN = { width: 160, height: 120 };
const FLOAT_DEFAULT = { width: 320, height: 260 };
const CASCADE = 24;                                   // the first float's offset from the corner; each next one adds this

// A size is stored at least 1: 5e-324 is "positive" but half of it is 0, and a stored 0 for a kid that
// doesn't hold the terminal is read as "no size" by the next normalize (found by P2).
const stored = v => Math.min(MAX_SIZE, Math.max(1, v));

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isSize = v => isNum(v) && v > 0;
const TERM = () => ({ type: 'term' });

// Modules that start HIDDEN rather than as a tab in the first group, until something puts them on screen (BACKLOG #71:
// Claude's panel appears when Claude is first asked to build something in it, never on its own). A saved layout that
// predates one gets it hidden too, instead of a new tab in the person's first group. Once it is placed anywhere, it stays
// where the person put it.
const HIDDEN_UNTIL_USED = ['canvas'];

function defaultLayout(ids) {
  const tabs = ids.filter(id => !HIDDEN_UNTIL_USED.includes(id));
  const away = ids.filter(id => HIDDEN_UNTIL_USED.includes(id));
  const rootNode = tabs.length
    ? { type: 'split', dir: 'row', kids: [TERM(), { type: 'group', id: 'right', tabs }], sizes: [0, DEFAULT_SIZE.row] }
    : TERM();
  return { version: VERSION, root: rootNode, floats: [], hidden: away, seat: {} };
}

const hasTerm = n => n.type === 'term' || (n.type === 'split' && n.kids.some(hasTerm));
function walk(n, fn) { fn(n); if (n.type === 'split') n.kids.forEach(k => walk(k, fn)); }
function groups(layout) { const out = []; walk(layout.root, (n) => { if (n.type === 'group') out.push(n); }); return out; }
function count(layout, type) { let c = 0; walk(layout.root, (n) => { if (n.type === type) c += 1; }); return c; }
// `also`: names a hidden module's seat still points at. A destroyed group's name is free to reuse, but a new
// group handed it would capture that seat (show would rejoin an unrelated group).
function freshId(used, also) {
  let i = 1;
  while (used.has('g' + i) || (also && also.has('g' + i))) i += 1;
  used.add('g' + i);
  return 'g' + i;
}
const seatGroups = seat => new Set(Object.values(isObject(seat) ? seat : {}).map(s => (isObject(s) ? s.group : null)).filter(v => typeof v === 'string'));

// A group's or float's stored name, or null. 'term' is the terminal's name in drop targets, so nothing can
// carry it; a name already taken is no name. An unnamed one is named after the pass, when every kept id is known.
function claimName(n, st) {
  const id = typeof n.id === 'string' && n.id && n.id !== 'term' && !st.ids.has(n.id) ? n.id : null;
  if (id) st.ids.add(id);
  return id;
}

// A float's numbers, strictly: `Number(null)` is 0, a confident wrong position. Position is stored as the user
// chose it (a whole number from 0); `fit` keeps it inside whatever window it is drawn in, storage never does.
const floatPos = v => (typeof v === 'number' && !Number.isNaN(v) ? Math.min(MAX_SIZE, Math.max(0, Math.round(v))) : CASCADE);
const floatSize = (v, min, dflt) => (isSize(v) ? Math.min(MAX_SIZE, Math.max(min, Math.round(v))) : dflt);
const floatRect = f => ({
  x: floatPos(f.x), y: floatPos(f.y),
  w: floatSize(f.w, FLOAT_MIN.width, FLOAT_DEFAULT.width), h: floatSize(f.h, FLOAT_MIN.height, FLOAT_DEFAULT.height),
});

function cleanFloat(n, st) {
  if (!isObject(n)) return null;
  const tabs = (Array.isArray(n.tabs) ? n.tabs : []).filter(id => st.claim(id));
  if (!tabs.length) return null;
  return { id: claimName(n, st), tabs, ...floatRect(n) };
}

// One pass that enforces I1-I4 on a subtree. `st` carries what has been seen.
function clean(n, st, depth) {
  if (!isObject(n) || depth > MAX_DEPTH) return null;
  if (n.type === 'term') { if (st.term) return null; st.term = true; return TERM(); }
  if (n.type === 'group') {
    const tabs = (Array.isArray(n.tabs) ? n.tabs : []).filter(id => st.claim(id));
    if (!tabs.length) return null;
    return { type: 'group', id: claimName(n, st), tabs };
  }
  if (n.type !== 'split' || (n.dir !== 'row' && n.dir !== 'col') || !Array.isArray(n.kids)) return null;
  const rawSizes = Array.isArray(n.sizes) ? n.sizes : [];
  const kids = [];
  const sizes = [];
  n.kids.forEach((k, i) => {
    const c = clean(k, st, depth + 1);
    if (!c) return;
    const asked = isSize(rawSizes[i]) ? stored(rawSizes[i]) : DEFAULT_SIZE[n.dir];
    if (c.type === 'split' && c.dir === n.dir) {
      // Flatten. A nested spine keeps its own pixel sizes; anything else shares this slot in proportion.
      const spine = hasTerm(c);
      const tot = c.sizes.reduce((a, b) => a + b, 0) || 1;
      c.kids.forEach((kk, j) => { kids.push(kk); sizes.push(spine ? c.sizes[j] : stored(asked * c.sizes[j] / tot)); });
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
function cleanSeat(raw, hiddenIds, liveGroups) {
  const seat = {};
  if (!isObject(raw)) return seat;
  for (const id of hiddenIds) {
    const s = raw[id];
    const nameOrNull = v => v === null || typeof v === 'string';
    if (isObject(s) && nameOrNull(s.group) && nameOrNull(s.beside) && SEAT_SIDES.has(s.side)) {
      // A group that no longer exists is no group: show then falls through to "beside the neighbour".
      seat[id] = { group: liveGroups.has(s.group) ? s.group : null, beside: s.beside, side: s.side };
      // A lone floating panel comes back floating where it was: its rectangle rides in the seat.
      const f = s.float;
      if (isObject(f) && isNum(f.x) && isNum(f.y) && isSize(f.w) && isSize(f.h)) seat[id].float = floatRect(f);
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
  // Each module is claimed in the tree first, then in a float, then as hidden: the first place that lists it keeps it.
  const floats = (Array.isArray(raw.floats) ? raw.floats : []).map(f => cleanFloat(f, st)).filter(Boolean);
  const reserved = seatGroups(raw.seat);
  if (r) walk(r, (n) => { if (n.type === 'group' && n.id === null) n.id = freshId(st.ids, reserved); });
  for (const f of floats) if (f.id === null) f.id = freshId(st.ids, reserved);

  if (!st.term) {
    if (!r) r = TERM();
    else if (r.dir === 'row') r = { type: 'split', dir: 'row', kids: [TERM(), ...r.kids], sizes: [0, ...r.sizes] };
    else r = { type: 'split', dir: 'row', kids: [TERM(), r], sizes: [0, DEFAULT_SIZE.row] };
  }

  const hiddenIds = (Array.isArray(raw.hidden) ? raw.hidden : []).filter(id => st.claim(id));
  const missing = [...known].filter(id => !placed.has(id) && !HIDDEN_UNTIL_USED.includes(id));
  for (const id of known) if (!placed.has(id) && HIDDEN_UNTIL_USED.includes(id)) hiddenIds.push(id);
  if (missing.length) {
    let first = null;
    walk(r, (n) => { if (!first && n.type === 'group') first = n; });
    if (first) first.tabs.push(...missing);
    else r = { type: 'split', dir: 'row', kids: [r, { type: 'group', id: freshId(st.ids, reserved), tabs: missing }], sizes: [0, DEFAULT_SIZE.row] };
  }

  const live = new Set([...groups({ root: r }).map(x => x.id), ...floats.map(f => f.id)]);
  return { version: VERSION, root: r, floats, hidden: hiddenIds, seat: cleanSeat(raw.seat, hiddenIds, live) };
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
 * app/dock-migrate.js reads the input first (L1's rules: unknown modules
 * dropped, missing ones back on the right), which cleans it before it becomes a tree.
 */
function fromV1(raw, ids) {
  // An L1 layout predates the opt-in modules: the L1 normalizer would drop one into a zone, so it is not told about them and
  // the normalize below (which does know) hides them.
  const l = migrateApi.normalizeV1(raw, ids.filter(id => !HIDDEN_UNTIL_USED.includes(id)));
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
  return { active: stringMap(isObject(raw) ? raw.active : null), foldAll: false, floatOrder: [], collapsed: {} };
}

// --- docking, hiding, showing -------------------------------------------------

const clone = v => JSON.parse(JSON.stringify(v));
const modulesIn = layout => [...groups(layout).flatMap(gr => gr.tabs), ...layout.floats.flatMap(f => f.tabs), ...layout.hidden];
const groupOf = (layout, id) => groups(layout).find(gr => gr.tabs.includes(id)) || null;
/** The float that holds a module, or null. (`groups` and `groupOf` are the TREE's: everything that walks the tree relies on that.) */
const floatOf = (layout, id) => layout.floats.find(f => f.tabs.includes(id)) || null;
/** Every tab group: the tree's, then the floats. */
const allGroups = layout => [...groups(layout), ...layout.floats];
const EDGES = ['left', 'right', 'top', 'bottom'];
const dirOf = side => (side === 'left' || side === 'right' ? 'row' : 'col');
const firstOf = side => side === 'left' || side === 'top';

// Swap `cell` for `wrap` wherever it hangs in this (private, already copied) tree.
function replaceCell(l, cell, wrap) {
  if (l.root === cell) { l.root = wrap; return; }
  // Find the parent first: `wrap` holds `cell`, so swapping while walking would walk into it forever.
  let parent = null;
  walk(l.root, (n) => { if (n.type === 'split' && n.kids.includes(cell)) parent = n; });
  if (parent) parent.kids[parent.kids.indexOf(cell)] = wrap;
}

/**
 * Put a module on a target and return the new layout (the very same object when
 * the drop changes nothing). `target` is { cell: <group id> | 'term', side } or
 * { edge }. A side splits the cell and the newcomer takes that half; `center`
 * joins the group as its last tab and is refused on the terminal.
 */
function dock(layout, id, target) {
  const fromTree = groupOf(layout, id);
  const from = fromTree || floatOf(layout, id);                             // the tree group or the float it sits in
  if (!from && !layout.hidden.includes(id)) return layout;                  // unknown module
  if (!isObject(target)) return layout;
  const byFloat = Object.prototype.hasOwnProperty.call(target, 'float');
  const byEdge = typeof target.edge === 'string';
  if (byFloat) {
    if (!(target.float === true || isObject(target.float))) return layout;
    // A panel already alone in its float: floating it again can only mean "move it there".
    if (from && !fromTree && from.tabs.length === 1) return isObject(target.float) ? moveFloat(layout, from.id, target.float) : layout;
  } else if (byEdge ? !EDGES.includes(target.edge) : (typeof target.cell !== 'string' || !SIDES.includes(target.side))) return layout;
  const side = byEdge ? target.edge : target.side;
  if (!byEdge && !byFloat) {
    const toFloat = layout.floats.some(f => f.id === target.cell);
    if (toFloat) { if (side !== 'center') return layout; }                  // a float takes a tab, never a split
    else if (target.cell === 'term') { if (side === 'center') return layout; }
    else if (!groups(layout).some(gr => gr.id === target.cell)) return layout;   // unknown cell
    // A panel dropped on its own group: nothing to join, and nothing to split out of when it is alone.
    if (from && from.id === target.cell && (side === 'center' || from.tabs.length === 1)) return layout;
  }

  const l = clone(layout);
  const src = groupOf(l, id) || floatOf(l, id);
  if (src) src.tabs = src.tabs.filter(t => t !== id);
  l.hidden = l.hidden.filter(h => h !== id);
  delete l.seat[id];

  const used = new Set(allGroups(l).map(gr => gr.id));
  if (byFloat) {
    l.floats.push({ id: freshId(used, seatGroups(l.seat)), tabs: [id], ...spotFor(layout, target.float) });
    return normalize(l, modulesIn(layout));
  }
  let cellNode = l.root;
  if (!byEdge) {
    cellNode = target.cell === 'term' ? null : allGroups(l).find(gr => gr.id === target.cell);
    if (!cellNode) walk(l.root, (n) => { if (n.type === 'term') cellNode = n; });
  }
  if (!byEdge && side === 'center') {
    cellNode.tabs.push(id);
  } else {
    const added = { type: 'group', id: freshId(used, seatGroups(l.seat)), tabs: [id] };
    const dir = dirOf(side);
    const first = firstOf(side);
    // Beside the terminal the newcomer gets a default size and the terminal's side stays 0 (the spine
    // flexes); beside anything else the two share the slot equally.
    const pixels = hasTerm(cellNode);
    const own = dir === 'row' && OWN_ROW_SIZE[id] ? OWN_ROW_SIZE[id] : DEFAULT_SIZE[dir];
    const sizes = pixels ? (first ? [own, 0] : [0, own]) : [1, 1];
    replaceCell(l, cellNode, { type: 'split', dir, kids: first ? [added, cellNode] : [cellNode, added], sizes });
  }
  const result = normalize(l, modulesIn(layout));
  // A lone panel dropped where it already sits (a rim it touches, the terminal's side next to it) rebuilds
  // the same picture under a new group name and the default size. Decided by the RESULT, not by the target.
  // Only for a tree panel: one coming from a float always changes something (the float goes).
  if (fromTree && fromTree.tabs.length === 1 && sameShape(layout.root, result.root)) return layout;
  return result;
}

// Where a new float goes: the spot asked for (any part of it may be missing or junk), else a cascade
// position, so floats made one after another never stack exactly. The cascade steps until it finds a spot no
// float holds (not "one more than the count": a float docked back leaves a gap the count would step over
// onto a float that is still there, PR #102 Dexter 3); only when all 8 are taken does it reuse one.
function spotFor(layout, spot) {
  const s = isObject(spot) ? spot : {};
  const at = n => floatRect({ x: isNum(s.x) ? s.x : CASCADE * (2 + n), y: isNum(s.y) ? s.y : CASCADE * (2 + n), w: s.w, h: s.h });
  const free = n => { const r = at(n); return !layout.floats.some(f => f.x === r.x && f.y === r.y); };
  for (let n = 0; n < 8; n += 1) if (free(n)) return at(n);
  return at(layout.floats.length % 8);
}

/**
 * Where a panel dropped on the terminal's middle floats: the new float's tab bar under the pointer (60 px in,
 * 14 down), kept whole inside the window at the default size. `{}` -- "no spot", so the cascade takes over --
 * when the pointer or the window is junk. `point` and the result are relative to the dock area.
 */
function floatSpotAt(point, viewport) {
  const vp = viewportOf(viewport);
  if (!isObject(point) || !isNum(point.x) || !isNum(point.y) || !vp) return {};
  const clampTo = (v, room) => Math.max(0, Math.min(Math.round(v), room));
  return { x: clampTo(point.x - 60, vp.width - FLOAT_DEFAULT.width), y: clampTo(point.y - 14, vp.height - FLOAT_DEFAULT.height) };
}

const viewportOf = (vp) => {
  const v = isObject(vp) ? vp : null;
  return v && isSize(v.width) && isSize(v.height) ? { width: Math.floor(v.width), height: Math.floor(v.height) } : null;
};

// Replace one float (by id) in a copy; the same layout when the change is not one.
function withFloat(layout, floatId, change) {
  const cur = layout.floats.find(f => f.id === floatId);
  if (!cur) return layout;
  const next = { ...cur, ...change(cur) };
  if (['x', 'y', 'w', 'h'].every(k => next[k] === cur[k])) return layout;
  const l = clone(layout);
  l.floats[layout.floats.indexOf(cur)] = next;
  return normalize(l, modulesIn(layout));
}

/**
 * Move a float: `pos` is { x, y }, stored as a whole number from 0. With a `viewport` (the drag's own
 * window) the float is kept whole inside it; without, the stored position is exactly what was asked for
 * (storage never clamps to a window: a wider window gives the position back). Anything that isn't a
 * float or a position, and a move that changes nothing, returns the same layout.
 */
function moveFloat(layout, floatId, pos, viewport) {
  if (!isObject(pos) || !isNum(pos.x) || !isNum(pos.y)) return layout;
  const vp = viewportOf(viewport);
  return withFloat(layout, floatId, (f) => {
    if (!vp) return { x: floatPos(pos.x), y: floatPos(pos.y) };
    const w = Math.min(f.w, vp.width);
    const h = Math.min(f.h, vp.height);
    return { x: floatPos(Math.max(0, Math.min(pos.x, vp.width - w))), y: floatPos(Math.max(0, Math.min(pos.y, vp.height - h))) };
  });
}

/** Resize a float: `size` is { w, h }, rounded and clamped to [160 x 120, 10000]; with a `viewport`, no further than its edge. */
function resizeFloat(layout, floatId, size, viewport) {
  if (!isObject(size) || !isSize(size.w) || !isSize(size.h)) return layout;
  const vp = viewportOf(viewport);
  return withFloat(layout, floatId, (f) => {
    if (!vp) return { w: floatSize(size.w, FLOAT_MIN.width, FLOAT_DEFAULT.width), h: floatSize(size.h, FLOAT_MIN.height, FLOAT_DEFAULT.height) };
    // The user resizes what they SEE: a float drawn shrunk into the corner of a small window starts from there, or the
    // first resize would make it jump (found by P11). So the position stored is the drawn one, kept inside the new size.
    const x0 = Math.max(0, Math.min(f.x, vp.width - Math.min(f.w, vp.width)));
    const y0 = Math.max(0, Math.min(f.y, vp.height - Math.min(f.h, vp.height)));
    const w = floatSize(Math.min(size.w, vp.width - x0), FLOAT_MIN.width, FLOAT_DEFAULT.width);
    const h = floatSize(Math.min(size.h, vp.height - y0), FLOAT_MIN.height, FLOAT_DEFAULT.height);
    return { x: floatPos(Math.max(0, Math.min(x0, vp.width - w))), y: floatPos(Math.max(0, Math.min(y0, vp.height - h))), w, h };
  });
}

// What a tree looks like once group names and every size are set aside: split directions and order, tabs per group.
function sameShape(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'term') return true;
  if (a.type === 'group') return a.tabs.length === b.tabs.length && a.tabs.every((t, i) => t === b.tabs[i]);
  return a.dir === b.dir && a.kids.length === b.kids.length && a.kids.every((k, i) => sameShape(k, b.kids[i]));
}

// Child indexes from the root down to `node`, or null.
function pathTo(n, node, path = []) {
  if (n === node) return path;
  if (n.type !== 'split') return null;
  for (let i = 0; i < n.kids.length; i += 1) {
    const p = pathTo(n.kids[i], node, [...path, i]);
    if (p) return p;
  }
  return null;
}

// Which side of group `b` the group `a` sits on, judged at the split where their paths part.
function sideOf(layout, a, b) {
  const pa = pathTo(layout.root, a);
  const pb = pathTo(layout.root, b);
  let k = 0;
  while (k < pa.length && k < pb.length && pa[k] === pb[k]) k += 1;
  let n = layout.root;
  for (let i = 0; i < k; i += 1) n = n.kids[pa[i]];
  if (pa[k] < pb[k]) return n.dir === 'row' ? 'left' : 'top';
  return n.dir === 'row' ? 'right' : 'bottom';
}

// A float's panel: a float that survives is remembered by name, a lone one by its rectangle (it comes back floating there).
function hideFloating(layout, id) {
  const fl = floatOf(layout, id);
  if (!fl) return layout;
  const at = fl.tabs.indexOf(id);
  const survives = fl.tabs.length > 1;
  const seat = { group: survives ? fl.id : null, beside: at > 0 ? fl.tabs[at - 1] : (survives ? fl.tabs[1] : null), side: 'center' };
  if (!survives) seat.float = { x: fl.x, y: fl.y, w: fl.w, h: fl.h };
  const l = clone(layout);
  const cur = floatOf(l, id);
  cur.tabs = cur.tabs.filter(t => t !== id);
  l.hidden.push(id);
  l.seat[id] = seat;
  return normalize(l, modulesIn(layout));
}

/**
 * Hide a module and remember its seat: the group it left (when that group
 * survives), the neighbour it sat beside and on which side. `show` puts a tab
 * back into its group; a lone panel, whose group went with it, comes back by
 * splitting beside that neighbour at an even split. The seat records where, not
 * how big: the panel's old size isn't remembered, and the neighbour's slot is
 * shared (design section 4's op table).
 */
function hide(layout, id) {
  const gr = groupOf(layout, id);
  if (!gr) return hideFloating(layout, id);                                  // a float's panel, or unknown, or already hidden
  const order = groups(layout).flatMap(x => x.tabs);                         // tree order
  const at = gr.tabs.indexOf(id);
  const survives = gr.tabs.length > 1;
  const k = order.indexOf(id);
  let beside;
  if (at > 0) beside = gr.tabs[at - 1];
  else if (survives) beside = gr.tabs[1];
  else beside = order[k - 1] || order[k + 1] || null;                        // nearest in tree order: before, else after
  const bg = beside && groupOf(layout, beside);
  const seat = {
    group: survives ? gr.id : null,
    beside,
    side: survives || !bg ? 'center' : sideOf(layout, gr, bg),
  };
  const l = clone(layout);
  groups(l).find(x => x.id === gr.id).tabs = gr.tabs.filter(t => t !== id);
  l.hidden.push(id);
  l.seat[id] = seat;
  return normalize(l, modulesIn(layout));
}

/** Bring a hidden module back: into its old group if that still exists, else beside its old neighbour, else on the right. */
function show(layout, id) {
  if (!layout.hidden.includes(id)) return layout;
  const seat = layout.seat[id];
  if (seat) {
    if (seat.group && allGroups(layout).some(x => x.id === seat.group)) return dock(layout, id, { cell: seat.group, side: 'center' });
    if (seat.float) return dock(layout, id, { float: { x: seat.float.x, y: seat.float.y, w: seat.float.w, h: seat.float.h } });
    const near = seat.beside && groupOf(layout, seat.beside);
    if (near) return dock(layout, id, { cell: near.id, side: seat.side });
    // The neighbour may have floated since (PR #102 Dexter 5): a float takes a tab, never a split.
    const nearFloat = seat.beside && floatOf(layout, seat.beside);
    if (nearFloat) return dock(layout, id, { cell: nearFloat.id, side: 'center' });
  }
  return dock(layout, id, { edge: 'right' });
}

// --- sizes ---------------------------------------------------------------------

/** The least a subtree may be given: rows add widths (and gutters) and take the tallest, columns the mirror. */
function minSize(n) {
  if (n.type === 'term') return { ...TERM_MIN };
  if (n.type === 'group') return { ...MIN };
  const ms = n.kids.map(minSize);
  const gutters = GUTTER * (n.kids.length - 1);
  if (n.dir === 'row') return { width: ms.reduce((s, m) => s + m.width, 0) + gutters, height: Math.max(...ms.map(m => m.height)) };
  return { width: Math.max(...ms.map(m => m.width)), height: ms.reduce((s, m) => s + m.height, 0) + gutters };
}
const along = (n, dir) => minSize(n)[dir === 'row' ? 'width' : 'height'];

// What `fit` needs of a subtree in THIS window: a group the window collapsed costs its rail (not a panel's minimum),
// and no gutter is drawn against a rail. `setSplitSizes` stays on the selection-blind `minSize`: it stores the shared layout.
function minSizeSel(n, sel) {
  if (n.type === 'term') return { ...TERM_MIN };
  if (isShut(n, sel)) return { width: RAIL.side, height: RAIL.wide };
  if (n.type === 'group') return { ...MIN };
  const ms = n.kids.map(k => minSizeSel(k, sel));
  const open = n.kids.map(k => !isShut(k, sel));
  // With the terminal in the split every open fixed kid has one gutter on the spine's side; without it, two open kids side by side share one.
  const gaps = hasTerm(n) ? open.filter((o, i) => o && !hasTerm(n.kids[i])).length : open.filter((o, i) => o && i > 0 && open[i - 1]).length;
  if (n.dir === 'row') return { width: ms.reduce((s, m) => s + m.width, 0) + GUTTER * gaps, height: Math.max(...ms.map(m => m.height)) };
  return { width: Math.max(...ms.map(m => m.width)), height: ms.reduce((s, m) => s + m.height, 0) + GUTTER * gaps };
}
const alongSel = (n, dir, sel) => minSizeSel(n, sel)[dir === 'row' ? 'width' : 'height'];

/**
 * A divider drag's result: the sizes of the split at `path` (child indexes from
 * the root). Rounded, never under a kid's minimum, never over MAX_SIZE, the kid
 * that holds the terminal still 0. Anything that isn't a well-formed request
 * for an existing split changes nothing.
 */
function setSplitSizes(layout, path, sizes) {
  if (!Array.isArray(path) || !Array.isArray(sizes) || !sizes.every(isSize)) return layout;
  const at = (tree) => {
    let n = tree;
    for (const i of path) {
      if (n.type !== 'split' || !Number.isInteger(i) || i < 0 || i >= n.kids.length) return null;
      n = n.kids[i];
    }
    return n.type === 'split' && n.kids.length === sizes.length ? n : null;
  };
  if (!at(layout.root)) return layout;
  const l = clone(layout);
  const split = at(l.root);
  split.sizes = split.kids.map((k, i) => (hasTerm(k) ? 0 : Math.min(MAX_SIZE, Math.max(along(k, split.dir), Math.round(sizes[i])))));
  return normalize(l, modulesIn(layout));
}

// --- selection -----------------------------------------------------------------
//
// Which tab each group shows, and whether everything is folded (Ctrl+B), belong
// to the WINDOW (localStorage), not to the layout: clicking Vault in one window
// never switches another (L1 S3a). A selection is { active: { [groupId]: moduleId }, foldAll, floatOrder,
// collapsed: { [groupId]: true } } -- the groups this window collapsed on purpose (D4), as Ctrl+B folds them all.

/** A selection from anything stored. */
const MAX_FLOAT_ORDER = 32;                           // a damaged file can't grow the list without end
const MAX_COLLAPSED = 64;                             // ...nor can this one
const MAX_COLLAPSED_TABS = 32;

// A selection also holds which float is on top, bottom to top: pressing a float raises it in THIS window only,
// so a click never writes the shared layout. Ids of floats that are gone stay until pushed out; `fit` ignores them.
function cleanSelection(raw) {
  const r = isObject(raw) ? raw : {};
  const order = (Array.isArray(r.floatOrder) ? r.floatOrder : []).filter(x => typeof x === 'string' && x !== '');
  // Unique, keeping each id's LAST place (that is where it was last raised).
  const floatOrder = order.filter((x, i) => order.lastIndexOf(x) === i).slice(-MAX_FLOAT_ORDER);
  // Only a real `true` collapses: `1`, `'yes'` and `{}` are damage, not a choice.
  const collapsed = {};
  if (isObject(r.collapsed)) {
    for (const [k, v] of Object.entries(r.collapsed)) {
      if (k === '' || Object.keys(collapsed).length >= MAX_COLLAPSED) continue;
      // `true`: any group of that name. A list of module ids: the group that held them when it was collapsed.
      if (v === true) collapsed[k] = true;
      else if (Array.isArray(v)) {
        const ids = v.filter(x => typeof x === 'string' && x !== '').slice(0, MAX_COLLAPSED_TABS);
        if (ids.length) collapsed[k] = ids;
      }
    }
  }
  return { active: stringMap(r.active), foldAll: r.foldAll === true, floatOrder, collapsed };
}

/** Put a float on top of the others, in this window's selection. */
function raiseFloat(sel, floatId) {
  const s = cleanSelection(sel);
  if (typeof floatId !== 'string' || floatId === '' || s.floatOrder[s.floatOrder.length - 1] === floatId) return s;
  return cleanSelection({ ...s, floatOrder: [...s.floatOrder, floatId] });
}

/** A tab click: that module shows in its group (a float comes to the top), and Ctrl+B's fold is undone. */
function selectTab(sel, layout, id) {
  const s = cleanSelection(sel);
  const gr = groupOf(layout, id) || floatOf(layout, id);
  if (!gr) return s;
  // A tab is chosen to be SEEN (a click on it in a popover, a panel dropped or ticked into its group): its group opens.
  const { [gr.id]: _was, ...stillShut } = s.collapsed;
  const picked = { ...s, active: { ...s.active, [gr.id]: id }, foldAll: false, collapsed: stillShut };
  return layout.floats.includes(gr) ? raiseFloat(picked, gr.id) : picked;
}

/** Collapse a group of the tree to its rail in this window, or open it again. Floats, the terminal and unknown names change nothing. */
function toggleCollapse(sel, layout, groupId) {
  const s = cleanSelection(sel);
  if (typeof groupId !== 'string' || !groups(layout).some(gr => gr.id === groupId)) return s;
  const collapsed = { ...s.collapsed };
  const gr = groups(layout).find(x => x.id === groupId);
  // Which group, not just which name: another layout can hand the name to a different group (PR #159 Dexter 3).
  if (collapsed[groupId]) delete collapsed[groupId]; else collapsed[groupId] = [...gr.tabs].slice(0, MAX_COLLAPSED_TABS);
  return { ...s, collapsed };
}

/**
 * The selection without collapsed groups the layout no longer has: a destroyed group's name is free to reuse, and
 * a new group handed it would start collapsed. The very same selection when nothing was stale.
 */
function pruneCollapsed(sel, layout) {
  const grs = groups(layout);
  const keepsRail = ([k, v]) => { const gr = grs.find(x => x.id === k); return !!gr && isCollapsed({ collapsed: { [k]: v } }, gr); };
  if (!isObject(sel) || !isObject(sel.collapsed) || Object.entries(sel.collapsed).every(keepsRail)) return sel;
  return cleanSelection({ ...sel, collapsed: Object.fromEntries(Object.entries(sel.collapsed).filter(keepsRail)) });
}

/**
 * Whether a node is drawn as a rail because of what this window collapsed: a collapsed group, or a split with no terminal
 * in it whose every kid is (a column of folded groups is one rail, whose popover lists them all; PR #159 Dexter 2).
 */
function isShut(n, sel) {
  if (n.type === 'group') return isCollapsed(sel, n);
  return n.type === 'split' && !hasTerm(n) && n.kids.every(k => isShut(k, sel));
}

/** Whether this window collapsed THIS group: its name is in the list and (when the choice remembers tabs) it still holds one of them. */
function isCollapsed(sel, group) {
  const rec = isObject(sel) && isObject(sel.collapsed) && isObject(group) ? sel.collapsed[group.id] : undefined;
  if (rec === true) return true;
  return Array.isArray(rec) && Array.isArray(group.tabs) && group.tabs.some(t => rec.includes(t));
}

function toggleFoldAll(sel) {
  const s = cleanSelection(sel);
  return { ...s, foldAll: !s.foldAll };
}

/** What a group shows in this window: its choice if the group still holds it, else its first tab. */
function activeOf(layout, sel, group) {
  const gr = typeof group === 'string' ? allGroups(layout).find(x => x.id === group) : group;
  if (!gr) return null;
  const want = cleanSelection(sel).active[gr.id];
  return typeof want === 'string' && gr.tabs.includes(want) ? want : gr.tabs[0];
}

// --- fit -----------------------------------------------------------------------
//
// A layout plus a window size becomes a flat list of integer rectangles; nothing
// else decides geometry. The stored layout is never changed by fitting, so a
// wider window brings everything back.

const dim = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * Whole pixels from fractional shares that add up to `total`: each share is
 * floored (the epsilon keeps 79.9999999 from landing under a minimum of 80),
 * then the pixels left over go to the largest fractions, earlier kids first.
 */
function wholePixels(shares, total) {
  const floors = shares.map(x => Math.floor(x + 1e-9));
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = shares.map((x, i) => i).sort((a, b) => (shares[b] - floors[b]) - (shares[a] - floors[a]) || a - b);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left -= 1) floors[order[k]] += 1;
  return floors;
}

// The pixels of a split with no terminal in it: sizes are proportions, a kid under its minimum is raised.
// `shut[i]`: kid i is a group this window collapsed -- a rail, with no gutter against it; the others share the rest.
function plainLengths(n, length, shut, sel) {
  const rail = n.dir === 'row' ? RAIL.side : RAIL.wide;
  // (A split whose every kid is collapsed is a rail in ITS parent, so it never gets here; the root always holds the
  // terminal.) Rails that don't fit are no choice anyone made: the split is drawn open.
  const folded = shut.every(Boolean) || rail * shut.filter(Boolean).length > length ? shut.map(() => false) : shut;
  const idx = n.kids.map((_, i) => i).filter(i => !folded[i]);
  const room = length - rail * (n.kids.length - idx.length);
  const gaps = idx.filter((i, k) => k > 0 && idx[k - 1] === i - 1).length;   // two open kids side by side
  const gutter = room >= GUTTER * gaps ? GUTTER : 0;                         // a window too small for them has none
  const avail = room - gutter * gaps;
  const mins = idx.map(i => alongSel(n.kids[i], n.dir, sel));
  const total = idx.reduce((a, i) => a + n.sizes[i], 0);
  let w = idx.map(i => (total > 0 ? avail * n.sizes[i] / total : avail / idx.length));
  if (mins.reduce((a, b) => a + b, 0) <= avail && w.some((x, i) => x < mins[i])) {
    // The ones under their minimum take it; the others pay, in proportion to their slack. That never
    // takes anyone under their own minimum, because the slack covers the deficit whenever the minimums fit.
    const under = w.map((x, i) => x < mins[i]);
    const deficit = w.reduce((s, x, i) => s + (under[i] ? mins[i] - x : 0), 0);
    const slack = w.reduce((s, x, i) => s + (under[i] ? 0 : x - mins[i]), 0);
    w = w.map((x, i) => (under[i] ? mins[i] : x - deficit * (x - mins[i]) / slack));
  }
  const px = wholePixels(w, avail);
  const len = n.kids.map((_, i) => (folded[i] ? rail : px[idx.indexOf(i)]));
  return {
    len,
    state: folded.map(f => (f ? 'rail' : 'open')),
    gutter: len.map((_, i) => (i > 0 && !folded[i] && !folded[i - 1] ? gutter : 0)),
  };
}

/*
 * The pixels of a SPINE split (the terminal is somewhere below one kid; the
 * others are fixed). Fixed kids keep what the user dragged, and the spine kid
 * takes the rest. When that leaves the spine kid under its minimum:
 *   a. every fixed kid gets what it asked (at least its minimum) -- if the spine kid fits;
 *   b. else each gets its minimum plus a share of what is spare, in proportion to
 *      how far above its minimum it asked (L1's corrected arithmetic);
 *   c. else FOLD, farthest from the spine first (ties: the later one): a folded kid is
 *      a rail, with no gutter, and a/b are tried again for the kids still open;
 *   d. all folded and the rails still leave the terminal less than its own minimum: drop
 *      the rails, farthest first.
 * `foldAll` (Ctrl+B) starts at c with everything folded.
 */
function spineLengths(n, length, foldAll, shut, sel) {
  const { dir, kids } = n;
  const s = kids.findIndex(hasTerm);
  const termMin = dir === 'row' ? TERM_MIN.width : TERM_MIN.height;
  const rail = dir === 'row' ? RAIL.side : RAIL.wide;
  const need = alongSel(kids[s], dir, sel);
  const mins = kids.map(k => alongSel(k, dir, sel));
  const ask = i => Math.max(mins[i], Math.round(n.sizes[i]));
  const fixed = kids.map((_, i) => i).filter(i => i !== s);
  // Farthest from the spine folds first. The groups this window collapsed are rails already: they head the order,
  // and the search for room starts after them (a, b, c, d below then work on the kids still open).
  const far = (a, b) => Math.abs(b - s) - Math.abs(a - s) || b - a;
  const order = [...fixed.filter(i => shut[i]).sort(far), ...fixed.filter(i => !shut[i]).sort(far)];
  const collapsedCount = fixed.filter(i => shut[i]).length;

  const settle = (folded, dropped, sizes) => {
    const len = kids.map(() => 0);
    const state = kids.map(() => 'open');
    for (const i of order.slice(0, folded)) {
      state[i] = dropped.has(i) ? 'gone' : 'rail';
      len[i] = dropped.has(i) ? 0 : rail;
    }
    let used = 0;
    for (const i of fixed) {
      if (state[i] === 'open') len[i] = sizes[i];
      used += len[i];
    }
    const open = fixed.filter(i => state[i] === 'open');
    len[s] = length - used - GUTTER * open.length;
    return { len, state, gutter: kids.map((_, i) => (i > 0 && (i <= s ? state[i - 1] === 'open' : state[i] === 'open') ? GUTTER : 0)) };
  };

  // The last pass (k = every kid folded) always returns, so the loop has no other way out.
  for (let k = foldAll ? order.length : collapsedCount; ; k += 1) {
    const open = order.slice(k);
    const avail = length - GUTTER * open.length - rail * k;
    if (k === order.length) {
      // c ends and d begins: everything is a rail; the terminal needs only its own minimum now.
      if (avail >= termMin) return settle(k, new Set(), {});
      let kept = k;
      while (kept > 0 && length - rail * kept < termMin) kept -= 1;
      return settle(k, new Set(order.slice(0, k - kept)), {});
    }
    const want = {};
    open.forEach((i) => { want[i] = ask(i); });
    const sumWant = open.reduce((a, i) => a + want[i], 0);
    if (avail - sumWant >= need) return settle(k, new Set(), want);
    const sumMin = open.reduce((a, i) => a + mins[i], 0);
    if (avail - sumMin >= need) {
      const spare = avail - need - sumMin;
      const above = sumWant - sumMin;
      const sizes = {};
      open.forEach((i) => { sizes[i] = mins[i] + Math.floor((want[i] - mins[i]) / above * spare); });
      return settle(k, new Set(), sizes);
    }
  }
}

const modulesUnder = n => groups({ root: n }).flatMap(gr => gr.tabs);

function place(n, rect, path, ctx) {
  if (n.type === 'term') { ctx.boxes.push({ kind: 'term', rect }); return; }
  if (n.type === 'group') {
    ctx.boxes.push({ kind: 'group', id: n.id, tabs: [...n.tabs], active: activeOf(ctx.layout, ctx.sel, n), rect });
    return;
  }
  const isRow = n.dir === 'row';
  const length = isRow ? rect.width : rect.height;
  const shut = n.kids.map(k => isShut(k, ctx.sel));
  const { len, state, gutter } = hasTerm(n) ? spineLengths(n, length, ctx.sel.foldAll, shut, ctx.sel) : plainLengths(n, length, shut, ctx.sel);
  ctx.splits.push({
    path, dir: n.dir, px: len, state,
    // A rail is as small as it gets, so a divider drag can't ask it for less.
    min: n.kids.map((k, i) => (state[i] === 'open' ? alongSel(k, n.dir, ctx.sel) : len[i])),
  });
  let pos = isRow ? rect.x : rect.y;
  n.kids.forEach((k, i) => {
    if (gutter[i] > 0) {
      ctx.boxes.push({
        kind: 'gutter', path, i, dir: n.dir,
        rect: isRow ? { x: pos, y: rect.y, width: gutter[i], height: rect.height } : { x: rect.x, y: pos, width: rect.width, height: gutter[i] },
      });
      pos += gutter[i];
    }
    const r = isRow ? { x: pos, y: rect.y, width: len[i], height: rect.height } : { x: rect.x, y: pos, width: rect.width, height: len[i] };
    pos += len[i];
    if (state[i] === 'gone') return;
    // `groups`: the groups behind the rail (a folded column holds several), so a keyboard move can start on the one that holds a panel.
    if (state[i] === 'rail') ctx.boxes.push({ kind: 'rail', dir: isRow ? 'v' : 'h', modules: modulesUnder(k), groups: groups({ root: k }).map(gr => ({ id: gr.id, tabs: [...gr.tabs] })), rect: r });
    else place(k, r, [...path, i], ctx);
  });
}

// Floats come after the tree's boxes, bottom to top: the ones never raised in this window (in layout order), then
// the raised ones in the order they were raised. Each is drawn whole inside the area, shrunk if the area is smaller
// than it; they never fold to rails and never take room from the terminal. Ctrl+B hides them (fit isn't asked).
function placeFloats(layout, ctx, area) {
  const rank = id => ctx.sel.floatOrder.indexOf(id);
  const ordered = layout.floats.map((f, i) => ({ f, i })).sort((a, b) => (rank(a.f.id) - rank(b.f.id)) || a.i - b.i);
  for (const { f } of ordered) {
    const width = Math.min(f.w, area.width);
    const height = Math.min(f.h, area.height);
    ctx.boxes.push({
      kind: 'float', id: f.id, tabs: [...f.tabs], active: activeOf(layout, ctx.sel, f),
      rect: { x: Math.max(0, Math.min(f.x, area.width - width)), y: Math.max(0, Math.min(f.y, area.height - height)), width, height },
    });
  }
}

// --- a rail's panel over the terminal (D4) --------------------------------------------------

// How much of the window the popover of a rail takes: a vertical rail's is this wide, a horizontal rail's this high,
// and along the rail it is at least this long (more when the rail is longer).
const PEEK = { side: 280, wide: 220, span: 420 };

/**
 * Where the panel of a module on a rail opens. A group folded to a rail (collapsed on purpose, Ctrl+B, or squeezed by a
 * narrow window) has no room for its panel, so it opens as a popover beside the rail, on the side with the most room,
 * over whatever is drawn there. Whole pixels, always inside the window, never over its own rail.
 * `boxes` are `fit`'s; the answer is { module, modules, dir, rect } -- `modules` the rail's, for the popover's tabs --
 * or null when no rail holds the module (the popover closes by itself when its rail goes) or the window is junk.
 */
function peekFor(boxes, module, viewport) {
  const vp = viewportOf(viewport);
  if (!vp || typeof module !== 'string' || !Array.isArray(boxes)) return null;
  const rail = boxes.find(b => isObject(b) && b.kind === 'rail' && Array.isArray(b.modules) && b.modules.includes(module)
    && isObject(b.rect) && ['x', 'y', 'width', 'height'].every(k => isNum(b.rect[k])));
  if (!rail || (rail.dir !== 'v' && rail.dir !== 'h')) return null;
  const r = rail.rect;
  const clampTo = (v, room) => Math.max(0, Math.min(Math.round(v), room));
  if (rail.dir === 'v') {
    const before = r.x;
    const after = vp.width - (r.x + r.width);
    const width = Math.floor(Math.min(PEEK.side, Math.max(before, after)));
    const height = Math.min(vp.height, Math.max(Math.round(r.height), PEEK.span));
    if (width <= 0 || height <= 0) return null;
    return { module, modules: [...rail.modules], dir: 'v', rect: { x: Math.round(after >= before ? r.x + r.width : r.x - width), y: clampTo(r.y, vp.height - height), width, height } };
  }
  const before = r.y;
  const after = vp.height - (r.y + r.height);
  const height = Math.floor(Math.min(PEEK.wide, Math.max(before, after)));
  const width = Math.min(vp.width, Math.max(Math.round(r.width), PEEK.span));
  if (width <= 0 || height <= 0) return null;
  return { module, modules: [...rail.modules], dir: 'h', rect: { x: clampTo(r.x, vp.width - width), y: Math.round(after >= before ? r.y + r.height : r.y - height), width, height } };
}

/**
 * @param layout    a normalized layout
 * @param selection this window's choices (anything: it is cleaned)
 * @param viewport  { width, height } of the area the tree fills
 * @returns { boxes, splits } boxes: term / group / gutter / rail, each with an integer rect;
 *          splits: what a divider drag needs -- per split, the rendered size and the minimum of each kid.
 */
function fit(layout, selection, viewport) {
  const vp = isObject(viewport) ? viewport : {};
  const ctx = { layout, sel: cleanSelection(selection), boxes: [], splits: [] };
  const area = { width: dim(vp.width), height: dim(vp.height) };
  place(layout.root, { x: 0, y: 0, ...area }, [], ctx);
  if (!ctx.sel.foldAll) placeFloats(layout, ctx, area);
  return { boxes: ctx.boxes, splits: ctx.splits };
}

const API = {
  HIDDEN_UNTIL_USED, VERSION, MIN, TERM_MIN, RAIL, GUTTER, DEFAULT_SIZE, FLOAT_MIN, FLOAT_DEFAULT, CASCADE, defaultLayout, normalize, groups, count, hasTerm,
  fromV1, readAny, selectionFromV1, groupOf, floatOf, allGroups, dock, moveFloat, resizeFloat, floatSpotAt, hide, show, minSize, setSplitSizes,
  cleanSelection, selectTab, raiseFloat, toggleFoldAll, toggleCollapse, pruneCollapsed, isCollapsed, activeOf, fit, peekFor, PEEK,
};

// One namespace on the page (`window.dockTree`), not a dozen loose globals.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockTree = API;

})(typeof window !== 'undefined' ? window : globalThis);
