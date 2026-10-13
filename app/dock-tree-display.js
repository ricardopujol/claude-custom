'use strict';
/**
 * Drawing a dock tree (BACKLOG #53, dockable panels D1, Task 9).
 *
 * Two halves. `treePlan`, `dragSizes`,
 * `sizesAfterDrag`, `menuRows` and `afterTreeGet` are pure: what each group
 * shows, how a divider drag changes the sizes, what the Window menu lists, what
 * the page does with the store's answer. `applyBoxes` copies a plan onto the page
 * and nothing else -- it makes no decisions, so a wrong window means a wrong
 * plan, and the plan is tested.
 *
 * Boxes are absolutely positioned siblings of #dock, one per group id, reused
 * across renders: panels are MOVED between groups (appendChild), never rebuilt
 * (the vault's masked field, the Models search and an open agent log hold live
 * state), and #termwrap is never reparented.
 */

/*
 * WRAPPED IN AN IIFE: plain <script> files share one global scope
 * (test/renderer-scope.test.js). The page sees one name, `dockTreeView`.
 */
(function (root) {

// Loaded the way app/dock-tree.js loads its own helpers: required under Node, a page global in the window.
const treeApi = typeof module !== 'undefined' && module.exports ? require('./dock-tree') : root.dockTree;
const effectsApi = typeof module !== 'undefined' && module.exports ? require('./dock-effects') : root.dockEffects;
const { fit, hasTerm } = treeApi;
const { WIDE_FACE_CHROME } = effectsApi;

const isNumber = v => typeof v === 'number' && Number.isFinite(v);
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isSize = v => isNumber(v) && v > 0;

/** A box at least twice as wide as tall lays its panel out as a row (every panel has both shapes from L1). */
const shapeOf = rect => (rect.width >= 2 * rect.height ? 'wide' : 'tall');

/** Portraits in a wide group: bounded by its height minus its tab bar and the card's name line. */
const faceForWide = height => Math.max(28, Math.min(150, height - WIDE_FACE_CHROME));

/**
 * @param layout   a normalized layout (app/dock-tree.js)
 * @param selection this window's choices ({ active, foldAll })
 * @param tabs     the module registry: [{ id, label, title }] (app/side-tabs.js TABS)
 * @param viewport { width, height } of #dock
 * @param faceSize width -> portrait px (app/roster-width.js)
 * @param peek     { module } the rail button this window pressed (D4), or null: its panel opens over the terminal
 * @returns { boxes, splits, shown, face, peek } `fit`'s boxes with each group's tabs, panel and shape filled in;
 *          `shown` the panels on screen (the popover's included); `face` the portrait size while Agents shows, else null;
 *          `peek` the popover { module, rect, dir, tabs } or null (no such rail any more).
 */
function treePlan(layout, selection, tabs, viewport, { faceSize, peek } = {}) {
  const { boxes, splits } = fit(layout, selection, viewport);
  const byId = new Map(tabs.map(t => [t.id, t]));
  const shown = [];
  let face = null;
  const named = ids => ids.filter(id => byId.has(id)).map((id) => {
    const t = byId.get(id);
    return { id, label: t.label, title: t.title };
  });
  const drawn = boxes.map((b) => {
    if (b.kind === 'rail') return { ...b, tabs: named(b.modules) };
    if (b.kind !== 'group' && b.kind !== 'float') return b;       // a float is planned exactly like a group
    const shape = shapeOf(b.rect);
    if (b.active !== null) shown.push(b.active);
    if (b.active === 'agents') {
      face = shape === 'tall' ? (typeof faceSize === 'function' ? faceSize(b.rect.width) : null) : faceForWide(b.rect.height);
    }
    return {
      ...b,
      shape,
      panel: b.active,
      pinnable: b.active,                                            // the Pinned button unpins the panel the group shows
      tabs: named(b.tabs).map(t => ({ ...t, on: t.id === b.active })),
    };
  });
  // A rail's panel opened over the terminal. It is on screen like any other panel (so the vault rule sees it come and go).
  let popover = null;
  const at = isObject(peek) ? treeApi.peekFor(boxes, peek.module, viewport) : null;
  if (at) {
    const shape = shapeOf(at.rect);
    // Pin shows only on a panel of the dock's own rail (#85): one a folded group put on a rail was never unpinned.
    // `from`: the side of the popover its rail is on, which is where it slides in from.
    const rb = boxes.find(x => x.kind === 'rail' && x.modules.includes(at.module));
    const from = at.dir === 'v' ? (at.rect.x < rb.rect.x ? 'right' : 'left') : (at.rect.y < rb.rect.y ? 'bottom' : 'top');
    const pin = rb.id === 'dock' && Array.isArray(layout.rail) && layout.rail.includes(at.module);
    popover = { ...at, shape, from, pin, tabs: named(at.modules).map(t => ({ ...t, on: t.id === at.module })) };
    if (popover.tabs.some(t => t.id === at.module)) {
      shown.push(at.module);
      if (at.module === 'agents') face = shape === 'tall' ? (typeof faceSize === 'function' ? faceSize(at.rect.width) : null) : faceForWide(at.rect.height);
    } else popover = null;
  }
  return { boxes: drawn, splits, shown, face, peek: popover };
}

/**
 * What a rail's popover does with what the user does (D4). The page keeps only `{ module }` or null, never saved:
 *   rail     a rail's button: opens that module, moves it from another rail's, closes it if it is the open one
 *   tab      a tab inside the popover: switches it
 *   escape / outside / drop / gone   (Esc, a press outside it, a tab drop, its rail no longer exists): closes
 * Anything else changes nothing.
 */
function peekAfter(state, ev) {
  const cur = isObject(state) && typeof state.module === 'string' && state.module !== '' ? { module: state.module } : null;
  const e = isObject(ev) ? ev : {};
  const mod = typeof e.module === 'string' && e.module !== '' ? e.module : null;
  switch (e.type) {
    case 'rail':
      if (mod === null) return cur;
      return cur && cur.module === mod ? null : { module: mod };
    case 'tab': return cur && mod !== null ? { module: mod } : cur;
    case 'escape': case 'outside': case 'drop': case 'gone': return null;
    default: return cur;
  }
}

/** The rail's hover state when nothing is open or waiting (see `railAfter`). */
const RAIL_IDLE = Object.freeze({ module: null, held: false, pending: null, leaving: false });

/**
 * The hover behaviour of the dock's rail tabs (BACKLOG #85), pure and timer-free: the page owns the two timers (a hover waits
 * 200 ms before it opens a panel; leaving waits 400 ms before it closes one) and feeds `open-timer` / `close-timer` back in.
 * State { module, held, pending, leaving }: the open panel; whether a click or Enter holds it open (leaving then closes
 * nothing); the tab hovered and waiting for its timer; whether the pointer left and the close timer is running.
 *   enter {module}      the pointer is on a rail tab: opens it at once when another is open, else waits (`pending`)
 *   enter-panel         the pointer is in the open panel: the grace is cancelled
 *   leave               the pointer left the tab and the panel: a wait is dropped, an unheld panel starts its grace
 *   open-timer {module} the wait ran out: opens that tab if it is still the one waiting
 *   close-timer         the grace ran out: closes an unheld panel
 *   click {module}      opens and holds; on the open one: holds it, and on a held one closes it
 *   tab {module}        a tab inside the open panel switches it
 *   escape / outside / drop / gone   closes it
 * Anything else, and any junk, changes nothing (a junk state reads as idle).
 */
function railAfter(state, ev) {
  const s = isObject(state) && typeof state.module === 'string' && state.module !== ''
    ? { module: state.module, held: state.held === true, pending: null, leaving: state.held !== true && state.leaving === true }
    : { module: null, held: false, pending: isObject(state) && typeof state.pending === 'string' && state.pending !== '' ? state.pending : null, leaving: false };
  const e = isObject(ev) ? ev : {};
  const mod = typeof e.module === 'string' && e.module !== '' ? e.module : null;
  switch (e.type) {
    case 'enter':
      if (mod === null) return s;
      return s.module !== null ? { ...s, module: mod, pending: null, leaving: false } : { ...s, pending: mod };
    case 'enter-panel': return { ...s, leaving: false };
    case 'leave':
      if (s.module === null) return { ...s, pending: null };
      return s.held ? s : { ...s, leaving: true };
    case 'open-timer': return s.module === null && mod !== null && s.pending === mod ? { ...RAIL_IDLE, module: mod } : s;
    case 'close-timer': return s.module !== null && s.leaving && !s.held ? RAIL_IDLE : s;
    case 'click':
      if (mod === null) return s;
      if (s.module === mod && s.held) return RAIL_IDLE;
      return { module: mod, held: true, pending: null, leaving: false };
    case 'tab': return s.module !== null && mod !== null ? { ...s, module: mod, leaving: false } : s;
    case 'escape': case 'outside': case 'drop': case 'gone': return RAIL_IDLE;
    default: return s;
  }
}

/**
 * Where the keyboard goes after a rail's button was pressed (PR #159 Miguel I1). A mouse press leaves the focus on the button, so
 * the popover that opens takes it ('popover'); when it closes, a press hands it back to the terminal ('terminal'), and Enter on
 * the button keeps it on the button ('rail'), where the person is.
 */
function peekFocus(opened, byKeyboard) {
  if (opened === true) return 'popover';
  return byKeyboard === true ? 'rail' : 'terminal';
}

/**
 * The sizes of a split with the divider before kid `i` moved by `delta`: that
 * kid and the one before it trade pixels, neither goes under its minimum.
 * Null when anything is junk, and when a neighbour is ALREADY under its minimum
 * (a split too small for its kids' minimums): that divider can't be dragged, because
 * storing the drawn sizes would raise the squeezed kid and jump the divider.
 */
function dragSizes(px, min, i, delta) {
  if (!Array.isArray(px) || !Array.isArray(min) || px.length !== min.length || px.length < 2) return null;
  if (!px.every(isNumber) || !min.every(isNumber)) return null;
  if (!Number.isInteger(i) || i < 1 || i >= px.length || !isNumber(delta)) return null;
  if (px[i - 1] < min[i - 1] || px[i] < min[i]) return null;
  const give = Math.max(0, px[i - 1] - min[i - 1]);
  const take = Math.max(0, px[i] - min[i]);
  const d = Math.round(Math.min(take, Math.max(-give, delta)));
  const out = [...px];
  out[i - 1] += d;
  out[i] -= d;
  return out;
}

/**
 * What to hand `setSplitSizes` when a divider is released. In a spine split the
 * stored sizes are the user's pixels, and only the two neighbours of the divider
 * changed; every other fixed kid keeps what was stored (not what a narrow window
 * squeezed it to, and never a folded kid's rail width). In any other split the
 * sizes are proportions, so the whole drawn row is stored.
 * @param node  the split, from the layout
 * @param split `fit`'s { px, min } for it
 */
function sizesAfterDrag(node, split, i, delta) {
  if (!isObject(node) || node.type !== 'split' || !isObject(split)) return null;
  // A kid drawn as a rail (collapsed in this window, or folded by a narrow one) is not the user's size to store: its
  // 28 or 30 px is the rail's, and writing it would shrink the group in every other window (PR #159 Dexter 1).
  const state = Array.isArray(split.state) && split.state.length === node.kids.length ? split.state : null;
  const open = k => state === null || state[k] === 'open';
  if (!Number.isInteger(i) || i < 1 || i >= node.kids.length) return null;
  if (!open(i - 1) || !open(i)) return railNeighbourSizes(node, split, i, delta, open);
  const dragged = dragSizes(split.px, split.min, i, delta);
  if (!dragged) return null;
  // Nothing moved (no delta, or a neighbour at its minimum): not a choice, so nothing to store.
  if (dragged.every((v, k) => v === split.px[k])) return null;
  if (!hasTerm(node)) {
    if (state === null || state.every(s => s === 'open')) return dragged;
    // Proportions with a rail in the row: the rail keeps its stored share, written in the drawn pixels' units.
    const tOpen = node.kids.reduce((a, _, k) => a + (open(k) ? node.sizes[k] : 0), 0);
    const sOpen = split.px.reduce((a, v, k) => a + (open(k) ? v : 0), 0);
    return dragged.map((v, k) => (open(k) ? v : node.sizes[k] * sOpen / tOpen));
  }
  return dragged.map((v, k) => {
    if (k === i - 1 || k === i || hasTerm(node.kids[k])) return v;
    return isSize(node.sizes[k]) ? node.sizes[k] : v;
  });
}

const DIVIDER_STEP = 16;                       // px one arrow key moves a divider
/** How long boxes take to settle into their new places after a drop (D4); a drag itself never animates. */
const SETTLE_MS = 120;

/** The pixels a key moves a divider: the arrow that points along it (left/right for a row's, up/down for a column's), else null. */
function dividerStep(key, dir) {
  if (dir === 'row') return key === 'ArrowLeft' ? -DIVIDER_STEP : key === 'ArrowRight' ? DIVIDER_STEP : null;
  if (dir === 'col') return key === 'ArrowUp' ? -DIVIDER_STEP : key === 'ArrowDown' ? DIVIDER_STEP : null;
  return null;
}

/**
 * The layout after a key moves the divider before kid `i` of the split at `path`, by the same rules as dragging it
 * (neither neighbour under its minimum, the terminal's side still flexing), or null when nothing moves: not an arrow
 * along it, no such split or divider, a neighbour already at its minimum.
 * The page itself saves a burst of keys through dividerKeySizes + rebaseDrag; this whole-layout form is the tested reference
 * for what one press means (the tests call it), kept exported for them.
 * @param splits `fit`'s per-split { path, px, min }
 */
function dividerKey(layout, splits, path, i, key) {
  const moved = dividerKeySizes(layout, splits, path, i, key);
  if (!moved) return null;
  const next = treeApi.setSplitSizes(layout, path, moved.sizes);
  return next === layout ? null : next;
}

/**
 * What `dividerKey` asks the model for, before it asks: { node, sizes } -- the split as it was and the sizes a drag of that
 * divider would answer -- or null. A burst of key presses is saved from these through `rebaseDrag`, exactly as a pointer
 * release is, so it lands on the placement as it is by then and never overwrites a change made meanwhile.
 */
function dividerKeySizes(layout, splits, path, i, key) {
  if (!isObject(layout) || !isObject(layout.root) || !Array.isArray(path) || !Array.isArray(splits)) return null;
  let node = layout.root;
  for (const k of path) {
    if (!isObject(node) || node.type !== 'split' || !Number.isInteger(k) || k < 0 || k >= node.kids.length) return null;
    node = node.kids[k];
  }
  if (!isObject(node) || node.type !== 'split') return null;
  const delta = dividerStep(key, node.dir);
  if (delta === null) return null;
  const split = splits.find(s => isObject(s) && Array.isArray(s.path) && s.path.length === path.length && s.path.every((v, k) => v === path[k]));
  const sizes = sizesAfterDrag(node, split, i, delta);
  if (!sizes) return null;
  return treeApi.setSplitSizes(layout, path, sizes) === layout ? null : { node, sizes };
}

/** Milliseconds boxes take to settle after a drop: none when the person asked for reduced motion (or it isn't known they didn't). */
function settleMs(reducedMotion) { return reducedMotion === false ? SETTLE_MS : 0; }

/**
 * The divider beside a rail: the rail keeps what is stored, and the open kid on its other side trades with the room across
 * the rail (the terminal's side), against its own minimum. Only in a row or column that holds the terminal; null elsewhere
 * (a plain split has no room to trade with), and when nothing moves.
 */
function railNeighbourSizes(node, split, i, delta, open) {
  const o = open(i) ? i : (open(i - 1) ? i - 1 : -1);
  if (o < 0 || !hasTerm(node) || hasTerm(node.kids[o]) || !isNumber(delta)) return null;
  const s = node.kids.findIndex(hasTerm);
  if (split.px[o] < split.min[o]) return null;
  const grow = o === i ? -delta : delta;                 // right/down shrinks the kid after the divider, grows the one before
  const d = Math.round(Math.min(Math.max(0, split.px[s] - split.min[s]), Math.max(split.min[o] - split.px[o], grow)));
  if (d === 0) return null;
  return node.kids.map((k, j) => (j === o ? split.px[o] + d : (hasTerm(k) ? split.px[j] : node.sizes[j])));
}

/**
 * A divider is released on the placement as it is NOW, not as it was at pointerdown
 * (another window may have hidden a panel or resized another split meanwhile, and
 * writing the old snapshot back would undo that). Returns the sizes to give
 * `setSplitSizes` for the split at the drag's path in `layout`, or null when that
 * split isn't the one that was dragged any more (gone, another direction, another
 * number of kids): then the drag is dropped and nothing changes.
 * @param layout the placement at release
 * @param drag   { path, i, node, sizes }: what pointerdown remembered and what `sizesAfterDrag` answered last
 */
function rebaseDrag(layout, drag) {
  if (!isObject(layout) || !isObject(layout.root) || !isObject(drag) || !Array.isArray(drag.path)) return null;
  if (!isObject(drag.node) || !Array.isArray(drag.sizes) || !drag.sizes.every(isSize) || !Number.isInteger(drag.i)) return null;
  let cur = layout.root;
  for (const k of drag.path) {
    if (!isObject(cur) || cur.type !== 'split' || !Number.isInteger(k) || k < 0 || k >= cur.kids.length) return null;
    cur = cur.kids[k];
  }
  if (!isObject(cur) || cur.type !== 'split' || cur.dir !== drag.node.dir || cur.kids.length !== drag.node.kids.length) return null;
  if (cur.kids.length !== drag.sizes.length || hasTerm(cur) !== hasTerm(drag.node)) return null;
  if (!hasTerm(cur)) return [...drag.sizes];                       // proportions: the whole drawn row
  // Pixels: only the divider's two neighbours are the drag's; every other fixed kid keeps what is stored NOW.
  return drag.sizes.map((v, k) => (k === drag.i - 1 || k === drag.i || hasTerm(cur.kids[k]) || !isSize(cur.sizes[k]) ? v : cur.sizes[k]));
}

/**
 * A float's move or resize, applied to the placement as it is NOW (the float counterpart of `rebaseDrag`).
 * `drag` is { kind: 'move' | 'resize', id, tabs, last, viewport }: the float's id and the tabs it held at the
 * press, where the pointer last asked it to go ({ x, y } or { w, h }) and the dock's size at the press.
 * Returns
 *   null              the drag is dropped: the float is gone, or the id now names a float holding other tabs
 *                     (another window docked it and floated something else, and the name was handed out again,
 *                     PR #102 Dexter 6), or the request is junk;
 *   `layout` itself   the drag changed nothing visible (PR #102 Dexter 2): a press that moves nothing stores
 *                     nothing, so a float DRAWN clamped or shrunk is not rewritten with its clamp, and a wider
 *                     window still gives the stored rectangle back;
 *   a new layout      otherwise. A move stores the new position and keeps the stored size; a resize stores the
 *                     drawn position and the new size (the model's rule, app/dock-tree.js).
 */
function floatDragResult(layout, drag) {
  if (!isObject(layout) || !Array.isArray(layout.floats) || !isObject(drag) || (drag.kind !== 'move' && drag.kind !== 'resize')) return null;
  const cur = layout.floats.find(f => f.id === drag.id);
  if (!cur || !Array.isArray(drag.tabs) || cur.tabs.length !== drag.tabs.length || !cur.tabs.every((t, i) => t === drag.tabs[i])) return null;
  const next = drag.kind === 'move'
    ? treeApi.moveFloat(layout, drag.id, drag.last, drag.viewport)
    : treeApi.resizeFloat(layout, drag.id, drag.last, drag.viewport);
  if (next === layout) return layout;
  // Judged on what is DRAWN: if the float looks the same after as before, nothing was chosen.
  const drawn = l => (fit(l, null, drag.viewport).boxes.find(b => b.kind === 'float' && b.id === drag.id) || {}).rect;
  const a = drawn(layout);
  const b = drawn(next);
  return a && b && ['x', 'y', 'width', 'height'].every(k => a[k] === b[k]) ? layout : next;
}

/**
 * What `harness.layoutTree.set` answered: main echoes the layout back once it is written, and answers null
 * when it refused it (not a plain object, over the size cap) or the write failed. Anything but an object
 * means this window shows a layout that was not saved.
 */
function layoutSaved(answer) { return isObject(answer); }

/**
 * The Window menu's panel rows: every module of the layout in registry order,
 * hidden ones too. It lists hidden modules on purpose: it is the way back for
 * one, and the way out when every module is hidden and there is no tab left.
 * A floating module is listed and shown like a docked one (PR #102 Dexter 1): the
 * menu is how a float is hidden, and how it comes back (to its own rectangle).
 */
function menuRows(layout, tabs) {
  const railed = Array.isArray(layout.rail) ? layout.rail : [];
  const placed = new Set([...treeApi.allGroups(layout).flatMap(g => g.tabs), ...layout.hidden, ...railed]);
  return tabs.filter(t => placed.has(t.id)).map(t => ({ id: t.id, label: t.label, shown: !layout.hidden.includes(t.id), railed: railed.includes(t.id) }));
}

/**
 * The stores' answers to `layout-tree:get` and `layout:get` -> what the page
 * does. Only a MISSING tree file means "first launch: migrate and save"; an
 * unreadable or corrupt one (antivirus holding it, EBUSY) must never be
 * overwritten by a migration (L1's PR #82 Dexter F3): the page keeps the default
 * it drew and saves nothing until the user changes something.
 *   'use'            the tree is stored and readable
 *   'migrate-v1'     no tree yet, an L1 layout is stored
 *   'migrate-legacy' neither: read the pre-L1 per-window settings
 *   'keep'           anything unreadable on either side
 * `v1Bridge` is false when this window has no L1 store to ask at all: that is "nothing to migrate
 * from" (the legacy path), not a read that failed.
 */
function afterTreeGet(treeAnswer, v1Answer, { v1Bridge = true } = {}) {
  if (!isObject(treeAnswer)) return 'keep';
  if (treeAnswer.status === 'ok') return isObject(treeAnswer.layout) ? 'use' : 'keep';
  if (treeAnswer.status !== 'missing') return 'keep';
  if (!v1Bridge) return 'migrate-legacy';
  if (!isObject(v1Answer)) return 'keep';
  if (v1Answer.status === 'ok') return isObject(v1Answer.layout) ? 'migrate-v1' : 'keep';
  return v1Answer.status === 'missing' ? 'migrate-legacy' : 'keep';
}

// --- the DOM half ---------------------------------------------------------------

function setRect(el, r) {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

/**
 * Keep one element per key under `dock`: made once, moved on every render,
 * removed when its key is gone. A gutter being dragged keeps its element (and
 * the pointer capture app/renderer.js took on it) because its key doesn't change. Returns the element of
 * each item and the stale ones; the plan's own boxes are never written to.
 */
function syncPool(dock, selector, items, keyOf, make, before) {
  const have = new Map();
  for (const el of dock.querySelectorAll(selector)) have.set(el.dataset.key, el);
  const live = new Set();
  const elOf = new Map();
  for (const item of items) {
    const key = keyOf(item);
    live.add(key);
    let el = have.get(key);
    if (!el) {
      el = make(item);
      el.dataset.key = key;
      dock.insertBefore(el, before);
    }
    elOf.set(item, el);
  }
  const stale = [];
  for (const [key, el] of have) if (!live.has(key)) stale.push(el);
  return { elOf, stale };
}

function applyTabs(doc, nav, tabs) {
  // Rebuilt only when its MODULES change; a selection change just moves the `on`
  // class, so the clicked button (and its focus) survives (L1, PR #82 Miguel S4).
  const sig = JSON.stringify(tabs.map(t => [t.id, t.label, t.title]));
  if (nav.dataset.sig !== sig) {
    nav.dataset.sig = sig;
    nav.textContent = '';
    for (const t of tabs) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.dataset.module = t.id;
      b.title = t.title;
      b.textContent = t.label;
      nav.appendChild(b);
    }
  }
  const on = new Set(tabs.filter(t => t.on).map(t => t.id));
  for (const b of nav.querySelectorAll('button[data-module]')) {
    b.classList.toggle('on', on.has(b.dataset.module));
    b.setAttribute('aria-pressed', on.has(b.dataset.module) ? 'true' : 'false');     // the colour/underline alone says nothing to a screen reader
  }
}

// The module whose tab or rail button is `el` (what holds keyboard focus), or null.
function moduleOfButton(el) {
  const holder = el && el.parentNode;
  if (!holder || typeof el.dataset.module !== 'string') return null;
  return holder.classList.contains('zone-tabs') || holder.classList.contains('drail') ? el.dataset.module : null;
}

/**
 * Copy a plan onto the page. `doc` holds `#dock` (with `#termwrap`, `#dock-floats`
 * and `#dock-overlay` in it), the `.panel[data-panel=…]` blocks and the
 * `#panel-store` that keeps panels no group is showing.
 */
function applyBoxes(plan, doc) {
  const held = doc.activeElement;
  const heldModule = moduleOfButton(held);
  const dock = doc.getElementById('dock');
  const store = doc.getElementById('panel-store');
  const overlay = doc.getElementById('dock-overlay');
  const rootStyle = doc.documentElement.style;
  const termwrap = doc.getElementById('termwrap');
  const term = plan.boxes.find(b => b.kind === 'term');
  if (term && termwrap) setRect(termwrap, term.rect);

  const mk = (tag, cls) => { const el = doc.createElement(tag); el.className = cls; return el; };
  // A float is a group element with a float class (D2): the same tabs, panel holder and reuse by id. Floats live in
  // their own layer (#dock-floats: above the groups, rails and gutters, below the drag overlay, in its own stacking
  // context), so what covers what never depends on how many of them there are (PR #102 Miguel Y3).
  const layer = doc.getElementById('dock-floats');
  const makeGroup = (b) => {
    const el = mk('aside', 'zone dgroup');
    el.dataset.group = b.id;
    el.append(mk('nav', 'zone-tabs'), mk('div', 'zone-panels'));
    return el;
  };
  const treeBoxes = plan.boxes.filter(b => b.kind === 'group');
  const floatBoxes = plan.boxes.filter(b => b.kind === 'float');
  const groupBoxes = [...treeBoxes, ...floatBoxes];
  const treePool = syncPool(dock, ':scope > .dgroup', treeBoxes, b => b.id, makeGroup, overlay);
  const floatPool = syncPool(layer, ':scope > .dgroup', floatBoxes, b => b.id, makeGroup, null);
  const elOfBox = b => treePool.elOf.get(b) || floatPool.elOf.get(b);
  const gutters = plan.boxes.filter(b => b.kind === 'gutter');
  // A divider can be reached and moved with the arrow keys (D4): a separator, in the tab order.
  const makeGutter = () => {
    const el = mk('div', 'dgutter');
    el.setAttribute('role', 'separator');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'Resize panels: the arrow keys move this divider');
    return el;
  };
  const gutterPool = syncPool(dock, ':scope > .dgutter', gutters, b => `${b.path.join('.')}/${b.i}`, makeGutter, overlay);
  const rails = plan.boxes.filter(b => b.kind === 'rail');
  const railPool = syncPool(dock, ':scope > .drail', rails, b => b.modules.join(','), () => mk('div', 'drail'), overlay);

  let floatsDrawn = 0;
  for (const b of groupBoxes) {
    const el = elOfBox(b);
    el.dataset.shape = b.shape;
    setRect(el, b.rect);
    // Floats come in stacking order, so the draw order IS the order: its rank inside the layer (0 = lowest). The
    // elements are never re-appended to raise one: a re-append resets the panel's scroll and drops focus from a
    // field inside it. A tree group has no z-index.
    const isFloat = b.kind === 'float';
    el.classList.toggle('dfloat', isFloat);
    el.style.zIndex = isFloat ? String(floatsDrawn++) : '';
    const grip = el.querySelector('.dfloat-grip');
    if (isFloat && !grip) {
      // Pointer-only (a float's size by keyboard is not built; the tab's Move re-docks it from the keyboard): so it is no control for assistive tech.
      const g = mk('div', 'dfloat-grip');
      g.setAttribute('aria-hidden', 'true');
      el.appendChild(g);
    } else if (!isFloat && grip) grip.remove();
    applyTabs(doc, el.querySelector('.zone-tabs'), b.tabs);
    const holder = el.querySelector('.zone-panels');
    if (b.panel !== null) {
      const p = doc.querySelector(`.panel[data-panel="${b.panel}"]`);
      if (p && p.parentNode !== holder) holder.appendChild(p);
    }
  }
  for (const b of gutters) {
    const el = gutterPool.elOf.get(b);
    el.dataset.path = b.path.join('.');
    el.dataset.i = String(b.i);
    el.dataset.dir = b.dir;
    el.setAttribute('aria-orientation', b.dir === 'row' ? 'vertical' : 'horizontal');     // a row's divider is a vertical bar
    // A window splitter says where it stands: the pane before it, its least, and the most the two panes can give it.
    const sp = plan.splits.find(s => s.path.join('.') === b.path.join('.'));
    if (sp && isNumber(sp.px[b.i - 1]) && isNumber(sp.px[b.i]) && isNumber(sp.min[b.i - 1]) && isNumber(sp.min[b.i])) {
      el.setAttribute('aria-valuenow', String(sp.px[b.i - 1]));
      el.setAttribute('aria-valuemin', String(sp.min[b.i - 1]));
      el.setAttribute('aria-valuemax', String(sp.px[b.i - 1] + sp.px[b.i] - sp.min[b.i]));
    }
    setRect(el, b.rect);
  }
  for (const b of rails) {
    const el = railPool.elOf.get(b);
    el.dataset.dir = b.dir;
    setRect(el, b.rect);
    const sig = b.modules.join(',');
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.textContent = '';
      for (const t of b.tabs) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.dataset.module = t.id;
        btn.title = t.title;
        btn.textContent = t.label;
        btn.setAttribute('aria-haspopup', 'true');
        el.appendChild(btn);
      }
    }
    // Which button has its panel open over the terminal moves without rebuilding the buttons (focus stays on the one pressed).
    for (const btn of el.children) btn.setAttribute('aria-expanded', plan.peek && plan.peek.module === btn.dataset.module ? 'true' : 'false');
  }

  // A rail's panel opened over the terminal (D4): one element in the floats' layer, last, so it is above them. It is a
  // .zone like a group so every panel's own styles apply, and not a .dgroup, so no pool mistakes it for one.
  let popover = layer.querySelector(':scope > .dpeek');
  if (plan.peek) {
    if (!popover) {
      popover = mk('aside', 'zone dpeek');
      popover.append(mk('nav', 'zone-tabs'), mk('div', 'zone-panels'));
      layer.appendChild(popover);
    }
    popover.dataset.module = plan.peek.module;
    popover.setAttribute('role', 'group');
    popover.setAttribute('aria-label', `${(plan.peek.tabs.find(t => t.on) || { label: plan.peek.module }).label} panel, opened from its rail`);
    popover.dataset.shape = plan.peek.shape;
    popover.dataset.dir = plan.peek.dir;
    setRect(popover, plan.peek.rect);
    applyTabs(doc, popover.querySelector('.zone-tabs'), plan.peek.tabs);
    const holder = popover.querySelector('.zone-panels');
    const p = doc.querySelector(`.panel[data-panel="${plan.peek.module}"]`);
    if (p && p.parentNode !== holder) holder.appendChild(p);
  }

  // Panels no group is showing wait in the store; that includes every panel of a group about to be removed.
  const showing = new Set(plan.shown);
  for (const p of doc.querySelectorAll('.panel[data-panel]')) {
    const on = showing.has(p.dataset.panel);
    p.classList.toggle('on', on);
    if (!on && store && p.parentNode !== store) store.appendChild(p);
  }
  const stale = [...treePool.stale, ...floatPool.stale, ...gutterPool.stale, ...railPool.stale];
  if (popover && !plan.peek) stale.push(popover);
  for (const el of stale) el.remove();
  // A redraw that replaced the element holding focus (a group folding to a rail or back, a tab bar rebuilt)
  // would drop it on the page; it goes to the same module's button when there is one. Anything else that
  // moves focus (the vault opening, the terminal after a click) is the page's own rule and runs after this.
  if (heldModule !== null && held.isConnected === false) {
    const next = [...dock.querySelectorAll(`button[data-module="${heldModule}"]`)]
      .find(b => b.parentNode.classList.contains('zone-tabs') || b.parentNode.classList.contains('drail'));
    if (next) next.focus();
  }
  if (plan.face !== null) rootStyle.setProperty('--face', `${plan.face}px`);
}

const API = { treePlan, peekAfter, railAfter, RAIL_IDLE, peekFocus, dividerStep, dividerKey, dividerKeySizes, settleMs, SETTLE_MS, dragSizes, sizesAfterDrag, rebaseDrag, floatDragResult, layoutSaved, menuRows, afterTreeGet, applyBoxes, shapeOf, faceForWide, WIDE_FACE_CHROME };

// One namespace on the page (`window.dockTreeView`).
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockTreeView = API;

})(typeof window !== 'undefined' ? window : globalThis);
