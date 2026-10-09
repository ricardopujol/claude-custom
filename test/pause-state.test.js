'use strict';
/**
 * host/pause-state.js (BACKLOG #19): which processes the panel has paused. The state machine is small, so its invariants are
 * stated as properties: a process is paused at most once; Resume takes a paused process once; every pause ends in a Resume or
 * an explicit end (the process left, or its pid is another process now); nothing is ever "paused" that was not paused by us.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createPauseStore, keyOf } = require('../host/pause-state');

const proc = (pid, start) => ({ pid, ppid: 1, name: 'node.exe', cmd: null, start: String(start) });
const entry = (pid, start = 1000, extra = {}) => ({ pid, start: String(start), name: 'burn.js', pids: [{ pid, start: String(start) }], ...extra });

test('a pause is recorded with the time it was made, and found again by pid and start', () => {
  let t = 5000;
  const s = createPauseStore({ now: () => t });
  assert.deepStrictEqual(s.add(entry(10, 1000)), { ok: true, since: 5000 });
  assert.strictEqual(s.isPaused(10, '1000'), true);
  assert.strictEqual(s.isPaused(10, '1001'), false, 'another start is another process');
  assert.strictEqual(s.isPaused(11, '1000'), false);
  t = 9000;
  assert.deepStrictEqual(s.list(), [{ key: '10:1000', pid: 10, start: '1000', name: 'burn.js', since: 5000, pids: [{ pid: 10, start: '1000' }] }]);
});

test('pausing what is already paused is refused and keeps the first time', () => {
  let t = 1;
  const s = createPauseStore({ now: () => t });
  s.add(entry(10));
  t = 99;
  assert.deepStrictEqual(s.add(entry(10)), { ok: false, reason: 'already' });
  assert.strictEqual(s.list()[0].since, 1);
});

test('take hands a paused entry out once and only once', () => {
  const s = createPauseStore();
  s.add(entry(10));
  const got = s.take(10, '1000');
  assert.deepStrictEqual(got.pids, [{ pid: 10, start: '1000' }]);
  assert.strictEqual(s.take(10, '1000'), null);
  assert.strictEqual(s.isPaused(10, '1000'), false);
  assert.strictEqual(s.take(99, '1'), null);
});

test('restore puts a taken entry back (a resume that did not go through must stay paused, not be forgotten)', () => {
  const s = createPauseStore({ now: () => 7 });
  s.add(entry(10));
  const got = s.take(10, '1000');
  s.restore(got);
  assert.strictEqual(s.isPaused(10, '1000'), true);
  assert.strictEqual(s.list()[0].since, 7);
  assert.deepStrictEqual(s.add(entry(10)), { ok: false, reason: 'already' });
});

test('reconcile ends what left the process table, and what is another process now, and says which', () => {
  const s = createPauseStore();
  s.add(entry(10, 1000));
  s.add(entry(11, 2000));
  s.add(entry(12, 3000));
  const ended = s.reconcile([proc(10, 1000), proc(11, 2999999)]);
  assert.deepStrictEqual(ended.map(e => [e.pid, e.how]).sort(), [[11, 'reused'], [12, 'gone']]);
  assert.deepStrictEqual(s.list().map(e => e.pid), [10]);
});

test('reconcile accepts the one-tick difference between the two start-time sources', () => {
  const s = createPauseStore();
  s.add(entry(10, 134355977388659781));
  const ended = s.reconcile([proc(10, '134355977388659780')]);
  assert.deepStrictEqual(ended, []);
});

test('reconcile with no table (unreadable) ends nothing: not knowing is not a reason to forget', () => {
  const s = createPauseStore();
  s.add(entry(10));
  assert.deepStrictEqual(s.reconcile(null), []);
  assert.deepStrictEqual(s.reconcile('x'), []);
  assert.strictEqual(s.isPaused(10, '1000'), true);
});

test('keyOf joins pid and start; a bad pid or start has no key', () => {
  assert.strictEqual(keyOf(10, '1000'), '10:1000');
  assert.strictEqual(keyOf(0, '1000'), null);
  assert.strictEqual(keyOf(1.5, '1000'), null);
  assert.strictEqual(keyOf('10', '1000'), null);
  assert.strictEqual(keyOf(10, 1000), null);
  assert.strictEqual(keyOf(10, 'x'), null);
});

test('add refuses an entry that is not a proven process: no pid, no start, no suspended set', () => {
  const s = createPauseStore();
  for (const bad of [null, {}, { pid: 1 }, { pid: 1, start: 'x', pids: [] }, { pid: 1, start: '5' }, { pid: 1, start: '5', pids: [] }, { pid: 1, start: '5', pids: [{ pid: 2, start: '5' }] }]) {
    assert.deepStrictEqual(s.add(bad), { ok: false, reason: 'invalid' }, JSON.stringify(bad));
  }
  assert.deepStrictEqual(s.list(), []);
});

test('holdsAny: a process in the set of any paused entry is held, by pid AND start', () => {
  const s = createPauseStore();
  s.add({ pid: 10, start: '1', name: 'a', pids: [{ pid: 10, start: '1' }, { pid: 11, start: '2' }] });
  assert.strictEqual(s.holdsAny([{ pid: 11, start: '2' }]), true);
  assert.strictEqual(s.holdsAny([{ pid: 12, start: '3' }, { pid: 10, start: '1' }]), true);
  assert.strictEqual(s.holdsAny([{ pid: 11, start: '3' }]), false, 'another start is another process');
  assert.strictEqual(s.holdsAny([]), false);
  assert.strictEqual(s.holdsAny(null), false);
});

const multi = (root, kids, start = 1000) => ({ pid: root, start: String(start), name: 'sh', pids: [{ pid: root, start: String(start) }, ...kids.map(([pid, st]) => ({ pid, start: String(st) }))] });

test('reconcile is PER MEMBER (PR #158 Dexter 6): a root that left while a member is alive ends the entry WITH that member listed, to be woken', () => {
  const s = createPauseStore();
  s.add(multi(23, [[24, 2000]]));
  const ended = s.reconcile([proc(24, 2000)]);
  assert.strictEqual(ended.length, 1);
  assert.strictEqual(ended[0].pid, 23);
  assert.strictEqual(ended[0].how, 'gone');
  assert.deepStrictEqual(ended[0].alive, [{ pid: 24, start: '2000' }]);
  assert.deepStrictEqual(s.list(), []);
});

test('reconcile: a root whose pid is another process now ends as reused, its members still listed if alive with their proved starts', () => {
  const s = createPauseStore();
  s.add(multi(23, [[24, 2000], [25, 3000]]));
  const ended = s.reconcile([proc(23, 9999999999), proc(24, 2000), proc(25, 3999999999)]);
  assert.strictEqual(ended[0].how, 'reused');
  assert.deepStrictEqual(ended[0].alive, [{ pid: 24, start: '2000' }], 'a member whose pid was reused is not ours');
});

test('reconcile: a live root keeps its entry, narrowed to the members still alive; it ends only when none is', () => {
  const s = createPauseStore();
  s.add(multi(23, [[24, 2000]]));
  assert.deepStrictEqual(s.reconcile([proc(23, 1000)]), [], 'the child left, the root is still suspended');
  assert.deepStrictEqual(s.list()[0].pids, [{ pid: 23, start: '1000' }]);
  const ended = s.reconcile([]);
  assert.deepStrictEqual(ended.map(e => [e.pid, e.alive.length]), [[23, 0]]);
});

test('a narrowed entry (root gone from the set after a partial wake) is kept while its members live', () => {
  const s = createPauseStore();
  s.add(multi(23, [[24, 2000]]));
  const taken = s.take(23, '1000');
  s.restore({ ...taken, pids: [{ pid: 24, start: '2000' }] });
  assert.deepStrictEqual(s.reconcile([proc(23, 1000), proc(24, 2000)]), []);
  assert.deepStrictEqual(s.list()[0].pids, [{ pid: 24, start: '2000' }]);
  const ended = s.reconcile([proc(23, 1000)]);
  assert.deepStrictEqual(ended.map(e => e.how), ['gone'], 'the last member left');
});

test('add accepts a root-less set only when asked (the stuck members of a failed wake), and keeps a given time', () => {
  const s = createPauseStore({ now: () => 9 });
  const e = { pid: 23, start: '1000', name: 'sh', pids: [{ pid: 24, start: '2000' }] };
  assert.deepStrictEqual(s.add(e), { ok: false, reason: 'invalid' });
  assert.deepStrictEqual(s.add({ ...e, since: 4 }, { rootInSet: false }), { ok: true, since: 4 });
  assert.strictEqual(s.list()[0].since, 4);
});

test('onChange hears every change with the whole set, and a throwing listener never breaks the store', () => {
  const seen = [];
  const s = createPauseStore({ onChange: list => seen.push(list.map(e => e.pid)) });
  s.add(entry(10)); s.add(entry(11));
  const t = s.take(10, '1000');
  s.restore(t);
  s.reconcile([proc(10, 1000)]);
  s.reconcile([proc(10, 1000)]);        // nothing changed: no call
  assert.deepStrictEqual(seen, [[10], [10, 11], [11], [11, 10], [10]]);
  const bad = createPauseStore({ onChange() { throw new Error('disk full'); } });
  assert.deepStrictEqual(bad.add(entry(5)).ok, true);
});

// ---- the properties --------------------------------------------------------------------------------------------------

const opArb = fc.oneof(
  fc.record({ op: fc.constant('pause'), id: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ op: fc.constant('resume'), id: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ op: fc.constant('table'), alive: fc.subarray([1, 2, 3, 4, 5]), reused: fc.subarray([1, 2, 3, 4, 5]) }),
);

test('property: against a plain model, the store holds exactly the paused-and-not-yet-ended set, and every pause is accounted for once', () => {
  fc.assert(fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
    const s = createPauseStore();
    const model = new Set();
    const paused = [];     // every successful pause
    const ends = [];       // every end: resumed, gone, reused
    for (const o of ops) {
      if (o.op === 'pause') {
        const r = s.add(entry(o.id, o.id * 1000));
        assert.strictEqual(r.ok, !model.has(o.id), 'a second pause of the same process is refused');
        if (r.ok) { model.add(o.id); paused.push(o.id); }
      } else if (o.op === 'resume') {
        const got = s.take(o.id, String(o.id * 1000));
        assert.strictEqual(got !== null, model.has(o.id), 'resume works exactly on a paused process');
        if (got) { model.delete(o.id); ends.push(o.id); }
      } else {
        const table = o.alive.map(id => proc(id, o.reused.includes(id) ? id * 1000 + 5_000_000 : id * 1000));
        const ended = s.reconcile(table);
        for (const e of ended) {
          assert.ok(model.has(e.pid));
          assert.ok(e.how === 'gone' || e.how === 'reused');
          model.delete(e.pid); ends.push(e.pid);
        }
        for (const id of model) {
          assert.ok(o.alive.includes(id) && !o.reused.includes(id), 'what stays paused is alive and unchanged');
        }
      }
      assert.deepStrictEqual(s.list().map(e => e.pid).sort(), [...model].sort());
    }
    // Accounting: pauses = ends + still paused.
    assert.strictEqual(paused.length, ends.length + model.size);
  }), { numRuns: 300 });
});

test('property: with multi-member entries, a member that is alive (with its start) is never forgotten: it stays in an entry or comes back in `alive`', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ root: fc.integer({ min: 1, max: 3 }), kids: fc.subarray([11, 12, 13]) }), { minLength: 1, maxLength: 3 }),
    fc.array(fc.record({ alive: fc.subarray([1, 2, 3, 11, 12, 13]) }), { minLength: 1, maxLength: 6 }),
    (adds, tables) => {
      const s = createPauseStore();
      const members = new Set();
      for (const a of adds) {
        const kids = a.kids.filter(k => !members.has(k));
        if (members.has(a.root) || !s.add(multi(a.root, kids.map(k => [k, k * 1000]), a.root * 1000)).ok) continue;
        members.add(a.root); kids.forEach(k => members.add(k));
      }
      for (const t of tables) {
        const startOf = pid => (pid < 10 ? pid * 1000 : pid * 1000);
        const kept = new Set();
        const ended = s.reconcile(t.alive.map(pid => proc(pid, startOf(pid))));
        const woken = new Set(ended.flatMap(e => e.alive.map(m => m.pid)));
        for (const e of s.list()) for (const p of e.pids) kept.add(p.pid);
        for (const pid of members) {
          if (!t.alive.includes(pid)) { members.delete(pid); continue; }
          assert.ok(kept.has(pid) || woken.has(pid), 'member ' + pid + ' is alive and must be kept or handed back');
          if (woken.has(pid)) members.delete(pid);
        }
      }
    }), { numRuns: 300 });
});
