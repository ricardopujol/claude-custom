'use strict';
/**
 * BACKLOG #33 gamification: the explainer's two counts (questions answered, places opened), kept install-wide beside the medals.
 * Absence is UNKNOWN (null), never 0; a count never goes down; a file that could not be read is never written over.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fc = require('fast-check');

const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createAskCounts, KEY } = require('../host/ask-counts');

function setup() {
  const dir = tmpDir('ask-counts');
  const store = createStore({ dir });
  return { dir, store, make: () => createAskCounts({ store }) };
}

test('a missing file is a genuine nothing-yet: both counts are 0', () => {
  const { make } = setup();
  assert.deepStrictEqual(make().read(), { questions: 0, places: 0 });
});

test('addQuestion and addPlace each raise their own count by one, and persist across instances', () => {
  const { make } = setup();
  const c = make();
  assert.deepStrictEqual(c.addQuestion(), { ok: true, counts: { questions: 1, places: 0 } });
  assert.deepStrictEqual(c.addQuestion().counts, { questions: 2, places: 0 });
  assert.deepStrictEqual(c.addPlace().counts, { questions: 2, places: 1 });
  assert.deepStrictEqual(make().read(), { questions: 2, places: 1 });
});

test('a corrupt file reads as unknown (null), not 0, and is never written over', () => {
  const { store, make } = setup();
  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(store.pathOf(KEY), '{ not json');
  const c = make();
  assert.strictEqual(c.read(), null);
  const r = c.addQuestion();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unreadable');
  assert.strictEqual(fs.readFileSync(store.pathOf(KEY), 'utf8'), '{ not json');
});

test('a file of the wrong shape (a count that is not a whole number) is unreadable, not a confident 0', () => {
  const { store, make } = setup();
  for (const bad of [{ questions: null, places: 1 }, { questions: '3', places: 1 }, { questions: -1, places: 0 }, { questions: 1.5, places: 0 }, [], 7]) {
    store.write(KEY, bad);
    assert.strictEqual(make().read(), null, JSON.stringify(bad));
  }
});

test('a held file answers the last good counts (a moment of antivirus is not "no counts")', () => {
  const { store } = setup();
  let hold = false;
  const flaky = { ...store, readState: (k) => (hold ? { status: 'unreadable', value: null } : store.readState(k)), write: store.write, withLock: store.withLock };
  const c = createAskCounts({ store: flaky });
  c.addQuestion();
  hold = true;
  assert.deepStrictEqual(c.read(), { questions: 1, places: 0 });
  hold = false;
  assert.deepStrictEqual(c.addPlace().counts, { questions: 1, places: 1 });
});

test('an edit keeps every other key of the file verbatim and refuses a newer version', () => {
  const { store, make } = setup();
  store.write(KEY, { version: 1, questions: 4, places: 2, extra: { keep: 'me' } });
  make().addPlace();
  assert.deepStrictEqual(store.read(KEY, null), { version: 1, questions: 4, places: 3, extra: { keep: 'me' } });
  store.write(KEY, { version: 9, questions: 4, places: 2 });
  const r = make().addQuestion();
  assert.deepStrictEqual([r.ok, r.reason], [false, 'newer-version']);
  assert.strictEqual(store.read(KEY, null).questions, 4);
});

test('a failed write is reported, not swallowed, and the count is unchanged', () => {
  const { store } = setup();
  const c = createAskCounts({ store: { ...store, readState: store.readState, withLock: store.withLock, write: () => { throw new Error('disk full'); } } });
  const r = c.addQuestion();
  assert.deepStrictEqual([r.ok, r.reason], [false, 'write-failed']);
  assert.deepStrictEqual(c.read(), { questions: 0, places: 0 });
});

test('the store is required to have readState, write and withLock', () => {
  assert.throws(() => createAskCounts({}), /store/);
  assert.throws(() => createAskCounts({ store: { write() {} } }), /store/);
});

test('PROPERTY: whatever sequence of adds, failing writes and held reads, a count never goes down', () => {
  fc.assert(fc.property(fc.array(fc.constantFrom('q', 'p', 'qfail', 'held', 'read'), { maxLength: 40 }), (ops) => {
    const { store } = setup();
    let fail = false;
    let hold = false;
    const s = {
      readState: (k) => (hold ? { status: 'unreadable', value: null } : store.readState(k)),
      write: (k, v) => { if (fail) throw new Error('x'); return store.write(k, v); },
      withLock: store.withLock,
    };
    const c = createAskCounts({ store: s });
    let seenQ = 0;
    let seenP = 0;
    for (const op of ops) {
      fail = op === 'qfail';
      hold = op === 'held';
      if (op === 'q' || op === 'qfail') c.addQuestion();
      if (op === 'p') c.addPlace();
      fail = false;
      hold = false;
      const now = c.read();
      assert.ok(now !== null);
      assert.ok(now.questions >= seenQ && now.places >= seenP);
      seenQ = now.questions;
      seenP = now.places;
    }
  }), { numRuns: 60 });
});
