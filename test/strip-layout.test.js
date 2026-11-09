'use strict';
/**
 * host/strip-layout.js (BACKLOG #141 + the design's "closed stays closed"): the strip's drag order and the lanes closed by
 * hand, kept beside the project's other state so both survive a restart.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createStripLayout, stripLayoutFileFor, parseLayout, FILE_NAME } = require('../host/strip-layout');

function memory(initial) {
  const files = new Map(initial === undefined ? [] : [['F', initial]]);
  const writes = [];
  return {
    files, writes,
    layout: createStripLayout({
      file: 'F',
      readText: (f) => { if (!files.has(f)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return files.get(f); },
      writeText: (f, t) => { writes.push(t); files.set(f, t); },
      mkdir: () => {},
    }),
  };
}

const { normPath } = require('../host/project-layout');
const entry = (name, branch = null) => ({ key: normPath(`C:\\p\\${name}`), path: `C:\\p\\${name}`, branch });
const CLOSED = { key: 'c:\\p\\feat-a', path: 'C:\\p\\feat-a', branch: 'feat/a' };

test('no file yet is an empty layout, and saving then loading round-trips', () => {
  const m = memory();
  assert.deepStrictEqual(m.layout.load(), { order: [], closed: [], error: null });
  assert.deepStrictEqual(m.layout.save({ order: ['c:\\p\\b', 'c:\\p\\a'], closed: [CLOSED] }), { ok: true });
  const again = createStripLayout({ file: 'F', readText: (f) => m.files.get(f), writeText: () => assert.fail('a read writes nothing'), mkdir: () => {} });
  assert.deepStrictEqual(again.load(), { order: ['c:\\p\\b', 'c:\\p\\a'], closed: [CLOSED], error: null });
});

test('the file name sits in the look folder under the project, and a foreign look folder means no file', () => {
  assert.strictEqual(FILE_NAME, 'tab-strip.json');
  assert.strictEqual(stripLayoutFileFor('C:\\proj', {
    lstatSync: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; }, mkdirSync: () => {}, existsSync: () => true,
  }).endsWith(FILE_NAME), true);
  assert.strictEqual(stripLayoutFileFor('C:\\proj', {
    lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => true }),
  }), null);
});

test('a file that is not understood is left alone: load says so, and save refuses to write over it', () => {
  for (const bad of ['{ nope', '[]', '"x"', 'null']) {
    const m = memory(bad);
    const r = m.layout.load();
    assert.deepStrictEqual([r.order, r.closed], [[], []], bad);
    assert.ok(typeof r.error === 'string' && r.error !== '', bad);
    assert.strictEqual(m.layout.save({ order: ['a'], closed: [] }).ok, false, bad);
    assert.deepStrictEqual(m.writes, [], bad);
  }
});

test('a read that fails some other way (a scan holding the file) is an unknown store, not an empty one', () => {
  const layout = createStripLayout({
    file: 'F', readText: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }, writeText: () => assert.fail('must not write'), mkdir: () => {},
  });
  assert.ok(layout.load().error);
  assert.strictEqual(layout.save({ order: ['a'], closed: [] }).ok, false);
});

test('without a file (a look folder that is a link elsewhere) it lives in memory for this run and says ok', () => {
  const layout = createStripLayout({ file: null });
  assert.deepStrictEqual(layout.load(), { order: [], closed: [], error: null });
  assert.deepStrictEqual(layout.save({ order: ['a'], closed: [] }), { ok: true });
});

test('a failed write is an error answer, never a throw', () => {
  const layout = createStripLayout({
    file: 'F', readText: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }, writeText: () => { throw new Error('disk full'); }, mkdir: () => {},
  });
  layout.load();
  assert.deepStrictEqual(layout.save({ order: ['a'], closed: [] }), { ok: false, error: 'disk full' });
});

test('strict parsing: bad entries are dropped one by one, repeats once, and nothing coerces', () => {
  const r = parseLayout(JSON.stringify({
    version: 1,
    order: ['a', '', 7, null, 'b', 'a', {}],
    closed: [CLOSED, { key: 'x' }, { key: 5, path: 'p' }, null, 'str', { ...CLOSED }, { ...entry('k2'), branch: 9 }, { ...entry('k3'), branch: '' }],
  }));
  assert.deepStrictEqual(r.order, ['a', 'b']);
  assert.deepStrictEqual(r.closed, [
    CLOSED,
    entry('k2'),
    entry('k3'),
  ]);
});

test('a missing or wrong-typed list is an empty one', () => {
  assert.deepStrictEqual(parseLayout('{"version":1}'), { order: [], closed: [] });
  assert.deepStrictEqual(parseLayout('{"order":"a","closed":{}}'), { order: [], closed: [] });
});

test('lists are bounded when written, keeping the newest closed (they are most recent first) and the first of the order', () => {
  const m = memory();
  const order = Array.from({ length: 700 }, (_, i) => `k${i}`);
  const closed = Array.from({ length: 300 }, (_, i) => entry(`c${i}`));
  m.layout.save({ order, closed });
  const r = parseLayout(m.files.get('F'));
  assert.strictEqual(r.order.length, 500);
  assert.strictEqual(r.order[0], 'k0');
  assert.strictEqual(r.closed.length, 100);
  assert.strictEqual(r.closed[0].key, entry('c0').key);
});

test('property: whatever is saved, what loads is clean (strings, no repeats) and a second save of it changes nothing', () => {
  const junk = fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.constant(undefined), fc.constant({}));
  fc.assert(fc.property(fc.array(junk, { maxLength: 30 }), fc.array(fc.record({ key: junk, path: junk, branch: junk }, { requiredKeys: [] }), { maxLength: 10 }), (order, closed) => {
    const m = memory();
    m.layout.save({ order, closed });
    const text = m.files.get('F');
    const first = parseLayout(text);
    assert.ok(first.order.every(k => typeof k === 'string' && k !== ''));
    assert.strictEqual(new Set(first.order).size, first.order.length);
    assert.ok(first.closed.every(c => typeof c.key === 'string' && c.key !== '' && typeof c.path === 'string' && c.path !== ''));
    m.layout.save(first);
    assert.deepStrictEqual(parseLayout(m.files.get('F')), first);
  }), { numRuns: 200 });
});

// --- PR #227 Dexter 2 + 7 ---------------------------------------------------------------------------

/** Two windows of one project: two stores over ONE file. */
function twoWindows() {
  const box = { text: undefined };
  const clock = { t: 1000 };     // the clock both windows read: a test moves it between actions, and every read ticks it (two actions are never at one instant)
  const make = () => createStripLayout({
    file: 'F',
    readText: () => { if (box.text === undefined) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return box.text; },
    writeText: (f, t) => { box.text = t; },
    mkdir: () => {},
    now: () => clock.t++,
  });
  return { box, clock, a: make(), b: make() };
}

test('Dexter 2: two windows each save from their own memory; a lane one closed stays closed when the other saves', () => {
  const w = twoWindows();
  w.a.load(); w.b.load();
  w.a.save({ order: [], closed: [entry('x')] });
  w.b.save({ order: [entry('y').key, entry('z').key], closed: [] });
  const r = parseLayout(w.box.text);
  assert.deepStrictEqual(r.closed, [entry('x')], 'a closed lane survives the other window\'s save');
  assert.deepStrictEqual(r.order, [entry('y').key, entry('z').key], 'and the other window\'s drag is kept');
  // window A saves again without touching the order: B's order is not put back to A's old (empty) one
  w.a.save({ order: [], closed: [entry('x'), entry('w')] });
  const r2 = parseLayout(w.box.text);
  assert.deepStrictEqual(r2.order, [entry('y').key, entry('z').key]);
  assert.deepStrictEqual(r2.closed.map(c => c.key), [entry('x').key, entry('w').key]);
});

test('Dexter 2: a lane this window reopened is removed from the file; one another window closed is not', () => {
  const w = twoWindows();
  w.a.save({ order: [], closed: [entry('x')] });
  w.b.load();                                               // b starts knowing x is closed
  w.a.save({ order: [], closed: [entry('x'), entry('q')] });   // a closes q too
  w.b.save({ order: [], closed: [] });                      // b reopens x (and has never heard of q)
  assert.deepStrictEqual(parseLayout(w.box.text).closed.map(c => c.key), [entry('q').key]);
});

// --- PR #227 Dexter r2 C: the newer action on a lane wins, whichever window made it ---------------------------------

/** Both windows have loaded a file that says x is closed. */
function bothHoldingClosed(x = entry('x')) {
  const w = twoWindows();
  w.a.save({ order: [], closed: [x] });
  w.clock.t = 2000;
  w.a.load(); w.b.load();
  return w;
}

test('Dexter r2 C: window A reopens a lane, then window B (still holding it closed) saves a drag: after a restart the lane is open', () => {
  const x = entry('x');
  const w = bothHoldingClosed(x);
  w.clock.t = 3000;
  w.a.save({ order: [], closed: [] });                                   // A reopens x
  assert.deepStrictEqual(parseLayout(w.box.text).closed, []);
  w.clock.t = 4000;
  w.b.save({ order: [entry('y').key, entry('z').key], closed: [x] });     // B drags; it never heard of the reopen
  const r = parseLayout(w.box.text);
  assert.deepStrictEqual(r.closed, [], 'the reopen is the newer action on x, so it stands');
  assert.deepStrictEqual(r.order, [entry('y').key, entry('z').key], 'and B\'s drag is kept');
  // ...and a window starting now (a restart) sees it open.
  assert.deepStrictEqual(w.a.load().closed, []);
});

test('Dexter r2 C: the same in the other order -- B saves first, then A reopens -- ends open too', () => {
  const x = entry('x');
  const w = bothHoldingClosed(x);
  w.clock.t = 3000;
  w.b.save({ order: [entry('y').key], closed: [x] });
  w.clock.t = 4000;
  w.a.save({ order: [], closed: [] });
  assert.deepStrictEqual(parseLayout(w.box.text).closed, []);
});

test('Dexter r2 C: a close made AFTER the reopen is newer and wins; closing again later in the stale window does not undo a later reopen', () => {
  const x = entry('x');
  const w = bothHoldingClosed(x);
  w.clock.t = 3000;
  w.a.save({ order: [], closed: [] });                                   // A reopens x
  w.clock.t = 4000;
  w.a.save({ order: [], closed: [x] });                                   // A closes it again, newer than its own reopen
  w.clock.t = 5000;
  w.b.save({ order: [entry('y').key], closed: [x] });                     // B's stale hold is older than A's close
  assert.deepStrictEqual(parseLayout(w.box.text).closed, [x]);
  w.clock.t = 6000;
  w.a.save({ order: [], closed: [] });                                   // A reopens for good
  w.clock.t = 7000;
  w.b.save({ order: [entry('y').key, entry('z').key], closed: [x] });
  assert.deepStrictEqual(parseLayout(w.box.text).closed, [], 'the later reopen outlasts B\'s every later save');
});

test('Dexter r2 C: a lane that window B itself closes after A\'s reopen is closed (B\'s close is the newer action)', () => {
  const x = entry('x');
  const w = twoWindows();
  w.b.load();
  w.clock.t = 2000;
  w.a.save({ order: [], closed: [x] });
  w.a.load();
  w.clock.t = 3000;
  w.a.save({ order: [], closed: [] });                                   // A reopens
  w.clock.t = 4000;
  w.b.save({ order: [], closed: [x] });                                   // B never held x; it closes it now
  assert.deepStrictEqual(parseLayout(w.box.text).closed, [x]);
});

test('Dexter r2 C: a file with no timestamps (written before this) loads and merges as before, and a reopen still beats its stale hold', () => {
  const x = entry('x');
  const w = twoWindows();
  w.box.text = JSON.stringify({ version: 1, order: [], closed: [x] });
  w.a.load(); w.b.load();
  w.clock.t = 3000;
  w.a.save({ order: [], closed: [] });
  w.b.save({ order: [entry('y').key], closed: [x] });
  assert.deepStrictEqual(parseLayout(w.box.text).closed, []);
});

test('Dexter r2 C: the stamps stay out of what load hands the shell, and the tombstones are bounded', () => {
  const w = twoWindows();
  w.a.save({ order: [], closed: [entry('x')] });
  assert.deepStrictEqual(w.a.load().closed, [entry('x')], 'entries are { key, path, branch } and nothing else');
  const batch = (tag) => Array.from({ length: 100 }, (_, i) => entry(`${tag}${i}`));
  for (const tag of ['p', 'q', 'r']) {      // close 100 lanes, reopen them all: 100 tombstones a round
    w.clock.t += 10;
    w.a.save({ order: [], closed: batch(tag) });
    w.clock.t += 10;
    w.a.save({ order: [], closed: [] });
  }
  const reopened = JSON.parse(w.box.text).reopened;
  assert.strictEqual(reopened.length, 100);
  assert.ok(reopened.every(r => r.key.startsWith('c:\\p\\r')), 'the newest are the ones kept');
});

test('Dexter 2: a file that cannot be read at save time is an error answer, and the next save may still go through', () => {
  let busy = true;
  let body = JSON.stringify({ version: 1, order: [], closed: [] });
  const layout = createStripLayout({
    file: 'F',
    readText: () => { if (busy) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return body; },
    writeText: (f, t) => { body = t; }, mkdir: () => {},
  });
  assert.strictEqual(layout.save({ order: ['a'], closed: [] }).ok, false);
  busy = false;
  assert.strictEqual(layout.save({ order: ['a'], closed: [] }).ok, true);
  assert.deepStrictEqual(parseLayout(body).order, ['a']);
});

test('Dexter 7: a closed entry whose key is not its path\'s key is dropped (it could never be reopened)', () => {
  const r = parseLayout(JSON.stringify({ version: 1, order: [], closed: [{ key: 'c:\\p\\feat-x', path: 'C:\\p\\feat-y', branch: null }, entry('ok')] }));
  assert.deepStrictEqual(r.closed, [entry('ok')]);
});

test('Dexter 7: a file of another version is an unknown store: load says so and save will not write over it', () => {
  const m = memory(JSON.stringify({ version: 2, order: ['a'], closed: [] }));
  const l = m.layout.load();
  assert.ok(typeof l.error === 'string' && l.error !== '');
  assert.strictEqual(m.layout.save({ order: ['b'], closed: [] }).ok, false);
  assert.deepStrictEqual(m.writes, []);
  assert.throws(() => parseLayout(JSON.stringify({ version: 2 })));
  assert.doesNotThrow(() => parseLayout(JSON.stringify({ version: 1 })));
  assert.doesNotThrow(() => parseLayout(JSON.stringify({})), 'a file with no version is a v1 file');
});

test('Dexter r2 B: a window that only pruned a merged-away lane from its order does not write over the other window\'s drag', () => {
  const [g, b, c, x] = ['g', 'b', 'c', 'x'].map(n => entry(n));
  const w = twoWindows();
  w.a.save({ order: [g.key, b.key, c.key], closed: [] });
  w.a.load(); w.b.load();                                   // both start from [g, b, c]
  w.b.save({ order: [c.key, b.key], closed: [] });          // g merged away; b drags c before b (and prunes g)
  w.a.save({ order: [b.key, c.key], closed: [x] });          // a closes x; its prune of g is not a drag
  const r = parseLayout(w.box.text);
  assert.deepStrictEqual(r.order, [c.key, b.key], 'the drag is kept');
  assert.deepStrictEqual(r.closed, [x], 'and the close too');
});

test('Dexter r2 B: a real drag in a window that also pruned still wins, and a new key counts as a change', () => {
  const [g, b, c, d] = ['g', 'b', 'c', 'd'].map(n => entry(n));
  const w = twoWindows();
  w.a.save({ order: [g.key, b.key, c.key], closed: [] });
  w.a.load();
  w.a.save({ order: [c.key, b.key], closed: [] });          // pruned g and dragged c first
  assert.deepStrictEqual(parseLayout(w.box.text).order, [c.key, b.key]);
  w.a.save({ order: [c.key, b.key, d.key], closed: [] });   // d joins the order
  assert.deepStrictEqual(parseLayout(w.box.text).order, [c.key, b.key, d.key]);
});

// --- PR #231 Dexter 8 / Miguel G1: stamps are taken when the person ACTS, a tie goes to the close, tombstones expire -----------

const { mergeClosed, TOMB_TTL_MS } = require('../host/strip-layout');
const maps = (o = {}) => ({ closedAt: new Map(Object.entries(o.closedAt || {})), reopenedAt: new Map(Object.entries(o.reopenedAt || {})) });

test('mergeClosed (pure): the newer action wins, and a TIE goes to the close', () => {
  const x = entry('x');
  const run = (closeAt, reopenAt) => mergeClosed({ mine: [x], mineAt: new Map([[x.key, closeAt]]), reopens: new Map([[x.key, reopenAt]]), disk: { closed: [], ...maps() }, now: 10 });
  assert.deepStrictEqual(run(5, 4).closed.map(c => c.key), [x.key], 'a close newer than the reopen stays closed');
  assert.deepStrictEqual(run(5, 4).reopened, [], 'and the tombstone it supersedes is gone');
  assert.deepStrictEqual(run(5, 5).closed.map(c => c.key), [x.key], 'a tie: closed');
  assert.deepStrictEqual(run(5, 6).closed, [], 'a reopen newer than the close: open');
  assert.deepStrictEqual(run(5, 6).reopened, [{ key: x.key, at: 6 }]);
});

test('mergeClosed (pure): a stale hold gives way to a tombstone on disk, and keeps its own stamp otherwise', () => {
  const x = entry('x');
  const stale = mergeClosed({ mine: [x], mineAt: new Map([[x.key, 3]]), reopens: new Map(), disk: { closed: [], ...maps({ reopenedAt: { [x.key]: 4 } }) }, now: 10 });
  assert.deepStrictEqual(stale.closed, []);
  const fresh = mergeClosed({ mine: [x], mineAt: new Map([[x.key, 3]]), reopens: new Map(), disk: { closed: [], ...maps({ reopenedAt: { [x.key]: 2 } }) }, now: 10 });
  assert.deepStrictEqual(fresh.closed, [{ ...x, at: 3 }]);
  const newerOnDisk = mergeClosed({ mine: [x], mineAt: new Map([[x.key, 3]]), reopens: new Map(), disk: { closed: [x], ...maps({ closedAt: { [x.key]: 8 } }) }, now: 10 });
  assert.deepStrictEqual(newerOnDisk.closed, [{ ...x, at: 8 }], 'the same lane closed again, later, by another window');
});

test('mergeClosed (pure): a tombstone is forgotten after 30 days, and at most 100 are kept (the newest)', () => {
  const x = entry('x');
  const old = (now) => mergeClosed({ mine: [], mineAt: new Map(), reopens: new Map(), disk: { closed: [], ...maps({ reopenedAt: { [x.key]: 1000 } }) }, now }).reopened;
  assert.deepStrictEqual(old(1000 + TOMB_TTL_MS), [{ key: x.key, at: 1000 }], 'exactly 30 days: still kept');
  assert.deepStrictEqual(old(1000 + TOMB_TTL_MS + 1), [], 'past it: forgotten');
  const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [entry(`l${i}`).key, 1000 + i]));
  const r = mergeClosed({ mine: [], mineAt: new Map(), reopens: new Map(), disk: { closed: [], ...maps({ reopenedAt: many }) }, now: 2000 }).reopened;
  assert.strictEqual(r.length, 100);
  assert.strictEqual(r[0].at, 1149, 'newest first');
  assert.strictEqual(r[99].at, 1050);
});

test('Dexter 8a: a window\'s own stamps only go up, so a clock that steps back cannot lose a close after a reopen', () => {
  let cur = 500;
  const box = { text: undefined };
  const store = createStripLayout({
    file: 'F', now: () => cur, mkdir: () => {},
    readText: () => { if (box.text === undefined) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return box.text; },
    writeText: (f, t) => { box.text = t; },
  });
  const x = entry('x');
  store.load();
  store.save({ order: [], closed: [x] });          // closed at 500
  cur = 1000; store.save({ order: [], closed: [] });   // reopened at 1000
  cur = 900; store.save({ order: [], closed: [x] });   // closed again; Windows stepped the clock back
  assert.deepStrictEqual(parseLayout(box.text).closed, [x], 'the close is the newest action');
});

test('Dexter 8b: a save that FAILS does not move the time of the action it carried', () => {
  const box = { text: undefined };
  const clock = { t: 100 };
  const busy = { on: false };
  const make = (flaky) => createStripLayout({
    file: 'F', now: () => clock.t, mkdir: () => {},
    readText: () => {
      if (flaky && busy.on) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
      if (box.text === undefined) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }
      return box.text;
    },
    writeText: (f, t) => { box.text = t; },
  });
  const w1 = make(true);
  const w2 = make(false);
  const k = entry('k');
  w2.load(); w1.load();
  w1.save({ order: [], closed: [k] });                               // 100: window 1 closed k
  clock.t = 1000; busy.on = true;
  assert.strictEqual(w1.save({ order: [], closed: [] }).ok, false);  // 1000: it reopens k, but the write fails
  busy.on = false;
  clock.t = 1002;
  w2.save({ order: [], closed: [k] });                               // 1002: window 2 (which never held it) closes k
  clock.t = 1005;
  assert.strictEqual(w1.save({ order: [], closed: [] }).ok, true);   // 1005: window 1 saves again
  assert.deepStrictEqual(parseLayout(box.text).closed, [k], 'window 2\'s close at 1002 is newer than the reopen made at 1000, not 1005');
});

test('property: with two windows acting and saving in any order, a lane ends closed exactly when the newest action on it was a close', () => {
  const lanes = ['p', 'q', 'r'].map(n => entry(n));
  const op = fc.record({ w: fc.integer({ min: 0, max: 1 }), k: fc.integer({ min: 0, max: 2 }), act: fc.constantFrom('close', 'reopen') });
  fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 24 }), (ops) => {
    const w = twoWindows();
    w.a.load(); w.b.load();
    const stores = [w.a, w.b];
    const views = [new Set(), new Set()];       // what each window holds closed: only its own actions change it
    const newest = new Map();                   // lane key -> the newest EFFECTIVE action on it, from anyone
    for (const o of ops) {
      const v = views[o.w];
      const lane = lanes[o.k];
      if (o.act === 'close' && !v.has(lane.key)) v.add(lane.key);
      else if (o.act === 'reopen' && v.has(lane.key)) v.delete(lane.key);
      else continue;
      newest.set(lane.key, o.act);
      stores[o.w].save({ order: [], closed: lanes.filter(l => v.has(l.key)) });
    }
    const closed = w.box.text === undefined ? new Set() : new Set(parseLayout(w.box.text).closed.map(c => c.key));
    return lanes.every(l => (newest.get(l.key) === 'close') === closed.has(l.key));
  }), { numRuns: 300 });
});
