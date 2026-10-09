'use strict';
/**
 * Kill tests for Mortimer's release-gate survivor S25 (2026-10-09): app/indexing-display.js was at 31% because its
 * test covered only the pure decisions. This drives the painters (mountStrip, paintStrip, mountOverlay, toastNode,
 * listNode) against a minimal fake DOM: the danger is a wrong figure or a wrong button on screen, so each test asserts
 * what is drawn and what a click does. (verify/probe-indexing-strip.js runs the same code in a real window.)
 */
const test = require('node:test');
const assert = require('node:assert');

const d = require('../app/indexing-display');

// ---- a fake DOM, just enough for these painters ---------------------------------------------------------------------

function node(tag) {
  const n = {
    tag, className: '', textContent: '', title: '', type: '', dataset: {}, value: '',
    style: {}, attrs: {}, children: [], listeners: {}, classes: new Set(), blurred: 0, focused: 0, selected: 0,
    rect: { height: 0 },
    appendChild(c) { n.children.push(c); return c; },
    replaceChildren(...cs) { n.children = cs; },
    setAttribute(k, v) { n.attrs[k] = v; },
    addEventListener(name, fn) { (n.listeners[name] = n.listeners[name] || []).push(fn); },
    fire(name, ev = {}) {
      const e = { preventDefault() { e.prevented = true; }, ...ev };
      for (const fn of n.listeners[name] || []) fn(e);
      return e;
    },
    focus() { n.focused++; }, blur() { n.blurred++; }, select() { n.selected++; },
    getBoundingClientRect() { return n.rect; },
    classList: {
      toggle(c, on) { if (on) n.classes.add(c); else n.classes.delete(c); },
    },
    get childElementCount() { return n.children.length; },
    get firstElementChild() { return n.children[0] || null; },
  };
  return n;
}

function fakeDoc(ids = [], { resizeObserver = false } = {}) {
  const byId = Object.fromEntries(ids.map(id => [id, node('div')]));
  const props = {};
  const observed = [];
  const doc = {
    byId, props, observed,
    createElement: node,
    getElementById: (id) => byId[id] || null,
    listeners: {},
    addEventListener(name, fn) { doc.listeners[name] = fn; },
    documentElement: { style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } } },
    defaultView: resizeObserver ? { ResizeObserver: class { constructor(fn) { this.fn = fn; } observe(el) { observed.push([this, el]); } } } : {},
  };
  return doc;
}

const flat = (n) => [n, ...n.children.flatMap(flat)];
const buttons = (n) => flat(n).filter(x => x.tag === 'button');
const byClass = (n, cls) => flat(n).filter(x => x.className.split(' ').includes(cls));

// ---- paintStrip / mountStrip ------------------------------------------------------------------------------------------

const STRIP_IDS = ['index-note', 'index-chip', 'index-count', 'index'];

test('S25 paintStrip: the chip names the project and says what a click does; the counter is the words; pending lights on unfiled notes only', () => {
  const doc = fakeDoc(STRIP_IDS);
  d.paintStrip(doc, { label: 'claude-custom', counts: { filed: 2, unfiled: 1 }, listOpen: true });
  const { 'index-chip': chip, 'index-count': count } = doc.byId;
  assert.strictEqual(chip.textContent, 'claude-custom');
  assert.strictEqual(chip.title, "Adds to claude-custom's backlog inbox. Click to switch project.");
  assert.strictEqual(count.textContent, '2 filed · 1 not filed');
  assert.strictEqual(count.attrs['aria-expanded'], 'true');
  assert.ok(count.classes.has('pending'));

  d.paintStrip(doc, { label: '', counts: { filed: 3, unfiled: 0 }, listOpen: false });
  assert.strictEqual(chip.textContent, 'this project', 'an empty label falls back');
  assert.strictEqual(count.textContent, '3 filed');
  assert.strictEqual(count.attrs['aria-expanded'], 'false');
  assert.ok(!count.classes.has('pending'));

  d.paintStrip(doc, null);
  assert.strictEqual(chip.textContent, 'this project');
  assert.strictEqual(count.textContent, '0 filed');
  assert.strictEqual(count.attrs['aria-expanded'], 'false');
  d.paintStrip(doc, { label: 7, listOpen: 'yes' });
  assert.strictEqual(chip.textContent, 'this project', 'a label that is not a string is not drawn');
  assert.strictEqual(count.attrs['aria-expanded'], 'false', 'only a real true opens');
});

function bridgeSpy(over = {}) {
  const calls = [];
  const b = {
    calls,
    indexSubmit: (v) => { calls.push(['submit', v]); return Promise.resolve({ ok: true }); },
    indexLeave: () => calls.push(['leave']),
    indexFocus: (on) => calls.push(['focus', on]),
    indexChip: () => calls.push(['chip']),
    indexList: () => calls.push(['list']),
    onIndex: (fn) => { b.state = fn; },
    onIndexFocus: (fn) => { b.focusMe = fn; },
    ...over,
  };
  return b;
}
const tick = () => new Promise(r => setImmediate(r));
const key = (k, extra = {}) => ({ key: k, ...extra });

test('S25 mountStrip: it mounts only when every element and the bridge are there', () => {
  assert.strictEqual(d.mountStrip(fakeDoc(STRIP_IDS), bridgeSpy()), true);
  for (const missing of STRIP_IDS) {
    assert.strictEqual(d.mountStrip(fakeDoc(STRIP_IDS.filter(i => i !== missing)), bridgeSpy()), false, missing);
  }
  assert.strictEqual(d.mountStrip(fakeDoc(STRIP_IDS), null), false);
  assert.strictEqual(d.mountStrip(fakeDoc(STRIP_IDS), {}), false);
  assert.strictEqual(d.mountStrip(fakeDoc(STRIP_IDS), { indexSubmit: 5 }), false);
});

test('S25 mountStrip: Enter submits the field\'s text, clears it only when it was filed and not edited meanwhile', async () => {
  const doc = fakeDoc(STRIP_IDS);
  const b = bridgeSpy();
  d.mountStrip(doc, b);
  const input = doc.byId['index-note'];

  input.value = 'a note';
  const ev = input.fire('keydown', key('Enter'));
  assert.ok(ev.prevented);
  await tick();
  assert.deepStrictEqual(b.calls.filter(c => c[0] === 'submit'), [['submit', 'a note']]);
  assert.strictEqual(input.value, '', 'filed: the field empties');

  input.value = 'second';
  const b2calls = b.calls.length;
  b.indexSubmit = (v) => { b.calls.push(['submit', v]); input.value = 'second, edited'; return Promise.resolve({ ok: true }); };
  input.fire('keydown', key('Enter'));
  await tick();
  assert.strictEqual(input.value, 'second, edited', 'typing during the round trip is not wiped');
  assert.ok(b.calls.length > b2calls);

  input.value = 'refused';
  b.indexSubmit = (v) => { b.calls.push(['submit', v]); return Promise.resolve({ ok: false }); };
  input.fire('keydown', key('Enter'));
  await tick();
  assert.strictEqual(input.value, 'refused', 'not filed: the words stay');

  input.value = 'rejected';
  b.indexSubmit = () => Promise.reject(new Error('ipc'));
  input.fire('keydown', key('Enter'));
  await tick();
  assert.strictEqual(input.value, 'rejected', 'a rejected submit keeps the words and throws nothing');

  input.value = 'null result';
  b.indexSubmit = () => Promise.resolve(null);
  input.fire('keydown', key('Enter'));
  await tick();
  assert.strictEqual(input.value, 'null result');
});

test('S25 mountStrip: an empty or whitespace field, a composing Enter and any other key submit nothing', async () => {
  const doc = fakeDoc(STRIP_IDS);
  const b = bridgeSpy();
  d.mountStrip(doc, b);
  const input = doc.byId['index-note'];
  input.value = '   ';
  input.fire('keydown', key('Enter'));
  input.value = 'real';
  input.fire('keydown', key('Enter', { isComposing: true }));
  input.fire('keydown', key('a'));
  input.fire('keydown', key('Tab'));
  await tick();
  assert.deepStrictEqual(b.calls.filter(c => c[0] === 'submit'), []);
  assert.strictEqual(input.value, 'real');
});

test('S25 mountStrip: Escape leaves the field (blur + indexLeave); focus and blur are reported; chip and counter click through', () => {
  const doc = fakeDoc(STRIP_IDS);
  const b = bridgeSpy();
  d.mountStrip(doc, b);
  const input = doc.byId['index-note'];

  const esc = input.fire('keydown', key('Escape'));
  assert.ok(esc.prevented);
  assert.strictEqual(input.blurred, 1);
  assert.deepStrictEqual(b.calls, [['leave']]);

  input.fire('focus');
  input.fire('blur');
  doc.byId['index-chip'].fire('click');
  doc.byId['index-count'].fire('click');
  assert.deepStrictEqual(b.calls.slice(1), [['focus', true], ['focus', false], ['chip'], ['list']]);
});

test('S25 mountStrip: the form never submits natively; the bridge\'s state repaints the strip; its focus request focuses and selects the field', () => {
  const doc = fakeDoc(STRIP_IDS);
  const b = bridgeSpy();
  d.mountStrip(doc, b);
  const sub = doc.byId.index.fire('submit');
  assert.ok(sub.prevented);

  b.state({ label: 'proj', counts: { filed: 1, unfiled: 0 } });
  assert.strictEqual(doc.byId['index-chip'].textContent, 'proj');
  assert.strictEqual(doc.byId['index-count'].textContent, '1 filed');

  b.focusMe();
  assert.strictEqual(doc.byId['index-note'].focused, 1);
  assert.strictEqual(doc.byId['index-note'].selected, 1);
});

// ---- mountOverlay -----------------------------------------------------------------------------------------------------

function overlay(part, { resizeObserver = false } = {}) {
  const doc = fakeDoc(['root'], { resizeObserver });
  const calls = [];
  const b = {
    calls,
    onState: (fn) => { b.push = fn; },
    ready: (p) => calls.push(['ready', p]),
    size: (p, h) => calls.push(['size', p, h]),
    closeList: () => calls.push(['closeList']),
    dismiss: (seq) => calls.push(['dismiss', seq]),
    undo: (id) => calls.push(['undo', id]),
    copy: (id) => calls.push(['copy', id]),
    open: (f) => calls.push(['open', f]),
  };
  const ok = d.mountOverlay(doc, b, part);
  return { doc, b, calls, ok, root: doc.byId.root };
}

const filedRow = (over = {}) => ({ id: 'n1', state: 'filed', text: 'remember the milk\nand eggs', undoable: true, at: 0, ...over });

test('S25 mountOverlay: it mounts only with a root and a bridge that can listen, and tells the bridge which part is ready', () => {
  const good = overlay('toast');
  assert.strictEqual(good.ok, true);
  assert.deepStrictEqual(good.calls, [['ready', 'toast']]);
  assert.strictEqual(d.mountOverlay(fakeDoc([]), { onState: () => {} }, 'toast'), false);
  assert.strictEqual(d.mountOverlay(fakeDoc(['root']), null, 'toast'), false);
  assert.strictEqual(d.mountOverlay(fakeDoc(['root']), {}, 'list'), false);
});

test('S25 mountOverlay (toast): an added note draws its line, the note\'s first line, Undo and the countdown bar', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const o = overlay('toast');
  o.b.push({ toast: { seq: 4, id: 'n1' }, snapshot: { list: [filedRow()] } });
  const box = o.root.children[0];
  assert.strictEqual(box.className, 'toast added');
  assert.strictEqual(box.dataset.kind, 'added');
  assert.strictEqual(byClass(box, 't1')[0].textContent, 'Added to the inbox');
  const note = byClass(box, 'note')[0];
  assert.strictEqual(note.textContent, 'remember the milk');
  assert.strictEqual(note.title, 'remember the milk\nand eggs', 'the whole note is the tooltip');
  assert.deepStrictEqual(buttons(box).map(x => x.textContent), ['Undo']);
  buttons(box)[0].fire('click');
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'undo'), [['undo', 'n1']]);
  const bar = byClass(box, 'bar')[0];
  assert.strictEqual(bar.children[0].style.animationDuration, '10000ms');
});

test('S25 mountOverlay (toast): a note that was not filed offers Copy (not Undo); a note whose Undo is no longer exact offers neither', () => {
  const o = overlay('toast');
  o.b.push({ toast: { seq: 5, id: 'n2' }, snapshot: { list: [{ id: 'n2', state: 'unfiled', reason: 'busy', text: 'x' }] } });
  let box = o.root.children[0];
  assert.strictEqual(box.className, 'toast unfiled');
  assert.strictEqual(byClass(box, 't1')[0].textContent, 'Not filed: The backlog was busy; it tries again');
  assert.deepStrictEqual(buttons(box).map(x => x.textContent), ['Copy']);
  buttons(box)[0].fire('click');
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'copy'), [['copy', 'n2']]);

  o.b.push({ toast: { seq: 6, id: 'n1' }, snapshot: { list: [filedRow({ undoable: false })] } });
  box = o.root.children[0];
  assert.deepStrictEqual(buttons(box), []);
  assert.strictEqual(box.children.filter(c => c.className === 'acts').length, 0, 'no empty action row');
});

test('S25 mountOverlay (toast): a failed Undo shows its line with no note and no Undo/Copy; "changed" with a file offers the backlog', () => {
  const o = overlay('toast');
  o.b.push({ toast: { seq: 7, id: 'n1', result: { ok: false, reason: 'changed', file: 'C:\\p\\BACKLOG.md' } }, snapshot: { list: [filedRow()] } });
  let box = o.root.children[0];
  assert.strictEqual(box.className, 'toast cant-undo');
  assert.strictEqual(byClass(box, 't1')[0].textContent, "Can't undo: the inbox changed since.");
  assert.deepStrictEqual(byClass(box, 'note'), [], 'a failed Undo shows no note');
  assert.deepStrictEqual(buttons(box).map(x => x.textContent), ['Open the backlog']);
  buttons(box)[0].fire('click');
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'open'), [['open', 'C:\\p\\BACKLOG.md']]);

  o.b.push({ toast: { seq: 8, id: 'n1', result: { ok: false, reason: 'not-filed' } }, snapshot: { list: [filedRow()] } });
  box = o.root.children[0];
  assert.strictEqual(box.className, 'toast error');
  assert.deepStrictEqual(buttons(box), []);
});

test('S25 mountOverlay (toast): nothing to show draws nothing (no toast, or a toast whose row is gone)', () => {
  const o = overlay('toast');
  o.b.push({ toast: null, snapshot: { list: [filedRow()] } });
  assert.deepStrictEqual(o.root.children, []);
  o.b.push({ toast: { seq: 1, id: 'missing' }, snapshot: { list: [filedRow()] } });
  assert.deepStrictEqual(o.root.children, []);
  o.b.push({ toast: { seq: 1, id: 'n1' }, snapshot: null });
  assert.deepStrictEqual(o.root.children, []);
  o.b.push(null);
  assert.deepStrictEqual(o.root.children, []);
});

test('S25 mountOverlay (toast): the toast dismisses itself after its time (10 s, 2.5 s once undone); a repaint of the same toast does not restart the clock', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const o = overlay('toast');
  const s = { toast: { seq: 9, id: 'n1' }, snapshot: { list: [filedRow()] } };
  o.b.push(s);
  t.mock.timers.tick(6000);
  o.b.push(s);                                 // same seq and kind: the same toast
  t.mock.timers.tick(3999);
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'dismiss'), [], '9.999 s after the first paint');
  t.mock.timers.tick(1);
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'dismiss'), [['dismiss', 9]], 'dismissed once, at 10 s from the FIRST paint');

  const u = overlay('toast');
  const first = { toast: { seq: 10, id: 'n1' }, snapshot: { list: [filedRow()] } };
  u.b.push(first);
  t.mock.timers.tick(1000);
  u.b.push({ toast: { seq: 10, id: 'n1' }, snapshot: { list: [filedRow({ state: 'undone' })] } });   // same seq, new kind: restarts
  t.mock.timers.tick(2499);
  assert.deepStrictEqual(u.calls.filter(c => c[0] === 'dismiss'), []);
  t.mock.timers.tick(1);
  assert.deepStrictEqual(u.calls.filter(c => c[0] === 'dismiss'), [['dismiss', 10]], 'undone: 2.5 s, and the old 10 s timer is cancelled');
  t.mock.timers.tick(20000);
  assert.strictEqual(u.calls.filter(c => c[0] === 'dismiss').length, 1);
});

test('S25 mountOverlay (toast): a new toast (new seq) restarts the clock; losing the toast arms none', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const o = overlay('toast');
  o.b.push({ toast: { seq: 1, id: 'n1' }, snapshot: { list: [filedRow()] } });
  t.mock.timers.tick(9000);
  o.b.push({ toast: { seq: 2, id: 'n1' }, snapshot: { list: [filedRow()] } });
  t.mock.timers.tick(9000);
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'dismiss'), [], 'seq 1\'s timer was cancelled');
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'dismiss'), [['dismiss', 2]]);

  const n = overlay('toast');
  n.b.push({ toast: null, snapshot: { list: [] } });
  t.mock.timers.tick(60000);
  assert.deepStrictEqual(n.calls.filter(c => c[0] === 'dismiss'), []);
});

test('S25 mountOverlay (list): the list part never arms a dismiss timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const o = overlay('list');
  o.b.push({ listOpen: true, label: 'p', toast: { seq: 1, id: 'n1' }, snapshot: { list: [filedRow()] } });
  t.mock.timers.tick(60000);
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'dismiss'), []);
});

test('S25 mountOverlay (list): the header names the project, rows show text, time, place and their buttons; an empty list says so', () => {
  const o = overlay('list');
  const at = new Date(2026, 9, 5, 14, 3).getTime();
  const rows = [
    filedRow({ id: 'a', text: 'filed note', at }),
    { id: 'b', state: 'unfiled', reason: 'no-docs', text: 'lost note', at },
    { id: 'c', state: 'undone', text: 'gone note' },
    filedRow({ id: 'd', text: 'old', undoable: false, at }),
  ];
  o.b.push({ listOpen: true, label: 'claude-custom', snapshot: { list: rows } });
  const pop = o.root.children[0];
  assert.strictEqual(pop.className, 'pop');
  const head = byClass(pop, 'head')[0];
  assert.strictEqual(head.children[0].textContent, 'Today · claude-custom');
  const x = buttons(head)[0];
  assert.strictEqual(x.textContent, '✕');
  assert.strictEqual(x.title, 'Close (Esc)');
  x.fire('click');
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'closeList'), [['closeList']]);

  const lines = flat(pop).filter(n => n.className.startsWith('row '));
  assert.deepStrictEqual(lines.map(l => l.className), ['row filed', 'row unfiled', 'row undone', 'row filed']);
  const cell = (l, c) => byClass(l, c)[0].textContent;
  assert.deepStrictEqual(lines.map(l => [cell(l, 'what'), cell(l, 'when'), cell(l, 'where')]), [
    ['filed note', '14:03', 'In the inbox'],
    ['lost note', '14:03', 'Not filed: This project has no documentation folder'],
    ['gone note', '', 'Undone'],
    ['old', '14:03', 'In the inbox (changed since)'],
  ]);
  assert.strictEqual(byClass(lines[0], 'what')[0].title, 'filed note');
  assert.deepStrictEqual(lines.map(l => buttons(l).map(b => b.textContent)), [['Undo'], ['Copy'], [], []]);
  buttons(lines[0])[0].fire('click');
  buttons(lines[1])[0].fire('click');
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'undo' || c[0] === 'copy'), [['undo', 'a'], ['copy', 'b']]);
  assert.strictEqual(byClass(pop, 'empty').length, 0);

  o.b.push({ listOpen: true, label: 'p', snapshot: { list: [] } });
  assert.strictEqual(byClass(o.root.children[0], 'empty')[0].textContent, 'Nothing added today.');
  o.b.push({ listOpen: true, label: 5, snapshot: null });
  assert.strictEqual(byClass(o.root.children[0], 'head')[0].children[0].textContent, 'Today · ');
  o.b.push({ listOpen: false, label: 'p', snapshot: { list: rows } });
  assert.deepStrictEqual(o.root.children, [], 'a closed list draws nothing');
  o.b.push({ listOpen: 'yes', label: 'p', snapshot: { list: rows } });
  assert.deepStrictEqual(o.root.children, [], 'only a real true opens it');
});

test('S25 mountOverlay: Escape closes the list or dismisses the toast, only once there is a state; other keys do nothing', () => {
  const l = overlay('list');
  l.doc.listeners.keydown({ key: 'Escape' });
  assert.deepStrictEqual(l.calls.filter(c => c[0] === 'closeList'), [], 'no state yet');
  l.b.push({ listOpen: true, label: 'p', snapshot: { list: [] } });
  l.doc.listeners.keydown({ key: 'Enter' });
  assert.deepStrictEqual(l.calls.filter(c => c[0] === 'closeList'), []);
  l.doc.listeners.keydown({ key: 'Escape' });
  assert.deepStrictEqual(l.calls.filter(c => c[0] === 'closeList'), [['closeList']]);

  const t = overlay('toast');
  t.b.push({ toast: null, snapshot: { list: [] } });
  t.doc.listeners.keydown({ key: 'Escape' });
  assert.deepStrictEqual(t.calls.filter(c => c[0] === 'dismiss'), [], 'no toast to dismiss');
  t.b.push({ toast: { seq: 12, id: 'n1' }, snapshot: { list: [filedRow()] } });
  t.doc.listeners.keydown({ key: 'Escape' });
  assert.deepStrictEqual(t.calls.filter(c => c[0] === 'dismiss'), [['dismiss', 12]]);
});

test('S25 mountOverlay: the accent is set only for a #rrggbb colour and removed otherwise', () => {
  const o = overlay('list');
  o.b.push({ accent: '#a1B2c3', listOpen: false });
  assert.strictEqual(o.doc.props['--accent'], '#a1B2c3');
  for (const bad of ['#abc', '#a1b2c', '#a1b2c3d', 'a1b2c3', 'red', 5, null, undefined]) {
    o.b.push({ accent: '#112233', listOpen: false });
    o.b.push({ accent: bad, listOpen: false });
    assert.ok(!('--accent' in o.doc.props), `${String(bad)} removes it`);
  }
  o.b.push(null);
  assert.ok(!('--accent' in o.doc.props));
});

test('S25 mountOverlay: the page reports its content height (rounded up; 0 when empty), and watches its root for resizes', () => {
  const o = overlay('list', { resizeObserver: true });
  assert.strictEqual(o.doc.observed.length, 1);
  assert.strictEqual(o.doc.observed[0][1], o.root, 'the observer watches the root');
  o.root.rect = { height: 41.2 };
  o.b.push({ listOpen: true, label: 'p', snapshot: { list: [] } });
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'size').at(-1), ['size', 'list', 42]);
  o.b.push({ listOpen: false });
  assert.deepStrictEqual(o.calls.filter(c => c[0] === 'size').at(-1), ['size', 'list', 0], 'nothing drawn: height 0');
  o.doc.observed[0][0].fn();                  // the observer's callback reports too
  assert.strictEqual(o.calls.filter(c => c[0] === 'size').length, 3);
  const bare = overlay('toast');             // no ResizeObserver in the page: still mounts
  assert.strictEqual(bare.ok, true);
});
