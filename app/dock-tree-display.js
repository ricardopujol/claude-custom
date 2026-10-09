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
      tabs: named(b.tabs).map(t => ({ ...t, on: t.id === b.active })),
    };
  });
  // A rail's panel opened over the terminal. It is on screen like any other panel (so the vault rule sees it come and go).
  let popover = null;
  const at = isObject(peek) ? treeApi.peekFor(boxes, peek.module, viewport) : null;
  if (at) {
    const shape = shapeOf(at.rect);
    popover = { ...at, shape, tabs: named(at.modules).map(t => ({ ...t, on: t.id === at.module })) };
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
  const dragged = dragSizes(split.px, split.min, i, delta);
  if (!dragged) return null;
  // Nothing moved (no delta, or a neighbour at its minimum): not a choice, so nothing to store.
  if (dragged.every((v, k) => v === split.px[k])) return null;
  if (!hasTerm(node)) return dragged;
  return dragged.map((v, k) => {
    if (k === i - 1 || k === i || hasTerm(node.kids[k])) return v;
    return isSize(node.sizes[k]) ? node.sizes[k] : v;
  });
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
  const placed = new Set([...treeApi.allGroups(layout).flatMap(g => g.tabs), ...layout.hidden]);
  return tabs.filter(t => placed.has(t.id)).map(t => ({ id: t.id, label: t.label, shown: !layout.hidden.includes(t.id) }));
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
  const gutterPool = syncPool(dock, ':scope > .dgutter', gutters, b => `${b.path.join('.')}/${b.i}`, () => mk('div', 'dgutter'), overlay);
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
      // Pointer-only until D4's keyboard work (move and resize without a mouse): so it is no control for assistive tech.
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
        el.appendChild(btn);
      }
    }
  }

  // Panels no group is showing wait in the store; that includes every panel of a group about to be removed.
  const showing = new Set(plan.shown);
  for (const p of doc.querySelectorAll('.panel[data-panel]')) {
    const on = showing.has(p.dataset.panel);
    p.classList.toggle('on', on);
    if (!on && store && p.parentNode !== store) store.appendChild(p);
  }
  for (const el of [...treePool.stale, ...floatPool.stale, ...gutterPool.stale, ...railPool.stale]) el.remove();
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

const API = { treePlan, peekAfter, dragSizes, sizesAfterDrag, rebaseDrag, floatDragResult, layoutSaved, menuRows, afterTreeGet, applyBoxes, shapeOf, faceForWide, WIDE_FACE_CHROME };

// One namespace on the page (`window.dockTreeView`).
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockTreeView = API;

})(typeof window !== 'undefined' ? window : globalThis);
