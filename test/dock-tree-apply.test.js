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
// Claude's panel (#71) starts hidden, so a default layout draws every module but it.
const SHOWN = IDS.filter(id => !T.HIDDEN_UNTIL_USED.includes(id));
const SHOWN_TABS = TABS.filter(t => SHOWN.includes(t.id));
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
  top() { let e = this; while (e.parentNode) e = e.parentNode; return e; }
  get isConnected() { return this.top().tagName === 'HTML'; }
  focus() { this.top().focused = this; }          // only an element that is in the document keeps focus (see activeElement)

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
  const layer = new El('div'); layer.id = 'dock-floats'; dock.appendChild(layer);          // the floats' own layer (D2, PR #102 Miguel Y3)
  const overlay = new El('div'); overlay.id = 'dock-overlay'; dock.appendChild(overlay);
  const panels = {};
  for (const id of IDS) {
    const p = new El('section');
    p.classes.add('panel');
    p.dataset.panel = id;
    store.appendChild(p);
    panels[id] = p;
  }
  for (const e of [dock, store, termwrap, layer, overlay, ...Object.values(panels)]) e.moves = 0;
  const byId = new Map([...html.descendants()].filter(e => e.id).map(e => [e.id, e]));
  const doc = {
    documentElement: html,
    // A removed element loses focus, as in a browser.
    get activeElement() { const a = html.focused; return a && a.isConnected ? a : body; },     // a browser says <body>, never null
    getElementById: id => byId.get(id) || null,
    createElement: tag => new El(tag),
    querySelector: sel => html.querySelector(sel),
    querySelectorAll: sel => html.querySelectorAll(sel),
  };
  return { doc, dock, store, termwrap, layer, overlay, panels, root: html };
}

const plan = (layout, sel = NO_SEL, vp = { width: 1000, height: 600 }) => V.treePlan(layout, sel, TABS, vp, { faceSize: () => 77 });
const groupEls = dock => dock.children.filter(e => e.classes.has('dgroup'));
const groupEl = (dock, id) => groupEls(dock).find(e => e.dataset.group === id);
const floatEl = (w, id) => w.layer.children.find(e => e.dataset.group === id);          // floats live in #dock-floats, not under #dock
const tabButtons = el => el.querySelector('.zone-tabs').children.filter(b => !b.classes.has('dpin'));      // the Pin button (#85) is no tab
const tabsOf = nav => nav.children.filter(b => !b.classes.has('dpin'));

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
  const before = tabsOf(nav);
  assert.deepStrictEqual(before.map(b => b.dataset.module), SHOWN);
  assert.deepStrictEqual(before.map(b => b.textContent), SHOWN_TABS.map(t => t.label));
  assert.deepStrictEqual(before.map(b => b.title), SHOWN_TABS.map(t => t.title));
  assert.ok(before.every(b => b.type === 'button'));
  assert.deepStrictEqual(before.filter(b => b.classes.has('on')).map(b => b.dataset.module), ['agents']);
  V.applyBoxes(plan(l, { active: { right: 'vault' }, foldAll: false }), w.doc);
  assert.deepStrictEqual(tabsOf(nav), before, 'the very same button objects (so a focused one stays focused)');
  assert.deepStrictEqual(before.filter(b => b.classes.has('on')).map(b => b.dataset.module), ['vault']);
  // A different set of tabs is a rebuild.
  V.applyBoxes(plan(T.hide(l, 'style')), w.doc);
  assert.strictEqual(tabsOf(nav).length, SHOWN.length - 1);
  assert.ok(tabsOf(nav).every(b => !before.includes(b)), 'new buttons');
});

test('a tab\'s label or title changing is a rebuild too', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  const nav = groupEl(w.dock, 'right').querySelector('.zone-tabs');
  const first = tabsOf(nav)[0];
  const renamed = TABS.map(t => (t.id === 'agents' ? { ...t, label: 'Crew' } : t));
  V.applyBoxes(V.treePlan(l, NO_SEL, renamed, { width: 1000, height: 600 }, { faceSize: () => 77 }), w.doc);
  assert.notStrictEqual(tabsOf(nav)[0], first);
  assert.strictEqual(tabsOf(nav)[0].textContent, 'Crew');
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
  assert.deepStrictEqual(buttons.map(b => b.dataset.module), SHOWN);
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

// --- PR #100 Miguel I4: tabs carry their state, and focus survives a redraw that replaces its element -----------

test('I4: the showing tab is aria-pressed, the others are not, and a selection change moves it without a rebuild', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  const nav = groupEl(w.dock, 'right').querySelector('.zone-tabs');
  const before = tabsOf(nav);
  assert.ok(before.every(b => b.tagName === 'BUTTON'), 'they stay buttons');
  assert.deepStrictEqual(before.map(b => b.getAttribute('aria-pressed')), SHOWN.map(id => (id === 'agents' ? 'true' : 'false')));
  V.applyBoxes(plan(l, { active: { right: 'vault' }, foldAll: false }), w.doc);
  assert.deepStrictEqual(tabsOf(nav), before);
  assert.deepStrictEqual(before.map(b => b.getAttribute('aria-pressed')), SHOWN.map(id => (id === 'vault' ? 'true' : 'false')));
});

const focusedModule = w => { const a = w.doc.activeElement; return a ? [a.tagName, a.dataset.module, a.parentNode.classes.has('drail') ? 'rail' : 'tab'] : null; };
const tabOf = (w, id) => w.root.querySelectorAll(`button[data-module="${id}"]`)[0];

test('I4: a group folding to a rail, and back, keeps focus on that module\'s button', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  tabOf(w, 'vault').focus();
  assert.deepStrictEqual(focusedModule(w), ['BUTTON', 'vault', 'tab']);
  V.applyBoxes(plan(l, NO_SEL, { width: 440, height: 600 }), w.doc);              // the group becomes a rail: its tab is removed
  assert.deepStrictEqual(focusedModule(w), ['BUTTON', 'vault', 'rail']);
  V.applyBoxes(plan(l), w.doc);                                                    // and back
  assert.deepStrictEqual(focusedModule(w), ['BUTTON', 'vault', 'tab']);
});

test('I4: a tab bar rebuilt around the focused tab keeps focus on the same module\'s new button', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  const old = tabOf(w, 'git');
  old.focus();
  V.applyBoxes(plan(T.hide(l, 'style')), w.doc);
  assert.notStrictEqual(tabOf(w, 'git'), old);
  assert.strictEqual(w.doc.activeElement, tabOf(w, 'git'));
});

test('I4: a selection change keeps focus on the very button that has it', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  const b = tabOf(w, 'vault');
  b.focus();
  V.applyBoxes(plan(l, { active: { right: 'vault' }, foldAll: false }), w.doc);
  assert.strictEqual(w.doc.activeElement, b);
});

// --- floats (D2) -----------------------------------------------------------------------

const floated = (ids = ['vault']) => {
  let l = T.defaultLayout(IDS);
  ids.forEach((id, i) => { l = T.dock(l, id, { float: { x: 100 + 40 * i, y: 80 + 40 * i } }); });
  return l;
};
const SEL = (floatOrder = []) => ({ active: {}, foldAll: false, floatOrder });

test('D2: a float is a group element with a float class, its rectangle, its tabs and its panel', () => {
  const w = makeDoc();
  const l = floated();
  const id = l.floats[0].id;
  V.applyBoxes(plan(l, SEL()), w.doc);
  const el = floatEl(w, id);
  assert.ok(el, 'the float got an element in the floats\' layer');
  assert.ok(!groupEl(w.dock, id), 'and none directly under #dock');
  assert.ok(el.classes.has('dfloat') && el.classes.has('dgroup') && el.classes.has('zone'));
  assert.deepStrictEqual([el.style.left, el.style.top, el.style.width, el.style.height], ['100px', '80px', '320px', '260px']);
  assert.deepStrictEqual([...tabButtons(el)].map(b => b.dataset.module), ['vault']);
  assert.strictEqual(w.panels.vault.parentNode, el.querySelector('.zone-panels'));
  assert.ok(w.panels.vault.classes.has('on'));
  assert.ok(!groupEl(w.dock, 'right').classes.has('dfloat'), 'a tree group is not a float');
  assert.ok(!groupEl(w.dock, 'right').querySelector('.dfloat-grip'));
});

test('D2: a float has one resize grip, made once and kept across renders', () => {
  const w = makeDoc();
  const l = floated();
  const id = l.floats[0].id;
  V.applyBoxes(plan(l, SEL()), w.doc);
  const grip = floatEl(w, id).querySelector('.dfloat-grip');
  assert.ok(grip);
  V.applyBoxes(plan(l, SEL()), w.doc);
  assert.strictEqual(floatEl(w, id).querySelectorAll('.dfloat-grip').length, 1);
  assert.strictEqual(floatEl(w, id).querySelector('.dfloat-grip'), grip);
});

test('PR #102 Miguel S1: the resize grip is hidden from assistive tech (it is pointer-only until D4\'s keyboard work)', () => {
  const w = makeDoc();
  const l = floated();
  V.applyBoxes(plan(l, SEL()), w.doc);
  assert.strictEqual(floatEl(w, l.floats[0].id).querySelector('.dfloat-grip').getAttribute('aria-hidden'), 'true');
});

test('PR #102 Miguel Y3: stacking is structural: floats sit in their own layer after the terminal and before the drag overlay, ranked inside it', () => {
  const w = makeDoc();
  const l = floated(['vault', 'git']);
  const [a, b] = l.floats.map(f => f.id);
  V.applyBoxes(plan(l, SEL()), w.doc);
  const order = w.dock.children.map(e => e.id || e.className);
  assert.ok(order.indexOf('termwrap') < order.indexOf('dock-floats') && order.indexOf('dock-floats') < order.indexOf('dock-overlay'), order.join());
  const z = id => Number(floatEl(w, id).style.zIndex);
  assert.ok(z(a) < z(b), 'drawn later = above');
  V.applyBoxes(plan(l, SEL([a])), w.doc);                       // raising the first puts it on top
  assert.ok(z(a) > z(b));
  assert.deepStrictEqual([z(a), z(b)].sort(), [0, 1], 'the rank inside the layer: it does not grow with every raise');
  for (let i = 0; i < 40; i++) V.applyBoxes(plan(l, SEL(i % 2 ? [a] : [b])), w.doc);
  assert.ok(z(a) <= 1 && z(b) <= 1, 'forty raises later it is still 0 or 1, never close to the overlay\'s level');
  assert.strictEqual(groupEl(w.dock, 'right').style.zIndex || '', '', 'a tree group has no z-index');
});

test('D2: raising a float moves nothing in the DOM (no element is recreated or reparented)', () => {
  const w = makeDoc();
  const l = floated(['vault', 'git']);
  const [a] = l.floats.map(f => f.id);
  V.applyBoxes(plan(l, SEL()), w.doc);
  const el = floatEl(w, a);
  const before = [el.moves, w.panels.vault.moves];
  V.applyBoxes(plan(l, SEL([a])), w.doc);
  assert.strictEqual(floatEl(w, a), el);
  assert.deepStrictEqual([el.moves, w.panels.vault.moves], before, 'a re-append would reset the panel\'s scroll and drop focus from a field inside it');
});

test('D2: a float that goes (docked, hidden, or Ctrl+B) loses its element and its panel waits in the store', () => {
  const w = makeDoc();
  const l = floated();
  const id = l.floats[0].id;
  V.applyBoxes(plan(l, SEL()), w.doc);
  V.applyBoxes(plan(l, { active: {}, foldAll: true, floatOrder: [] }), w.doc);
  assert.ok(!floatEl(w, id));
  assert.strictEqual(w.panels.vault.parentNode, w.store);
  assert.ok(!w.panels.vault.classes.has('on'));
  V.applyBoxes(plan(l, SEL()), w.doc);                          // unfolded: back
  assert.ok(floatEl(w, id));
  assert.strictEqual(w.panels.vault.parentNode, floatEl(w, id).querySelector('.zone-panels'));
});

test('D2: the same panel DOM node moves from its group into a float and back (never rebuilt)', () => {
  const w = makeDoc();
  const home = T.defaultLayout(IDS);
  V.applyBoxes(plan(home, { active: { right: 'vault' }, foldAll: false, floatOrder: [] }), w.doc);
  const node = w.panels.vault;
  const out = T.dock(home, 'vault', { float: { x: 10, y: 10 } });
  V.applyBoxes(plan(out, SEL()), w.doc);
  assert.strictEqual(w.panels.vault, node);
  assert.strictEqual(node.parentNode.parentNode.dataset.group, out.floats[0].id);
  V.applyBoxes(plan(T.dock(out, 'vault', { cell: 'right', side: 'center' }), { active: { right: 'vault' }, foldAll: false, floatOrder: [] }), w.doc);
  assert.strictEqual(node.parentNode.parentNode.dataset.group, 'right');
});

test('D2: a name that was a float and is now a tree group (and back) changes layers: the float element goes, a plain group takes its place', () => {
  const w = makeDoc();
  const l = T.dock(T.defaultLayout(IDS), 'vault', { float: true });
  const id = l.floats[0].id;
  const asGroup = T.dock(T.dock(l, 'vault', { cell: 'right', side: 'center' }), 'git', { cell: 'right', side: 'top' });
  const gid = T.groupOf(asGroup, 'git') && T.groupOf(asGroup, 'git') && T.groups(asGroup).find(g => g.tabs.includes('git')).id;
  assert.strictEqual(gid, id, 'sanity: the freed name is reused by the next new group');
  V.applyBoxes(plan(l, SEL()), w.doc);
  const el = floatEl(w, id);
  assert.ok(el.classes.has('dfloat'));
  V.applyBoxes(plan(asGroup, NO_SEL), w.doc);
  assert.ok(!floatEl(w, id), 'no float element is left in the layer');
  const g = groupEl(w.dock, id);
  assert.ok(g && !g.classes.has('dfloat') && !g.querySelector('.dfloat-grip'));
  assert.strictEqual(g.style.zIndex || '', '');
  V.applyBoxes(plan(l, SEL()), w.doc);
  assert.ok(!groupEl(w.dock, id) && floatEl(w, id));
  assert.strictEqual(w.panels.vault.parentNode, floatEl(w, id).querySelector('.zone-panels'), 'the panel node followed');
});

test('I4: focus is never invented: a module that is gone, or focus held elsewhere, is left alone', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(plan(l), w.doc);
  tabOf(w, 'vault').focus();
  V.applyBoxes(plan(T.hide(l, 'vault')), w.doc);
  assert.strictEqual(w.doc.activeElement.tagName, 'BODY', 'its button is gone and nothing takes the focus (the page\'s own rule decides)');
  const field = new El('input');
  w.root.children[0].appendChild(field);
  field.focus();
  V.applyBoxes(plan(l, NO_SEL, { width: 440, height: 600 }), w.doc);
  assert.strictEqual(w.doc.activeElement, field, 'focus held outside the tabs is not touched');
});

// --- D4: dividers you can reach, a rail's popover -----------------------------------------------------------

const planD4 = (layout, sel = NO_SEL, peek = null, vp = { width: 1000, height: 600 }) => V.treePlan(layout, sel, TABS, vp, { faceSize: () => 77, peek });
const peekEl = w => w.layer.children.find(e => e.classes.has('dpeek'));

test('D4: a divider is a focusable separator that says which way it moves', () => {
  const w = makeDoc();
  V.applyBoxes(planD4(T.defaultLayout(IDS)), w.doc);
  const g = w.dock.children.find(e => e.classes.has('dgutter'));
  assert.strictEqual(g.getAttribute('role'), 'separator');
  assert.strictEqual(g.getAttribute('tabindex'), '0');
  assert.strictEqual(g.getAttribute('aria-orientation'), 'vertical', 'a row\'s divider is a vertical bar');
  assert.ok(/arrow keys/i.test(g.getAttribute('aria-label')));
  const col = T.dock(T.defaultLayout(IDS), 'vault', { cell: 'term', side: 'bottom' });
  V.applyBoxes(planD4(col), w.doc);
  const bars = w.dock.children.filter(e => e.classes.has('dgutter'));
  assert.ok(bars.some(e => e.getAttribute('aria-orientation') === 'horizontal' && e.dataset.dir === 'col'));
});

test('D4: a divider that changes direction under the same key is relabelled, not left saying the old way', () => {
  const w = makeDoc();
  V.applyBoxes(planD4(T.dock(T.defaultLayout(IDS), 'vault', { cell: 'term', side: 'bottom' })), w.doc);
  for (const e of w.dock.children.filter(x => x.classes.has('dgutter'))) {
    assert.strictEqual(e.getAttribute('aria-orientation'), e.dataset.dir === 'row' ? 'vertical' : 'horizontal');
  }
});

test('D4: a rail\'s buttons announce a popover, and the open one says so', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(planD4(l, { collapsed: { right: ['agents'] } }), w.doc);
  const rail = w.dock.children.find(e => e.classes.has('drail'));
  assert.ok(rail.children.length > 1);
  assert.ok(rail.children.every(b => b.getAttribute('aria-haspopup') === 'true' && b.getAttribute('aria-expanded') === 'false'));
  const buttons = [...rail.children];
  V.applyBoxes(planD4(l, { collapsed: { right: ['agents'] } }, { module: 'vault' }), w.doc);
  assert.deepStrictEqual([...rail.children], buttons, 'the same buttons: only the expanded mark moved');
  assert.deepStrictEqual(rail.children.filter(b => b.getAttribute('aria-expanded') === 'true').map(b => b.dataset.module), ['vault']);
});

test('D4: a rail\'s popover is one element in the floats layer, holding the panel and its tabs', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(planD4(l, { collapsed: { right: ['agents'] } }, { module: 'vault' }), w.doc);
  const el = peekEl(w);
  assert.ok(el, 'made');
  assert.ok(el.classes.has('zone'), 'a .zone, so every panel\'s own styles apply inside it');
  assert.ok(!el.classes.has('dgroup') && !el.classes.has('dfloat'), 'neither a tree group nor a float');
  assert.strictEqual(el.dataset.module, 'vault');
  assert.strictEqual(el.getAttribute('role'), 'group');
  assert.strictEqual(el.getAttribute('aria-label'), `${TABS.find(t => t.id === 'vault').label} panel, opened from its rail`, 'named for a screen reader, by the panel it holds now');
  assert.deepStrictEqual(el.style.left, '692px');
  assert.deepStrictEqual([el.style.top, el.style.width, el.style.height], ['0px', '280px', '600px']);
  assert.strictEqual(w.panels.vault.parentNode, el.querySelector('.zone-panels'), 'the vault panel was moved in, not rebuilt');
  assert.ok(w.panels.vault.classes.has('on'));
  const tabs = el.querySelector('.zone-tabs').children;
  assert.ok(tabs.length > 1);
  assert.deepStrictEqual(tabs.filter(b => b.classes.has('on')).map(b => b.dataset.module), ['vault']);
  assert.ok(el.parentNode === w.layer && w.layer.children.indexOf(el) === w.layer.children.length - 1, 'last in the layer: above the floats');
});

test('D4: the popover is reused while open, switches panel by moving it, and takes its panel away when it closes', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  const sel = { collapsed: { right: ['agents'] } };
  V.applyBoxes(planD4(l, sel, { module: 'vault' }), w.doc);
  const el = peekEl(w);
  const moves = w.panels.vault.moves;
  V.applyBoxes(planD4(l, sel, { module: 'vault' }), w.doc);
  assert.strictEqual(peekEl(w), el);
  assert.strictEqual(w.panels.vault.moves, moves, 'an idle redraw moves nothing');
  V.applyBoxes(planD4(l, sel, { module: 'git' }), w.doc);
  assert.strictEqual(peekEl(w), el, 'switching keeps the element');
  assert.strictEqual(w.panels.git.parentNode, el.querySelector('.zone-panels'));
  assert.strictEqual(w.panels.vault.parentNode, w.store, 'the vault panel went back to the store');
  assert.ok(!w.panels.vault.classes.has('on'));
  V.applyBoxes(planD4(l, sel, null), w.doc);
  assert.strictEqual(peekEl(w), undefined, 'closed');
  assert.strictEqual(w.panels.git.parentNode, w.store);
});

test('D4: a popover whose rail went away (the window grew, the group was opened) is removed with its panel put back', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  V.applyBoxes(planD4(l, { collapsed: { right: ['agents'] } }, { module: 'vault' }), w.doc);
  assert.ok(peekEl(w));
  V.applyBoxes(planD4(l, {}, { module: 'vault' }), w.doc);
  assert.strictEqual(peekEl(w), undefined);
  assert.strictEqual(w.panels.vault.parentNode, w.store);
  assert.ok(groupEl(w.dock, 'right'));
});

test('D4: focus on a popover tab survives the popover being redrawn', () => {
  const w = makeDoc();
  const l = T.defaultLayout(IDS);
  const sel = { collapsed: { right: ['agents'] } };
  V.applyBoxes(planD4(l, sel, { module: 'vault' }), w.doc);
  const tab = peekEl(w).querySelector('.zone-tabs').children.find(b => b.dataset.module === 'git');
  tab.focus();
  V.applyBoxes(planD4(l, sel, { module: 'git' }), w.doc);
  assert.strictEqual(w.doc.activeElement, tab, 'the same button, still focused');
});

test('PR #159 Miguel I1: a divider announces its position: the size of the panel before it, its minimum, and the most it can have', () => {
  const w = makeDoc();
  V.applyBoxes(planD4(T.defaultLayout(IDS)), w.doc);
  const g = w.dock.children.find(e => e.classes.has('dgutter'));
  assert.deepStrictEqual([g.getAttribute('aria-valuenow'), g.getAttribute('aria-valuemin'), g.getAttribute('aria-valuemax')], ['815', '320', '875']);
  V.applyBoxes(planD4(T.setSplitSizes(T.defaultLayout(IDS), [], [1, 200])), w.doc);
  assert.deepStrictEqual([g.getAttribute('aria-valuenow'), g.getAttribute('aria-valuemax')], ['795', '875'], 'follows the divider after a move');
});

// --- #85: the dock's rail, the Pin and Pinned buttons -----------------------------------------

const pinOf = el => el.querySelector('.zone-tabs').children.find(b => b.classes.has('dpin'));

test('#85: the dock rail is one element keyed "dock", marked as the dock\'s, kept as tabs come and go', () => {
  const w = makeDoc();
  const l1 = T.unpin(T.defaultLayout(IDS), 'git');
  V.applyBoxes(planD4(l1), w.doc);
  const rail = w.dock.children.find(e => e.classes.has('drail'));
  assert.strictEqual(rail.dataset.rail, 'dock');
  assert.deepStrictEqual(rail.children.map(b => b.dataset.module), ['git']);
  V.applyBoxes(planD4(T.unpin(l1, 'vault')), w.doc);
  assert.strictEqual(w.dock.children.find(e => e.classes.has('drail')), rail, 'the same element');
  assert.deepStrictEqual(rail.children.map(b => b.dataset.module), ['git', 'vault']);
  V.applyBoxes(planD4(T.defaultLayout(IDS)), w.doc);
  assert.ok(!w.dock.children.some(e => e.classes.has('drail')), 'an empty rail is gone');
});

test('#85: a docked group has a Pinned button for the panel it shows, pressed, kept across tab changes', () => {
  const w = makeDoc();
  V.applyBoxes(planD4(T.defaultLayout(IDS)), w.doc);
  const pin = pinOf(groupEl(w.dock, 'right'));
  assert.strictEqual(pin.textContent, 'Pinned');
  assert.strictEqual(pin.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(pin.dataset.pin, 'agents');
  assert.ok(!('module' in pin.dataset), 'no data-module: it is not a tab');
  V.applyBoxes(planD4(T.defaultLayout(IDS), { active: { right: 'git' } }), w.doc);
  assert.strictEqual(pinOf(groupEl(w.dock, 'right')), pin, 'the same button');
  assert.strictEqual(pin.dataset.pin, 'git', 'it follows the shown tab');
  assert.strictEqual(groupEl(w.dock, 'right').querySelector('.zone-tabs').children.at(-1), pin, 'last in the bar');
});

test('#85: the Pinned button comes back after the tab bar is rebuilt around it', () => {
  const w = makeDoc();
  V.applyBoxes(planD4(T.defaultLayout(IDS)), w.doc);
  V.applyBoxes(planD4(T.unpin(T.defaultLayout(IDS), 'git')), w.doc);       // the group lost a tab: its bar is rebuilt
  const bar = groupEl(w.dock, 'right').querySelector('.zone-tabs');
  assert.strictEqual(bar.children.filter(b => b.classes.has('dpin')).length, 1);
  assert.ok(!bar.children.some(b => b.dataset.module === 'git'));
});

test('#85: a float has the button too', () => {
  const w = makeDoc();
  const l = T.dock(T.defaultLayout(IDS), 'fog', { float: true });
  V.applyBoxes(planD4(l), w.doc);
  const f = w.layer.children.find(e => e.classes.has('dfloat'));
  assert.strictEqual(pinOf(f).dataset.pin, 'fog');
});

test('#85: the popover of a dock-rail panel has a Pin button (not pressed); one from a folded group has none', () => {
  const w = makeDoc();
  const l = T.unpin(T.defaultLayout(IDS), 'git');
  V.applyBoxes(planD4(l, NO_SEL, { module: 'git' }), w.doc);
  const el = peekEl(w);
  const pin = pinOf(el);
  assert.strictEqual(pin.textContent, 'Pin');
  assert.strictEqual(pin.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(pin.dataset.pin, 'git');
  assert.strictEqual(el.dataset.from, 'right');
  V.applyBoxes(planD4(l, NO_SEL, null), w.doc);
  assert.strictEqual(peekEl(w), undefined);
  const w2 = makeDoc();
  V.applyBoxes(planD4(T.defaultLayout(IDS), { collapsed: { right: ['agents'] } }, { module: 'vault' }), w2.doc);
  assert.strictEqual(pinOf(peekEl(w2)), undefined);
});

test('#85: switching the popover to another rail tab moves the Pin button to it', () => {
  const w = makeDoc();
  const l = T.unpin(T.unpin(T.defaultLayout(IDS), 'git'), 'vault');
  V.applyBoxes(planD4(l, NO_SEL, { module: 'git' }), w.doc);
  const pin = pinOf(peekEl(w));
  V.applyBoxes(planD4(l, NO_SEL, { module: 'vault' }), w.doc);
  assert.strictEqual(pinOf(peekEl(w)), pin);
  assert.strictEqual(pin.dataset.pin, 'vault');
});
