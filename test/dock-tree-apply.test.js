'use strict';
/**
 * The DOM half of app/dock-tree-display.js (applyBoxes, syncPool, applyTabs), against a small fake document
 * (PR #100 Miguel I3). verify/probe-dock-tree.js measures the same paths in a real window, but it isn't in
 * `npm test` or Stryker's command, so every mutant in these functions would survive without this file.
 *
 * The fake is the least that works: elements with a parent, children, dataset, style, classes and attributes, and
 * a selector matcher for exactly the forms applyBoxes uses (`:scope > .x`, `tag[data-k]`, `.c[data-k="v"]`).
 */
const test = require('node:test');
const assert = require('node:assert');

const V = require('../app/dock-tree-display');
const T = require('../app/dock-tree');
const { TABS } = require('../app/side-tabs');

const IDS = TABS.map(t => t.id);
const NO_SEL = { active: {}, foldAll: false };

// --- the fake document --------------------------------------------------------------

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.classes = new Set();
    this.id = '';
    this.moves = 0;                       // how many times it was put under a parent
    this.title = '';
    this.type = '';
    this._text = '';
  }

  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const set = this.classes;
    return {
      toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
      add: (c) => { set.add(c); },
      remove: (c) => { set.delete(c); },
      contains: c => set.has(c),
    };
  }
  get textContent() { return this._text; }
  set textContent(v) {
    for (const k of this.children) k.parentNode = null;
    this.children = [];
    this._text = String(v);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }

  _adopt(el, at) {
    if (el.parentNode) el.parentNode.children.splice(el.parentNode.children.indexOf(el), 1);
    el.parentNode = this;
    el.moves += 1;
    this.children.splice(at === undefined ? this.children.length : at, 0, el);
  }
  appendChild(el) { this._adopt(el); return el; }
  append(...els) { for (const e of els) this._adopt(e); }
  insertBefore(el, before) {
    if (!before) { this._adopt(el); return el; }
    if (el.parentNode) el.parentNode.children.splice(el.parentNode.children.indexOf(el), 1);
    el.parentNode = null;
    this._adopt(el, this.children.indexOf(before));
    return el;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }

  *descendants() { for (const k of this.children) { yield k; yield* k.descendants(); } }
  querySelectorAll(sel) {
    const direct = sel.startsWith(':scope > ');
    const m = matcher(direct ? sel.slice(':scope > '.length) : sel);
    return [...(direct ? this.children : this.descendants())].filter(m);
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

// `tag?(.class)*([data-k] | [data-k="v"])*`
function matcher(sel) {
  const tag = (/^[a-z]+/.exec(sel) || [''])[0];
  const classes = [...sel.matchAll(/\.([\w-]+)/g)].map(x => x[1]);
  const attrs = [...sel.matchAll(/\[data-([\w-]+)(?:="([^"]*)")?\]/g)].map(x => [x[1], x[2]]);
  return (el) => (!tag || el.tagName === tag.toUpperCase())
    && classes.every(c => el.classes.has(c))
    && attrs.every(([k, v]) => (v === undefined ? k in el.dataset : el.dataset[k] === v));
}

// #dock holds #termwrap and #dock-overlay; a .panel for every module waits in #panel-store.
function makeDoc() {
  const html = new El('html');
  html.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  const body = new El('body');
  html.appendChild(body);
  const mk = (tag, id) => { const e = new El(tag); e.id = id; body.appendChild(e); return e; };
  const dock = mk('div', 'dock');
  const store = mk('div', 'panel-store');
  const termwrap = new El('div'); termwrap.id = 'termwrap'; dock.appendChild(termwrap);
  const overlay = new El('div'); overlay.id = 'dock-overlay'; dock.appendChild(overlay);
  const panels = {};
  for (const id of IDS) {
    const p = new El('section');
    p.classes.add('panel');
    p.dataset.panel = id;
    store.appendChild(p);
    panels[id] = p;
  }
  for (const e of [dock, store, termwrap, overlay, ...Object.values(panels)]) e.moves = 0;
  const byId = new Map([...html.descendants()].filter(e => e.id).map(e => [e.id, e]));
  const doc = {
    documentElement: html,
    getElementById: id => byId.get(id) || null,
    createElement: tag => new El(tag),
    querySelector: sel => html.querySelector(sel),
    querySelectorAll: sel => html.querySelectorAll(sel),
  };
  return { doc, dock, store, termwrap, overlay, panels, root: html };
}

const plan = (layout, sel = NO_SEL, vp = { width: 1000, height: 600 }) => V.treePlan(layout, sel, TABS, vp, { faceSize: () => 77 });
const groupEls = dock => dock.children.filter(e => e.classes.has('dgroup'));
const groupEl = (dock, id) => groupEls(dock).find(e => e.dataset.group === id);
const tabButtons = el => el.querySelector('.zone-tabs').children;

// --- tests ---------------------------------------------------------------------------

test('a group element is made once per id and reused on every render', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  const first = groupEl(w.dock, 'right');
  assert.ok(first, 'the group got an element under #dock');
  assert.strictEqual(first.dataset.group, 'right');
  assert.strictEqual(first.dataset.key, 'right');
  assert.ok(first.classes.has('zone') && first.classes.has('dgroup'));
  V.applyBoxes(plan(l), w.doc);
  V.applyBoxes(plan(l, { active: { right: 'vault' }, foldAll: false }), w.doc);
  assert.strictEqual(groupEls(w.dock).length, 1);
  assert.strictEqual(groupEl(w.dock, 'right'), first, 'the same element, not a rebuilt one');
  assert.strictEqual(first.moves, 1, 'and it was never re-parented');
});

test('the group is placed by its rect and carries its shape; its elements sit before the overlay', () => {
  const w = makeDoc();
  V.applyBoxes(plan(T.defaultLayout(IDS)), w.doc);
  const el = groupEl(w.dock, 'right');
  assert.deepStrictEqual([el.style.left, el.style.top, el.style.width, el.style.height], ['820px', '0px', '180px', '600px']);
  assert.strictEqual(el.dataset.shape, 'tall');
  assert.strictEqual(w.dock.children[w.dock.children.length - 1], w.overlay, 'the overlay stays on top');
  assert.ok(w.dock.children.indexOf(el) < w.dock.children.indexOf(w.overlay));
});

test('#termwrap gets the terminal\'s rect and is never appended or moved anywhere', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  assert.deepStrictEqual([w.termwrap.style.left, w.termwrap.style.top, w.termwrap.style.width, w.termwrap.style.height], ['0px', '0px', '815px', '600px']);
  const moved = T.dock(l, 'vault', { cell: 'term', side: 'left' });
  V.applyBoxes(plan(moved), w.doc);
  assert.ok(w.termwrap.style.left !== '0px', 'it follows the terminal\'s cell when a panel docks on its left');
  V.applyBoxes(plan(T.hide(moved, 'vault')), w.doc);
  assert.strictEqual(w.termwrap.style.left, '0px');
  assert.strictEqual(w.termwrap.moves, 0, 'never put under a parent again');
  assert.strictEqual(w.termwrap.parentNode, w.dock);
});

test('the showing panel is moved into its group, never cloned', () => {
  const w = makeDoc();
  V.applyBoxes(plan(T.defaultLayout(IDS)), w.doc);
  const holder = groupEl(w.dock, 'right').querySelector('.zone-panels');
  assert.strictEqual(w.panels.agents.parentNode, holder);
  assert.ok(w.panels.agents.classes.has('on'));
  assert.ok(!w.panels.vault.classes.has('on'));
  assert.strictEqual(w.panels.vault.parentNode, w.store, 'a panel nobody shows waits in the store');
  V.applyBoxes(plan(T.defaultLayout(IDS), { active: { right: 'vault' }, foldAll: false }), w.doc);
  assert.strictEqual(w.panels.vault.parentNode, holder);
  assert.strictEqual(w.panels.agents.parentNode, w.store);
  assert.strictEqual(w.root.querySelectorAll('.panel[data-panel="vault"]').length, 1, 'one vault panel in the whole document');
  assert.strictEqual(w.root.querySelectorAll('.panel').length, IDS.length, 'no panel was ever duplicated');
  assert.ok(w.panels.vault.classes.has('on') && !w.panels.agents.classes.has('on'));
});

test('a panel keeps its identity when its group changes', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  const moved = T.dock(l, 'agents', { edge: 'bottom' });
  V.applyBoxes(plan(moved), w.doc);
  const home = w.panels.agents.parentNode.parentNode;
  assert.strictEqual(home.dataset.group, T.groupOf(moved, 'agents').id);
  assert.strictEqual(w.root.querySelector('.panel[data-panel="agents"]'), w.panels.agents);
});

test('a group that is gone loses its element, and only AFTER its panel is back in the store', () => {
  const w = makeDoc();
  const l = T.dock(T.defaultLayout(IDS), 'git', { edge: 'bottom' });
  V.applyBoxes(plan(l, { active: { right: 'agents' }, foldAll: false }), w.doc);
  const gone = T.groupOf(l, 'git').id;
  const el = groupEl(w.dock, gone);
  assert.ok(el && w.panels.git.parentNode === el.querySelector('.zone-panels'));
  let panelWasInStore = null;
  const remove = el.remove.bind(el);
  el.remove = () => { panelWasInStore = w.panels.git.parentNode === w.store; remove(); };
  V.applyBoxes(plan(T.hide(l, 'git')), w.doc);
  assert.strictEqual(panelWasInStore, true, 'the panel left the doomed group before the group was removed');
  assert.strictEqual(groupEl(w.dock, gone), undefined);
  assert.strictEqual(el.parentNode, null);
  assert.strictEqual(w.panels.git.parentNode, w.store);
});

test('tab buttons are rebuilt only when the tabs change: a selection change keeps the same button objects', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  const nav = groupEl(w.dock, 'right').querySelector('.zone-tabs');
  const before = [...nav.children];
  assert.deepStrictEqual(before.map(b => b.dataset.module), IDS);
  assert.deepStrictEqual(before.map(b => b.textContent), TABS.map(t => t.label));
  assert.deepStrictEqual(before.map(b => b.title), TABS.map(t => t.title));
  assert.ok(before.every(b => b.type === 'button'));
  assert.deepStrictEqual(before.filter(b => b.classes.has('on')).map(b => b.dataset.module), ['agents']);
  V.applyBoxes(plan(l, { active: { right: 'vault' }, foldAll: false }), w.doc);
  assert.deepStrictEqual([...nav.children], before, 'the very same button objects (so a focused one stays focused)');
  assert.deepStrictEqual(before.filter(b => b.classes.has('on')).map(b => b.dataset.module), ['vault']);
  // A different set of tabs is a rebuild.
  V.applyBoxes(plan(T.hide(l, 'style')), w.doc);
  assert.strictEqual(nav.children.length, IDS.length - 1);
  assert.ok(nav.children.every(b => !before.includes(b)), 'new buttons');
});

test('a tab\'s label or title changing is a rebuild too', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  const nav = groupEl(w.dock, 'right').querySelector('.zone-tabs');
  const first = nav.children[0];
  const renamed = TABS.map(t => (t.id === 'agents' ? { ...t, label: 'Crew' } : t));
  V.applyBoxes(V.treePlan(l, NO_SEL, renamed, { width: 1000, height: 600 }, { faceSize: () => 77 }), w.doc);
  assert.notStrictEqual(nav.children[0], first);
  assert.strictEqual(nav.children[0].textContent, 'Crew');
});

test('rails and dividers: made per key, reused, removed when gone; a rail\'s buttons are rebuilt only when its modules change', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  const gutters = () => w.dock.children.filter(e => e.classes.has('dgutter'));
  assert.strictEqual(gutters().length, 1);
  assert.strictEqual(gutters()[0].dataset.i, '1');
  assert.strictEqual(gutters()[0].dataset.dir, 'row');
  assert.strictEqual(gutters()[0].dataset.path, '');
  const gutter = gutters()[0];
  // Squeezed: the group folds to a rail and its divider goes.
  V.applyBoxes(plan(l, NO_SEL, { width: 440, height: 600 }), w.doc);
  const rails = () => w.dock.children.filter(e => e.classes.has('drail'));
  assert.strictEqual(rails().length, 1);
  assert.strictEqual(gutters().length, 0, 'the divider of a folded kid is gone');
  assert.strictEqual(gutter.parentNode, null);
  assert.strictEqual(groupEls(w.dock).length, 0);
  assert.ok(w.dock.children.indexOf(rails()[0]) < w.dock.children.indexOf(w.overlay));
  const rail = rails()[0];
  const buttons = [...rail.children];
  assert.deepStrictEqual(buttons.map(b => b.dataset.module), IDS);
  assert.ok(buttons.every(b => b.type === 'button'));
  assert.strictEqual(rail.dataset.dir, 'v');
  V.applyBoxes(plan(l, NO_SEL, { width: 430, height: 600 }), w.doc);
  assert.strictEqual(rails()[0], rail, 'the same rail element');
  assert.deepStrictEqual([...rail.children], buttons, 'and the same buttons: its modules did not change');
  for (const p of IDS) assert.strictEqual(w.panels[p].parentNode, w.store, 'a folded panel waits in the store');
  // Its modules change: the buttons are rebuilt.
  V.applyBoxes(plan(T.hide(l, 'style'), NO_SEL, { width: 430, height: 600 }), w.doc);
  assert.strictEqual(rails().length, 1);
  assert.ok(rails()[0].children.every(b => !buttons.includes(b)));
});

test('--face is set while Agents shows, and left alone otherwise', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  assert.strictEqual(w.root.style.props['--face'], '77px');
  V.applyBoxes(plan(l, { active: { right: 'vault' }, foldAll: false }), w.doc);
  assert.strictEqual(w.root.style.props['--face'], '77px', 'not touched while Agents is not showing');
  const hand = { ...plan(l), face: 31 };
  V.applyBoxes(hand, w.doc);
  assert.strictEqual(w.root.style.props['--face'], '31px');
});

test('applyBoxes never writes to the plan it was given', () => {
  const w = makeDoc();
  const p = plan(T.dock(T.defaultLayout(IDS), 'git', { edge: 'bottom' }));
  const before = JSON.stringify(p);
  V.applyBoxes(p, w.doc);
  assert.strictEqual(JSON.stringify(p), before);
});
