'use strict';
/**
 * Drawing a dock tree (BACKLOG #53, dockable panels D1, Task 9).
 *
 * Two halves, as app/dock-zones-display.js is. `treePlan`, `dragSizes`,
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

// Loaded the way app/dock-zones-display.js loads app/dock-layout.js.
const treeApi = typeof module !== 'undefined' && module.exports ? require('./dock-tree') : root.dockTree;
const zonesApi = typeof module !== 'undefined' && module.exports ? require('./dock-zones-display') : root.dockZones;
const { fit, hasTerm } = treeApi;
const { WIDE_FACE_CHROME } = zonesApi;

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
 * @returns { boxes, splits, shown, face } `fit`'s boxes with each group's tabs, panel and shape filled in;
 *          `shown` the panels on screen; `face` the portrait size while Agents shows, else null.
 */
function treePlan(layout, selection, tabs, viewport, { faceSize } = {}) {
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
    if (b.kind !== 'group') return b;
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
  return { boxes: drawn, splits, shown, face };
}

/**
 * The sizes of a split with the divider before kid `i` moved by `delta`: that
 * kid and the one before it trade pixels, neither goes under its minimum.
 * Null when anything is junk, so a bad drag changes nothing.
 */
function dragSizes(px, min, i, delta) {
  if (!Array.isArray(px) || !Array.isArray(min) || px.length !== min.length || px.length < 2) return null;
  if (!px.every(isNumber) || !min.every(isNumber)) return null;
  if (!Number.isInteger(i) || i < 1 || i >= px.length || !isNumber(delta)) return null;
  // A neighbour already under its minimum (a squeezed one) can't give anything, but may still take.
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
  if (!hasTerm(node)) return dragged;
  return dragged.map((v, k) => {
    if (k === i - 1 || k === i || hasTerm(node.kids[k])) return v;
    return isSize(node.sizes[k]) ? node.sizes[k] : v;
  });
}

/**
 * The Window menu's panel rows: every module of the layout in registry order,
 * hidden ones too. It lists hidden modules on purpose: it is the way back for
 * one, and the way out when every module is hidden and there is no tab left.
 */
function menuRows(layout, tabs) {
  const placed = new Set([...treeApi.groups(layout).flatMap(g => g.tabs), ...layout.hidden]);
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
 */
function afterTreeGet(treeAnswer, v1Answer) {
  if (!isObject(treeAnswer)) return 'keep';
  if (treeAnswer.status === 'ok') return isObject(treeAnswer.layout) ? 'use' : 'keep';
  if (treeAnswer.status !== 'missing') return 'keep';
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
 * its pointer capture) because its key doesn't change. Returns the element of
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
  for (const b of nav.querySelectorAll('button[data-module]')) b.classList.toggle('on', on.has(b.dataset.module));
}

/**
 * Copy a plan onto the page. `doc` holds `#dock` (with `#termwrap` and
 * `#dock-overlay` in it), the `.panel[data-panel=…]` blocks and the
 * `#panel-store` that keeps panels no group is showing.
 */
function applyBoxes(plan, doc) {
  const dock = doc.getElementById('dock');
  const store = doc.getElementById('panel-store');
  const overlay = doc.getElementById('dock-overlay');
  const rootStyle = doc.documentElement.style;
  const termwrap = doc.getElementById('termwrap');
  const term = plan.boxes.find(b => b.kind === 'term');
  if (term && termwrap) setRect(termwrap, term.rect);

  const mk = (tag, cls) => { const el = doc.createElement(tag); el.className = cls; return el; };
  const groupBoxes = plan.boxes.filter(b => b.kind === 'group');
  const groupPool = syncPool(dock, ':scope > .dgroup', groupBoxes, b => b.id, (b) => {
    const el = mk('aside', 'zone dgroup');
    el.dataset.group = b.id;
    el.append(mk('nav', 'zone-tabs'), mk('div', 'zone-panels'));
    return el;
  }, overlay);
  const gutters = plan.boxes.filter(b => b.kind === 'gutter');
  const gutterPool = syncPool(dock, ':scope > .dgutter', gutters, b => `${b.path.join('.')}/${b.i}`, () => mk('div', 'dgutter'), overlay);
  const rails = plan.boxes.filter(b => b.kind === 'rail');
  const railPool = syncPool(dock, ':scope > .drail', rails, b => b.modules.join(','), () => mk('div', 'drail'), overlay);

  for (const b of groupBoxes) {
    const el = groupPool.elOf.get(b);
    el.dataset.shape = b.shape;
    setRect(el, b.rect);
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
  for (const el of [...groupPool.stale, ...gutterPool.stale, ...railPool.stale]) el.remove();
  if (plan.face !== null) rootStyle.setProperty('--face', `${plan.face}px`);
}

const API = { treePlan, dragSizes, sizesAfterDrag, menuRows, afterTreeGet, applyBoxes, shapeOf, faceForWide, WIDE_FACE_CHROME };

// One namespace on the page (`window.dockTreeView`).
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.dockTreeView = API;

})(typeof window !== 'undefined' ? window : globalThis);
