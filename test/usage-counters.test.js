'use strict';
/**
 * Invisible usage counters (audit move 2): one install-wide file, `.harness/state/usage-counters.json`,
 * `{ "<key>": { count, last } }`. Keys and ISO timestamps only. The store's guarantees: counts never go down,
 * a file it can't read is never written over, and the renderer's keys are checked against an allow-list.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createUsageCounters, isValidKey, STATIC_KEYS, STORE_KEY } = require('../host/usage-counters');

function setup() {
  const dir = tmpDir('usage-counters');
  const store = createStore({ dir });
  let t = Date.parse('2026-10-15T10:00:00Z');
  const clock = { advance: (ms) => { t += ms; } };
  const counters = createUsageCounters({ store, now: () => t });
  return { dir, store, counters, clock, file: path.join(dir, `${STORE_KEY}.json`) };
}

test('the store key is usage-counters', () => assert.strictEqual(STORE_KEY, 'usage-counters'));

test('a bump creates the file and counts one, with an ISO timestamp', () => {
  const { counters, file } = setup();
  assert.deepStrictEqual(counters.bump('ask:question'), { ok: true, count: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'ask:question': { count: 1, last: '2026-10-15T10:00:00.000Z' } });
});

test('bumps add up and move "last"', () => {
  const { counters, clock } = setup();
  counters.bump('wand:click'); clock.advance(5000); counters.bump('wand:click');
  assert.deepStrictEqual(counters.all(), { 'wand:click': { count: 2, last: '2026-10-15T10:00:05.000Z' } });
});

test('other keys are written back verbatim, unknown ones too', () => {
  const { counters, file } = setup();
  fs.writeFileSync(file, JSON.stringify({ 'future:key': { count: 7, last: 'x', extra: 1 } }));
  counters.bump('git:opened');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['future:key'], { count: 7, last: 'x', extra: 1 });
});

test('junk keys are refused and nothing is written', () => {
  const { counters, file } = setup();
  for (const k of ['', 'nope', 'ask:question ', '__proto__', 'panel:', 'panel:../x', 'panel:' + 'a'.repeat(40), 'game:x:stop', 7, null, undefined, {}, 'C:\\secret\\path']) {
    assert.strictEqual(counters.bump(k).ok, false, String(k));
  }
  assert.strictEqual(fs.existsSync(file), false);
});

test('isValidKey takes the fixed keys, panel:<id> and game:<name>:start', () => {
  for (const k of STATIC_KEYS) assert.ok(isValidKey(k), k);
  assert.ok(isValidKey('panel:git'));
  assert.ok(isValidKey('game:snake:start'));
  assert.ok(!isValidKey('panel:Git Hub'));
});

test("the brief's keys are all in the set", () => {
  for (const k of ['ask:question', 'ask:place-opened', 'medal:given', 'wand:click', 'style:changed', 'vault:opened', 'git:opened',
    'projects:switch', 'canvas:render', 'focus:on', 'lean:on', 'terminal:file-link', 'terminal:drop', 'tab:new-worktree',
    'tab:merged-close', 'bedtime:start', 'quota:countdown-shown']) assert.ok(STATIC_KEYS.includes(k), k);
});

test('a panel shown twice inside 2 s counts once; after 2 s it counts again; other keys are not debounced', () => {
  const { counters, clock } = setup();
  assert.strictEqual(counters.bump('panel:git').ok, true);
  clock.advance(1999);
  assert.deepStrictEqual(counters.bump('panel:git'), { ok: false, reason: 'debounced' });
  assert.strictEqual(counters.bump('panel:ask').ok, true);
  clock.advance(1);
  assert.strictEqual(counters.bump('panel:git').count, 2);
  assert.strictEqual(counters.bump('ask:question').count, 1);
  assert.strictEqual(counters.bump('ask:question').count, 2);
});

test('style:changed is debounced too (a slider drag is one change)', () => {
  const { counters, clock } = setup();
  assert.strictEqual(counters.bump('style:changed').ok, true);
  clock.advance(500);
  assert.strictEqual(counters.bump('style:changed').reason, 'debounced');
  clock.advance(1500);
  assert.strictEqual(counters.bump('style:changed').count, 2);
});

test('an unreadable file is never written over: it is copied aside once and left alone', () => {
  const { counters, file } = setup();
  fs.writeFileSync(file, '{ not json');
  assert.deepStrictEqual(counters.bump('git:opened'), { ok: false, reason: 'unreadable' });
  counters.bump('git:opened');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.strictEqual(fs.readFileSync(`${file}.bad`, 'utf8'), '{ not json');
  assert.strictEqual(counters.all(), null);
});

test('the wrong shape (an array, a bad entry for the key) is unreadable too, and untouched', () => {
  for (const content of ['[]', '"x"', JSON.stringify({ 'git:opened': { count: -1, last: 'x' } }), JSON.stringify({ 'git:opened': 5 })]) {
    const { counters, file } = setup();
    fs.writeFileSync(file, content);
    assert.strictEqual(counters.bump('git:opened').ok, false, content);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content);
  }
});

test('a failed write is reported and the file keeps its old content', () => {
  const { counters, store, file } = setup();
  counters.bump('git:opened');
  const before = fs.readFileSync(file, 'utf8');
  const broken = createUsageCounters({ store: { ...store, write() { throw new Error('EPERM'); } } });
  assert.deepStrictEqual(broken.bump('git:opened'), { ok: false, reason: 'write-failed' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('all() is {} for a missing file and null for an unreadable one', () => {
  const { counters, file } = setup();
  assert.deepStrictEqual(counters.all(), {});
  counters.bump('git:opened');
  fs.writeFileSync(file, 'garbage');
  assert.strictEqual(counters.all(), null);
});

test('PROPERTY: over any run of bumps, every count only goes up and equals the number of accepted bumps', () => {
  const keys = ['git:opened', 'ask:question', 'wand:click', 'panel:git', 'junk'];
  fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom(...keys), fc.integer({ min: 0, max: 3000 })), { maxLength: 25 }), (steps) => {
    const { counters, clock } = setup();
    const accepted = {};
    let prev = {};
    for (const [key, dt] of steps) {
      clock.advance(dt);
      const r = counters.bump(key);
      if (r.ok) accepted[key] = (accepted[key] || 0) + 1;
      const now = counters.all();
      for (const k of Object.keys(prev)) assert.ok(now[k].count >= prev[k].count);
      prev = now;
    }
    for (const k of Object.keys(accepted)) assert.strictEqual(prev[k].count, accepted[k]);
    assert.deepStrictEqual(Object.keys(prev).sort(), Object.keys(accepted).sort());
  }), { numRuns: 30 });
});

test('PROPERTY: a file the store can\'t read is byte-for-byte unchanged after any run of bumps', () => {
  const unreadable = fc.string({ maxLength: 40 }).filter((s) => {
    try { const v = JSON.parse(s); return v === null || typeof v !== 'object' || Array.isArray(v); } catch { return true; }
  });
  fc.assert(fc.property(unreadable, fc.array(fc.constantFrom('git:opened', 'wand:click'), { maxLength: 5 }), (content, bumps) => {
    const { counters, file } = setup();
    fs.writeFileSync(file, content);
    for (const k of bumps) counters.bump(k);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content);
  }), { numRuns: 30 });
});
