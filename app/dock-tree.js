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

// A size is stored at least 1: 5e-324 is "positive" but half of it is 0, and a stored 0 for a kid that
// doesn't hold the terminal is read as "no size" by the next normalize (found by P2).
const stored = v => Math.min(MAX_SIZE, Math.max(1, v));

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
function cleanSeat(raw, hiddenIds) {
  const seat = {};
  if (!isObject(raw)) return seat;
  for (const id of hiddenIds) {
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

  const hiddenIds = (Array.isArray(raw.hidden) ? raw.hidden : []).filter(id => st.claim(id));
  const missing = [...known].filter(id => !placed.has(id));
  if (missing.length) {
    let first = null;
    walk(r, (n) => { if (!first && n.type === 'group') first = n; });
    if (first) first.tabs.push(...missing);
    else r = { type: 'split', dir: 'row', kids: [r, { type: 'group', id: freshId(st.ids), tabs: missing }], sizes: [0, DEFAULT_SIZE.row] };
  }

  return { version: VERSION, root: r, floats: [], hidden: hiddenIds, seat: cleanSeat(raw.seat, hiddenIds) };
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

// --- docking, hiding, showing -------------------------------------------------

const clone = v => JSON.parse(JSON.stringify(v));
const modulesIn = layout => [...groups(layout).flatMap(gr => gr.tabs), ...layout.hidden];
const groupOf = (layout, id) => groups(layout).find(gr => gr.tabs.includes(id)) || null;
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
  const from = groupOf(layout, id);
  if (!from && !layout.hidden.includes(id)) return layout;                  // unknown module
  if (!isObject(target)) return layout;
  const byEdge = typeof target.edge === 'string';
  if (byEdge ? !EDGES.includes(target.edge) : (typeof target.cell !== 'string' || !SIDES.includes(target.side))) return layout;
  const side = byEdge ? target.edge : target.side;
  if (!byEdge) {
    if (target.cell === 'term') { if (side === 'center') return layout; }
    else if (!groups(layout).some(gr => gr.id === target.cell)) return layout;   // unknown cell
    // A panel dropped on its own group: nothing to join, and nothing to split out of when it is alone.
    if (from && from.id === target.cell && (side === 'center' || from.tabs.length === 1)) return layout;
  }

  const l = clone(layout);
  const src = groupOf(l, id);
  if (src) src.tabs = src.tabs.filter(t => t !== id);
  l.hidden = l.hidden.filter(h => h !== id);
  delete l.seat[id];

  let cellNode = l.root;
  if (!byEdge) {
    cellNode = target.cell === 'term' ? null : groups(l).find(gr => gr.id === target.cell);
    if (!cellNode) walk(l.root, (n) => { if (n.type === 'term') cellNode = n; });
  }
  if (!byEdge && side === 'center') {
    cellNode.tabs.push(id);
  } else {
    const used = new Set(groups(l).map(gr => gr.id));
    const added = { type: 'group', id: freshId(used), tabs: [id] };
    const dir = dirOf(side);
    const first = firstOf(side);
    // Beside the terminal the newcomer gets a default size and the terminal's side stays 0 (the spine
    // flexes); beside anything else the two share the slot equally.
    const pixels = hasTerm(cellNode);
    const sizes = pixels ? (first ? [DEFAULT_SIZE[dir], 0] : [0, DEFAULT_SIZE[dir]]) : [1, 1];
    replaceCell(l, cellNode, { type: 'split', dir, kids: first ? [added, cellNode] : [cellNode, added], sizes });
  }
  return normalize(l, modulesIn(layout));
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

/**
 * Hide a module and remember its seat: the group it left (when that group
 * survives), the neighbour it sat beside and on which side, so `show` can put
 * it back where it was.
 */
function hide(layout, id) {
  const gr = groupOf(layout, id);
  if (!gr) return layout;                                                    // unknown, or already hidden
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
    if (seat.group && groups(layout).some(x => x.id === seat.group)) return dock(layout, id, { cell: seat.group, side: 'center' });
    const near = seat.beside && groupOf(layout, seat.beside);
    if (near) return dock(layout, id, { cell: near.id, side: seat.side });
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
// never switches another (L1 S3a). A selection is { active: { [groupId]: moduleId }, foldAll }.

/** A selection from anything stored. */
function cleanSelection(raw) {
  const r = isObject(raw) ? raw : {};
  return { active: stringMap(r.active), foldAll: r.foldAll === true };
}

/** A tab click: that module shows in its group, and Ctrl+B's fold is undone. */
function selectTab(sel, layout, id) {
  const s = cleanSelection(sel);
  const gr = groupOf(layout, id);
  if (!gr) return s;
  return { active: { ...s.active, [gr.id]: id }, foldAll: false };
}

function toggleFoldAll(sel) {
  const s = cleanSelection(sel);
  return { active: s.active, foldAll: !s.foldAll };
}

/** What a group shows in this window: its choice if the group still holds it, else its first tab. */
function activeOf(layout, sel, group) {
  const gr = typeof group === 'string' ? groups(layout).find(x => x.id === group) : group;
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
function plainLengths(n, length) {
  const m = n.kids.length;
  const gutter = length >= GUTTER * (m - 1) ? GUTTER : 0;                    // a window too small for them has none
  const avail = length - gutter * (m - 1);
  const mins = n.kids.map(k => along(k, n.dir));
  const total = n.sizes.reduce((a, b) => a + b, 0);
  let w = n.sizes.map(s => (total > 0 ? avail * s / total : avail / m));
  if (mins.reduce((a, b) => a + b, 0) <= avail && w.some((x, i) => x < mins[i])) {
    // The ones under their minimum take it; the others pay, in proportion to their slack. That never
    // takes anyone under their own minimum, because the slack covers the deficit whenever the minimums fit.
    const under = w.map((x, i) => x < mins[i]);
    const deficit = w.reduce((s, x, i) => s + (under[i] ? mins[i] - x : 0), 0);
    const slack = w.reduce((s, x, i) => s + (under[i] ? 0 : x - mins[i]), 0);
    w = w.map((x, i) => (under[i] ? mins[i] : x - deficit * (x - mins[i]) / slack));
  }
  const len = wholePixels(w, avail);
  return { len, state: len.map(() => 'open'), gutter: len.map((_, i) => (i > 0 ? gutter : 0)) };
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
function spineLengths(n, length, foldAll) {
  const { dir, kids } = n;
  const s = kids.findIndex(hasTerm);
  const termMin = dir === 'row' ? TERM_MIN.width : TERM_MIN.height;
  const rail = dir === 'row' ? RAIL.side : RAIL.wide;
  const need = along(kids[s], dir);
  const mins = kids.map(k => along(k, dir));
  const ask = i => Math.max(mins[i], Math.round(n.sizes[i]));
  const fixed = kids.map((_, i) => i).filter(i => i !== s);
  const order = [...fixed].sort((a, b) => Math.abs(b - s) - Math.abs(a - s) || b - a);

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
  for (let k = foldAll ? order.length : 0; ; k += 1) {
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
  const { len, state, gutter } = hasTerm(n) ? spineLengths(n, length, ctx.sel.foldAll) : plainLengths(n, length);
  ctx.splits.push({
    path, dir: n.dir, px: len,
    // A rail is as small as it gets, so a divider drag can't ask it for less.
    min: n.kids.map((k, i) => (state[i] === 'open' ? along(k, n.dir) : len[i])),
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
    if (state[i] === 'rail') ctx.boxes.push({ kind: 'rail', dir: isRow ? 'v' : 'h', modules: modulesUnder(k), rect: r });
    else place(k, r, [...path, i], ctx);
  });
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
  place(layout.root, { x: 0, y: 0, width: dim(vp.width), height: dim(vp.height) }, [], ctx);
  return { boxes: ctx.boxes, splits: ctx.splits };
}

const API = {
  VERSION, MIN, TERM_MIN, RAIL, GUTTER, DEFAULT_SIZE, defaultLayout, normalize, groups, count, hasTerm,
  fromV1, readAny, selectionFromV1, groupOf, dock, hide, show, minSize, setSplitSizes,
  cleanSelection, selectTab, toggleFoldAll, activeOf, fit,
};

// One namespace on the page (`window.dockTree`), not a dozen loose globals.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockTree = API;

})(typeof window !== 'undefined' ? window : globalThis);
