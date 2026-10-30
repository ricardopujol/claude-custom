'use strict';
/**
 * The strip page's half of the redesign (BACKLOG #139, #141; documentation/DESIGN_TAB_STRIP.md): the Lanes ▾ button, the
 * "+N" overflow (2A), drag to reorder, and the short fade when a tab leaves. The page decides nothing about WHICH lanes have
 * a tab (main sends only those, app/tab-lanes.js placeLanes); it measures its room, shows what fits, and tells main which
 * tabs it hid. Against a minimal fake DOM, as test/tab-strip.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = require('../app/tab-strip');
const { paint } = strip;

function node(tag) {
  const n = {
    tag, className: '', textContent: '', title: '', hidden: false, type: '', dataset: {}, draggable: false, parentNode: null,
    value: '', disabled: false, onclick: null, children: [], listeners: {}, offsetWidth: 0, clientWidth: 0, id: '',
    appendChild(c) { n.children.push(c); c.parentNode = n; return c; },
    replaceChildren(...cs) { n.children = cs; for (const c of cs) c.parentNode = n; },
    addEventListener(name, fn) { n.listeners[name] = fn; },
    getBoundingClientRect() { return { left: 0, width: 100 }; },
    classList: {
      add(c) { if (!n.className.split(' ').includes(c)) n.className = `${n.className} ${c}`.trim(); },
      remove(c) { n.className = n.className.split(' ').filter(x => x !== c).join(' '); },
      contains(c) { return n.className.split(' ').includes(c); },
    },
  };
  return n;
}
function fakeDoc({ room = null, reduced = false } = {}) {
  const byId = {
    tabs: node('div'), pane: node('div'), 'pane-text': node('div'), 'pane-retry': node('button'), lanes: node('button'),
  };
  if (room !== null) {
    byId.strip = node('div');
    byId.strip.clientWidth = room;
    byId.strip.children = [byId.tabs, byId.lanes];
    byId.lanes.offsetWidth = 0;
  }
  return {
    byId, createElement: node, getElementById: (id) => byId[id],
    defaultView: { matchMedia: () => ({ matches: reduced }), getComputedStyle: () => ({ minWidth: '0px', marginLeft: '0px', marginRight: '0px' }) },
  };
}
const entry = (o) => ({
  key: 'k', label: 'feat/a', isDev: false, selected: false, started: true, closable: true,
  working: false, needsInput: false, lockGlyph: null, health: null, phase: 'live', error: null,
  starting: false, startError: null, ...o,
});
const bridgeSpy = () => {
  const calls = [];
  return {
    calls, select: (k) => calls.push(['select', k]), close: () => {}, contextMenu: () => {},
    lanes: (hidden) => calls.push(['lanes', hidden]), reorder: (k, before) => calls.push(['reorder', k, before]),
  };
};
const model = (n, selectedAt = 0) => Array.from({ length: n }, (_, i) => entry({
  key: i === 0 ? 'dev' : `lane${i}`, label: i === 0 ? 'develop' : `feat/${i}`, isDev: i === 0, selected: i === selectedAt, closable: i !== 0,
}));
const keysOf = (doc) => doc.byId.tabs.children.map(t => t.dataset.key);

// --- the Lanes button -----------------------------------------------------------------------------

test('the Lanes ▾ button is drawn in a project window and asks main for the menu with the hidden tabs', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: model(3), mode: 'tabs', lanes: { notStarted: [{ key: 'x' }, { key: 'y' }], merged: [{ key: 'z' }] } }, b);
  assert.strictEqual(doc.byId.lanes.hidden, false);
  assert.strictEqual(doc.byId.lanes.textContent, 'Lanes ▾');
  assert.match(doc.byId.lanes.title, /3 lanes/);
  doc.byId.lanes.onclick();
  assert.deepStrictEqual(b.calls, [['lanes', []]]);
});

test('a single-folder window has no Lanes button', () => {
  const doc = fakeDoc();
  paint(doc, { model: model(1), mode: 'single' }, bridgeSpy());
  assert.strictEqual(doc.byId.lanes.hidden, true);
});

test('junk for the lanes counts is "none", not NaN', () => {
  const doc = fakeDoc();
  paint(doc, { model: model(2), mode: 'tabs', lanes: { notStarted: 'x', merged: null } }, bridgeSpy());
  assert.doesNotMatch(doc.byId.lanes.title, /NaN|undefined/);
});

// --- 2A: shrink, then +N ---------------------------------------------------------------------------

test('2A: tabs that do not fit the room (112 px each) are not drawn; the button says +N and passes their keys to main', () => {
  const doc = fakeDoc({ room: 112 * 4 + 24 });       // four tabs of room, after the 24 px safety
  const b = bridgeSpy();
  paint(doc, { model: model(8), mode: 'tabs' }, b);
  assert.deepStrictEqual(keysOf(doc), ['dev', 'lane1', 'lane2', 'lane3']);
  assert.strictEqual(doc.byId.lanes.textContent, '+4 Lanes ▾');
  doc.byId.lanes.onclick();
  assert.deepStrictEqual(b.calls, [['lanes', ['lane4', 'lane5', 'lane6', 'lane7']]]);
});

test('2A: the selected tab is drawn even when it is past the room, in its place', () => {
  const doc = fakeDoc({ room: 112 * 3 + 24 });
  paint(doc, { model: model(8, 6), mode: 'tabs' }, bridgeSpy());
  assert.deepStrictEqual(keysOf(doc), ['dev', 'lane1', 'lane6']);
  assert.match(doc.byId.tabs.children[2].className, /\bselected\b/);
});

test('2A: other things in the strip take room from the tabs (a lean chip, the + button)', () => {
  const doc = fakeDoc({ room: 112 * 6 + 24 });
  const plus = node('button');
  plus.id = 'plus';
  plus.offsetWidth = 112 * 2;
  doc.byId.strip.children.push(plus);
  paint(doc, { model: model(8), mode: 'tabs' }, bridgeSpy());
  assert.strictEqual(doc.byId.tabs.children.length, 4);
});

test('2A: the alert line gives its room back (it shrinks to nothing), and a hidden sibling takes none', () => {
  const doc = fakeDoc({ room: 112 * 3 + 24 });
  const alert = node('div'); alert.id = 'strip-alert'; alert.offsetWidth = 900;
  const gone = node('div'); gone.hidden = true; gone.offsetWidth = 900;
  doc.byId.strip.children.push(alert, gone);
  paint(doc, { model: model(8), mode: 'tabs' }, bridgeSpy());
  assert.strictEqual(doc.byId.tabs.children.length, 3);
});

test('2A: no measurable room (a test page, a strip not laid out yet) draws every tab', () => {
  const doc = fakeDoc();
  paint(doc, { model: model(30), mode: 'tabs' }, bridgeSpy());
  assert.strictEqual(doc.byId.tabs.children.length, 30);
  assert.strictEqual(doc.byId.lanes.textContent, 'Lanes ▾');
  const zero = fakeDoc({ room: 0 });
  paint(zero, { model: model(5), mode: 'tabs' }, bridgeSpy());
  assert.strictEqual(zero.byId.tabs.children.length, 5, 'a width of 0 is "not laid out", not "nothing fits"');
});

// --- drag to reorder ----------------------------------------------------------------------------------

const dragEv = (over = {}) => ({
  clientX: 10, prevented: false, preventDefault() { this.prevented = true; },
  dataTransfer: { data: {}, setData(k, v) { this.data[k] = v; }, effectAllowed: '', dropEffect: '' }, ...over,
});

test('only a lane\'s own tab is draggable: not develop, not a side or shell tab', () => {
  const doc = fakeDoc();
  paint(doc, { model: [
    entry({ key: 'dev', isDev: true, selected: true }), entry({ key: 'a' }),
    entry({ key: 'a#side', side: true }), entry({ key: 'a#shell', shell: true }),
  ], mode: 'tabs' }, bridgeSpy());
  assert.deepStrictEqual(doc.byId.tabs.children.map(t => t.draggable), [false, true, false, false]);
});

test('dragging a tab onto the left half of another drops it before that one', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: model(4), mode: 'tabs' }, b);
  const [, one, , three] = doc.byId.tabs.children;
  const start = dragEv();
  three.listeners.dragstart(start);
  assert.strictEqual(start.dataTransfer.data['text/plain'], 'lane3');
  const over = dragEv({ clientX: 20 });
  one.listeners.dragover(over);
  assert.strictEqual(over.prevented, true, 'a drop is allowed here');
  assert.match(one.className, /\bdrop-before\b/);
  const drop = dragEv({ clientX: 20 });
  one.listeners.drop(drop);
  assert.deepStrictEqual(b.calls, [['reorder', 'lane3', 'lane1']]);
  assert.doesNotMatch(one.className, /drop-before/);
});

test('the right half drops after it: before the next lane, or at the end', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: model(4), mode: 'tabs' }, b);
  const [, one, , three] = doc.byId.tabs.children;
  one.listeners.dragstart(dragEv());
  three.listeners.drop(dragEv({ clientX: 80 }));
  one.listeners.dragend(dragEv());
  three.listeners.dragstart(dragEv());
  one.listeners.drop(dragEv({ clientX: 80 }));
  assert.deepStrictEqual(b.calls, [['reorder', 'lane1', null], ['reorder', 'lane3', 'lane2']]);
});

test('a drop that makes no sense is refused: on itself, on nothing dragged, or a dragover that allows nothing', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: model(3), mode: 'tabs' }, b);
  const [dev, one, two] = doc.byId.tabs.children;
  const stray = dragEv();
  one.listeners.dragover(stray);
  assert.strictEqual(stray.prevented, false, 'nothing is being dragged from this strip');
  two.listeners.drop(dragEv());
  one.listeners.dragstart(dragEv());
  const self = dragEv();
  one.listeners.dragover(self);
  assert.strictEqual(self.prevented, false, 'its own place');
  one.listeners.drop(dragEv());
  dev.listeners.dragover(dragEv());
  one.listeners.dragend(dragEv());
  assert.deepStrictEqual(b.calls, []);
});

test('dropping on develop sends develop\'s key: the shell turns that into "first of the others"', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: model(3), mode: 'tabs' }, b);
  const [dev, , two] = doc.byId.tabs.children;
  two.listeners.dragstart(dragEv());
  dev.listeners.drop(dragEv({ clientX: 90 }));
  assert.deepStrictEqual(b.calls, [['reorder', 'lane2', 'dev']]);
});

test('a repaint while a tab is being dragged waits (it would pull the dragged tab out from under the drag), then paints the newest', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: model(3), mode: 'tabs' }, b);
  const first = doc.byId.tabs.children;
  first[1].listeners.dragstart(dragEv());
  paint(doc, { model: model(4), mode: 'tabs' }, b);
  assert.strictEqual(doc.byId.tabs.children, first, 'untouched while dragging');
  first[1].listeners.dragend(dragEv());
  assert.strictEqual(doc.byId.tabs.children.length, 4, 'the held model is painted when the drag ends');
});

test('a bridge without reorder (an older preload) draws no draggable tabs and never throws', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  delete b.reorder;
  assert.doesNotThrow(() => paint(doc, { model: model(3), mode: 'tabs' }, b));
  assert.deepStrictEqual(doc.byId.tabs.children.map(t => t.draggable), [false, false, false]);
});

// --- the fade ------------------------------------------------------------------------------------------

test('a tab that leaves the strip fades out in its place for about 250 ms, then is gone', () => {
  const doc = fakeDoc();
  const timers = [];
  const restore = strip.fade.use({ schedule: (fn, ms) => timers.push([fn, ms]) });
  try {
    paint(doc, { model: model(4), mode: 'tabs' }, bridgeSpy());
    paint(doc, { model: [model(4)[0], model(4)[1], model(4)[3]], mode: 'tabs' }, bridgeSpy());
    const kids = doc.byId.tabs.children;
    assert.deepStrictEqual(kids.map(t => t.dataset.key), ['dev', 'lane1', 'lane2', 'lane3']);
    assert.match(kids[2].className, /\bleaving\b/);
    assert.strictEqual(kids[2].children.find(c => c.className === 'label').textContent, 'feat/2');
    assert.strictEqual(kids[2].listeners.click, undefined, 'a leaving tab is not clickable');
    assert.deepStrictEqual(timers.map(t => t[1]), [250]);
    paint(doc, { model: [model(4)[0], model(4)[1], model(4)[3]], mode: 'tabs' }, bridgeSpy());
    assert.match(doc.byId.tabs.children[2].className, /\bleaving\b/, 'a repaint inside the 250 ms keeps it');
    timers[0][0]();
    paint(doc, { model: [model(4)[0], model(4)[1], model(4)[3]], mode: 'tabs' }, bridgeSpy());
    assert.deepStrictEqual(keysOf(doc), ['dev', 'lane1', 'lane3']);
  } finally { restore(); }
});

test('no fade under prefers-reduced-motion, and none for a tab that only moved into the +N menu', () => {
  const timers = [];
  const restore = strip.fade.use({ schedule: (fn, ms) => timers.push([fn, ms]) });
  try {
    const calm = fakeDoc({ reduced: true });
    paint(calm, { model: model(4), mode: 'tabs' }, bridgeSpy());
    paint(calm, { model: [model(4)[0], model(4)[1]], mode: 'tabs' }, bridgeSpy());
    assert.deepStrictEqual(keysOf(calm), ['dev', 'lane1']);

    const narrow = fakeDoc({ room: 112 * 4 + 24 });
    paint(narrow, { model: model(4), mode: 'tabs' }, bridgeSpy());
    narrow.byId.strip.clientWidth = 112 * 2 + 24;
    paint(narrow, { model: model(4), mode: 'tabs' }, bridgeSpy());
    assert.deepStrictEqual(keysOf(narrow), ['dev', 'lane1']);
    assert.deepStrictEqual(timers, []);
  } finally { restore(); }
});

test('the first paint fades nothing in, and a closed-then-same-key tab does not leave a ghost behind it', () => {
  const doc = fakeDoc();
  const restore = strip.fade.use({ schedule: () => {} });
  try {
    paint(doc, { model: model(3), mode: 'tabs' }, bridgeSpy());
    assert.ok(doc.byId.tabs.children.every(t => !/leaving/.test(t.className)));
    paint(doc, { model: [model(3)[0], model(3)[1]], mode: 'tabs' }, bridgeSpy());
    paint(doc, { model: model(3), mode: 'tabs' }, bridgeSpy());
    assert.deepStrictEqual(keysOf(doc), ['dev', 'lane1', 'lane2'], 'back on the strip: one tab, not a tab and its ghost');
  } finally { restore(); }
});

// --- found by the real-window probe (the unit fakes could not see either) -----------------------------

test('a margin-left: auto on #index / #bg is free space, not a margin: it does not eat the tabs\' room', () => {
  const doc = fakeDoc({ room: 112 * 10 + 200 });
  const index = node('div'); index.id = 'index'; index.offsetWidth = 150;
  doc.byId.index = index;
  doc.byId.strip.children = [doc.byId.tabs, doc.byId.lanes, index];
  // what Chrome reports for `margin-left: auto`: the whole leftover width
  doc.defaultView.getComputedStyle = (c) => ({ minWidth: c === index ? '150px' : '0px', marginLeft: c === index ? '5000px' : '0px', marginRight: '0px' });
  paint(doc, { model: model(10), mode: 'tabs' }, bridgeSpy());
  assert.strictEqual(keysOf(doc).length, 10);
});

test('tabs that overflow their box after the first measure are cut one at a time until they fit, and develop stays', () => {
  const doc = fakeDoc({ room: 112 * 10 + 200 });
  // something beside the tabs grew after the room was measured: the box only holds three tabs
  Object.defineProperty(doc.byId.tabs, 'scrollWidth', { get: () => doc.byId.tabs.children.length * 112 });
  Object.defineProperty(doc.byId.tabs, 'clientWidth', { get: () => 112 * 3 });
  paint(doc, { model: model(10), mode: 'tabs' }, bridgeSpy());
  assert.deepStrictEqual(keysOf(doc), ['dev', 'lane1', 'lane2']);
  assert.strictEqual(doc.byId.lanes.textContent, '+7 Lanes ▾');
});

test('tab-strip.html: the index field shrinks before the tabs do (its shrink factor outweighs theirs), so the measured room is the real one', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  assert.match(html, /#index \{[^}]*flex: 0 1000 340px/);
});
