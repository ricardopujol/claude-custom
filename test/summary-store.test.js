'use strict';
/**
 * Where a tab's summary is kept (host/summary-store.js, backlog #39 job 1, DESIGN_SLAVE_MODE_SUMMARY.md decision 5):
 * in memory, and in `<state>/summaries/<session-id>.json` written atomically, so a restart shows the last summary
 * (dimmed as stale until refreshed). The session id comes off a hook payload, i.e. it is somebody else's string:
 * it never becomes a path outside the folder.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSummaryStore } = require('../host/summary-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sumstore-'));
const REC = { text: 'Working on: x\nNext: y', model: 'llama3.2:3b', turnsSeen: 12, newestKey: 'uuid-9' };
const SID = '0f9d3a52-1c7e-4b8e-9d2a-77aa11bb22cc';

test('nothing is known for a session until a summary is put: null, never an empty summary', () => {
  const s = createSummaryStore({ dir: tmp() });
  assert.strictEqual(s.get(SID), null);
});

test('put returns the record it holds, stamped with its time, and get returns it fresh (not stale)', () => {
  const s = createSummaryStore({ dir: tmp() });
  const r = s.put(SID, REC, 5000);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.record, { ...REC, at: 5000, stale: false });
  assert.deepStrictEqual(s.get(SID), { ...REC, at: 5000, stale: false });
});

test('a restart reads the last summary from disk and says it is stale until a new one is put', () => {
  const dir = tmp();
  createSummaryStore({ dir }).put(SID, REC, 5000);
  const after = createSummaryStore({ dir });
  assert.deepStrictEqual(after.get(SID), { ...REC, at: 5000, stale: true });
  after.put(SID, { ...REC, text: 'Working on: z' }, 9000);
  assert.deepStrictEqual(after.get(SID), { ...REC, text: 'Working on: z', at: 9000, stale: false });
});

test('the file is <dir>/<session-id>.json, and no temp file is left behind', () => {
  const dir = tmp();
  createSummaryStore({ dir }).put(SID, REC, 5000);
  assert.deepStrictEqual(fs.readdirSync(dir), [SID + '.json']);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, SID + '.json'), 'utf8'));
  assert.deepStrictEqual(onDisk, { ...REC, at: 5000 });
});

test('the folder is created when it is not there', () => {
  const dir = path.join(tmp(), 'a', 'b');
  const s = createSummaryStore({ dir });
  assert.strictEqual(s.put(SID, REC, 1).ok, true);
  assert.ok(fs.existsSync(path.join(dir, SID + '.json')));
});

test('a file that is not a summary reads as nothing, whatever is wrong with it', () => {
  const dir = tmp();
  const bad = [
    'not json', '', 'null', '[]', '42', '{}',
    JSON.stringify({ ...REC, at: 1, text: '' }),
    JSON.stringify({ ...REC, at: 1, text: 5 }),
    JSON.stringify({ ...REC, at: null }),
    JSON.stringify({ ...REC, at: '1' }),
    JSON.stringify({ ...REC, at: 1, model: 3 }),
    JSON.stringify({ ...REC, at: 1, turnsSeen: -1 }),
    JSON.stringify({ ...REC, at: 1, turnsSeen: 1.5 }),
    JSON.stringify({ ...REC, at: 1, turnsSeen: null }),
    JSON.stringify({ ...REC, at: 1, newestKey: 7 }),
    JSON.stringify({ ...REC, at: 1, text: 'x'.repeat(5000) }),
    'x'.repeat(200_000),
  ];
  for (const text of bad) {
    fs.writeFileSync(path.join(dir, SID + '.json'), text);
    assert.strictEqual(createSummaryStore({ dir }).get(SID), null, text.slice(0, 40));
  }
});

test('newestKey may be null (a summary built before any key was known)', () => {
  const dir = tmp();
  createSummaryStore({ dir }).put(SID, { ...REC, newestKey: null }, 1);
  assert.strictEqual(createSummaryStore({ dir }).get(SID).newestKey, null);
});

test('a summary that is not one is refused and nothing is written', () => {
  const dir = tmp();
  const s = createSummaryStore({ dir });
  for (const rec of [null, undefined, 'x', {}, { ...REC, text: '' }, { ...REC, text: '  ' }, { ...REC, text: 'x'.repeat(2001) },
    { ...REC, model: '' }, { ...REC, turnsSeen: -1 }, { ...REC, turnsSeen: NaN }]) {
    assert.strictEqual(s.put(SID, rec, 1).ok, false, JSON.stringify(rec));
  }
  assert.strictEqual(s.put(SID, REC, NaN).ok, false);
  assert.strictEqual(s.put(SID, REC, null).ok, false, 'Number(null) is 0: a missing time is not time zero');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.strictEqual(s.get(SID), null);
});

test('a session id that could leave the folder is never a path', () => {
  const root = tmp();
  const dir = path.join(root, 'summaries');
  fs.mkdirSync(dir);
  const s = createSummaryStore({ dir });
  for (const id of ['', '..', '../escape', 'a/b', 'a\\b', '.hidden', 'x'.repeat(200), 'a b', 'C:\\x', null, undefined, 5, {}]) {
    assert.strictEqual(s.put(id, REC, 1).ok, false, String(id));
    assert.strictEqual(s.get(id), null, String(id));
  }
  assert.deepStrictEqual(fs.readdirSync(root), ['summaries']);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a write that fails is reported, the summary is still held in memory, and the old file is left whole', () => {
  const dir = tmp();
  createSummaryStore({ dir }).put(SID, REC, 1000);
  const s = createSummaryStore({ dir, rename: () => { throw new Error('EPERM: locked'); } });
  const r = s.put(SID, { ...REC, text: 'Working on: newer' }, 2000);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /EPERM/);
  assert.strictEqual(s.get(SID).text, 'Working on: newer');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, SID + '.json'), 'utf8')).text, REC.text, 'the old file is whole');
  assert.deepStrictEqual(fs.readdirSync(dir), [SID + '.json'], 'the temp file is cleaned up');
});

test('a folder that cannot be written to is a reported failure, not a throw', () => {
  const root = tmp();
  const blocker = path.join(root, 'file');
  fs.writeFileSync(blocker, 'x');
  const s = createSummaryStore({ dir: path.join(blocker, 'summaries') });
  const r = s.put(SID, REC, 1);
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error !== '');
  assert.strictEqual(s.get(SID).text, REC.text);
});

test('two sessions keep separate summaries', () => {
  const s = createSummaryStore({ dir: tmp() });
  s.put('aaa', { ...REC, text: 'Working on: A' }, 1);
  s.put('bbb', { ...REC, text: 'Working on: B' }, 2);
  assert.strictEqual(s.get('aaa').text, 'Working on: A');
  assert.strictEqual(s.get('bbb').text, 'Working on: B');
});

test('property: whatever is put comes back identical after a restart, only flagged stale', () => {
  const recArb = fc.record({
    text: fc.string({ minLength: 1, maxLength: 1500 }).filter(t => t.trim() !== ''),
    model: fc.stringMatching(/^[a-z0-9][a-z0-9.:_-]{0,20}$/),
    turnsSeen: fc.nat(500),
    newestKey: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: null }),
  });
  const dir = tmp();
  fc.assert(fc.property(recArb, fc.nat(2 ** 40), (rec, at) => {
    const w = createSummaryStore({ dir }).put(SID, rec, at);
    assert.strictEqual(w.ok, true);
    assert.deepStrictEqual(createSummaryStore({ dir }).get(SID), { ...rec, at, stale: true });
  }), { numRuns: 100 });
});
