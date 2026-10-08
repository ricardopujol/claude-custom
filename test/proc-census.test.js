'use strict';
/**
 * verify/lib/proc-census.js (BACKLOG #74 A): the process-table reading the zombie probe measures with. Its tree rule
 * exists because of a measured accident (2026-10-07): a scratch script took "every process whose ppid is in the set"
 * as the launched app's tree, a recycled pid made ~100 unrelated, orphaned Electrons look like its children, and it
 * force-killed them. A parent pid is only a parent if the parent STARTED BEFORE the child.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const census = require('../verify/lib/proc-census');

const row = (pid, ppid, start, over = {}) => ({ pid, ppid, thr: 10, hnd: 300, privMB: 50, start: String(start), type: 'renderer', ...over });

test('type comes from --type=, a readable line without it is the main process, an unreadable one is "unreadable"', () => {
  assert.strictEqual(census.typeOf('"C:\\e.exe" --type=gpu-process --foo'), 'gpu-process');
  assert.strictEqual(census.typeOf('"C:\\e.exe" C:\\app'), 'main');
  assert.strictEqual(census.typeOf(''), 'unreadable');
  assert.strictEqual(census.typeOf(null), 'unreadable');
});

test('parseRows reads pid|ppid|threads|handles|privateMB|start|commandLine, keeping a "|" inside the command line', () => {
  const [r, ...rest] = census.parseRows('12|3|44|555|66|134000000000000001|"e.exe" --type=renderer --x=a|b\r\n\r\nnot a row\r\n');
  assert.deepStrictEqual(rest, []);
  assert.deepStrictEqual(r, { pid: 12, ppid: 3, thr: 44, hnd: 555, privMB: 66, start: '134000000000000001', type: 'renderer' });
});

test('zombie-shaped: one thread or fewer AND no handles', () => {
  assert.strictEqual(census.zombieShaped({ thr: 1, hnd: 0 }), true);
  assert.strictEqual(census.zombieShaped({ thr: 0, hnd: 0 }), true);
  assert.strictEqual(census.zombieShaped({ thr: 1, hnd: 1 }), false);
  assert.strictEqual(census.zombieShaped({ thr: 2, hnd: 0 }), false);
});

test('descendants: the root, its children and theirs', () => {
  const rows = [row(1, 99, 100), row(2, 1, 110), row(3, 2, 120), row(4, 77, 130)];
  assert.deepStrictEqual(census.descendantsOf(rows, 1, '100').map(r => r.pid).sort(), [1, 2, 3]);
});

test('descendants: a row whose recorded parent pid is the root\'s but which STARTED BEFORE the root is not a child (recycled pid)', () => {
  const rows = [row(1, 99, 200), row(2, 1, 210), row(5, 1, 150)];
  assert.deepStrictEqual(census.descendantsOf(rows, 1, '200').map(r => r.pid).sort(), [1, 2]);
});

test('descendants: the root must still be the process that started at the recorded time, or nothing is returned', () => {
  const rows = [row(1, 99, 200), row(2, 1, 210)];
  assert.deepStrictEqual(census.descendantsOf(rows, 1, '999'), []);
  assert.deepStrictEqual(census.descendantsOf(rows, 42, '200'), []);
});

test('descendants compares FILETIMEs as numbers, not text (a longer digit string is later)', () => {
  const rows = [row(1, 99, '99999999999999999'), row(2, 1, '100000000000000000')];
  assert.deepStrictEqual(census.descendantsOf(rows, 1, '99999999999999999').map(r => r.pid).sort(), [1, 2]);
});

test('PROPERTY: every descendant started no earlier than its parent, and the root is always included when it matches', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ ppid: fc.integer({ min: 1, max: 30 }), start: fc.integer({ min: 1, max: 1000 }) }), { minLength: 1, maxLength: 30 }),
    (specs) => {
      const rows = specs.map((s, i) => row(i + 1, s.ppid, s.start));
      const root = rows[0];
      const got = census.descendantsOf(rows, root.pid, root.start);
      assert.ok(got.some(r => r.pid === root.pid));
      const byPid = new Map(rows.map(r => [r.pid, r]));
      for (const r of got) {
        if (r.pid === root.pid) continue;
        assert.ok(BigInt(r.start) >= BigInt(byPid.get(r.ppid).start));
      }
    },
  ));
});

test('summarize: lifetime = first poll where the pid (with its start time) is no longer listed; still listed at the end = null', () => {
  const tracked = [row(1, 0, 100, { type: 'main', privMB: 80 }), row(2, 1, 110, { type: 'gpu-process', privMB: 200 }), row(3, 1, 111)];
  const polls = [
    { t: 1, rows: [row(1, 0, 100), row(2, 1, 110), row(3, 1, 111)] },
    { t: 2, rows: [row(1, 0, 100), row(2, 1, 110, { thr: 1, hnd: 0, privMB: 60 })] },
    { t: 4, rows: [row(1, 0, 100, { thr: 1, hnd: 0 }), row(2, 1, 110, { thr: 1, hnd: 0, privMB: 55 })] },
    { t: 9, rows: [row(1, 0, 100, { thr: 1, hnd: 0 })] },
  ];
  const s = census.summarize(tracked, polls);
  const by = Object.fromEntries(s.map(x => [x.pid, x]));
  assert.strictEqual(by[3].goneAfterS, 2);
  assert.strictEqual(by[2].goneAfterS, 9);
  assert.strictEqual(by[1].goneAfterS, null);
  assert.strictEqual(by[2].type, 'gpu-process');
  assert.strictEqual(by[2].zombieSeenS, 7, 'zombie-shaped from the poll at t=2 until it vanished at t=9');
  assert.strictEqual(by[2].lastPrivMB, 55);
  assert.strictEqual(by[1].zombieSeenS, 5, 'zombie-shaped from t=4 to the last poll at t=9');
});

test('summarize: a pid listed again with a DIFFERENT start time is a new process, so the tracked one is gone', () => {
  const tracked = [row(1, 0, 100)];
  const s = census.summarize(tracked, [{ t: 1, rows: [row(1, 0, 100)] }, { t: 2, rows: [row(1, 0, 555)] }]);
  assert.strictEqual(s[0].goneAfterS, 2);
});

test('queryRows: rows when the query ran to its END sentinel; null when it failed, timed out or was cut short', () => {
  const ok = (stdout) => () => ({ stdout, status: 0 });
  assert.deepStrictEqual(census.queryRows('electron.exe', { run: ok('1|0|5|9|10|100|"e" --type=gpu-process\r\nEND\r\n') }).map(r => r.type), ['gpu-process']);
  assert.deepStrictEqual(census.queryRows('electron.exe', { run: ok('END\r\n') }), []);
  assert.strictEqual(census.queryRows('electron.exe', { run: ok('1|0|5|9|10|100|x\r\n') }), null, 'no END: cut short');
  assert.strictEqual(census.queryRows('electron.exe', { run: () => ({ error: new Error('ETIMEDOUT'), stdout: 'END' }) }), null);
});

// ---- byType: the cross-cycle report of verify/probe-electron-zombies.js ------------------------------------------

const s = (type, goneAfterS, zombieSeenS = 0, privMBBefore = 50) => ({ pid: 1, type, privMBBefore, goneAfterS, zombieSeenS, lastPrivMB: 1 });

test('byType: per process type, how many, how many outlived the threshold, the longest stay, and those never seen to leave', () => {
  const r = census.byType([[s('main', 1), s('renderer', 12, 10), s('gpu-process', 3)], [s('renderer', null, 40), s('renderer', 2)]], { lingerS: 5 });
  assert.deepStrictEqual(r, {
    'gpu-process': { count: 1, lingered: 0, stillThere: 0, maxGoneAfterS: 3, maxZombieSeenS: 0 },
    main: { count: 1, lingered: 0, stillThere: 0, maxGoneAfterS: 1, maxZombieSeenS: 0 },
    renderer: { count: 3, lingered: 2, stillThere: 1, maxGoneAfterS: 12, maxZombieSeenS: 40 },
  });
});

test('byType: exactly the threshold is not lingering; no cycles is an empty report', () => {
  assert.strictEqual(census.byType([[s('main', 5)]], { lingerS: 5 }).main.lingered, 0);
  assert.deepStrictEqual(census.byType([], { lingerS: 5 }), {});
});

test('byType (property): lingered = stillThere + those gone after the threshold, and never exceeds count', () => {
  const sumArb = fc.record({ type: fc.constantFrom('main', 'renderer', 'gpu-process', 'utility'),
    goneAfterS: fc.option(fc.integer({ min: 0, max: 120 }), { nil: null }), zombieSeenS: fc.integer({ min: 0, max: 120 }) });
  fc.assert(fc.property(fc.array(fc.array(sumArb, { maxLength: 8 }), { maxLength: 6 }), fc.integer({ min: 0, max: 60 }), (cycles, lingerS) => {
    const r = census.byType(cycles.map(c => c.map(x => s(x.type, x.goneAfterS, x.zombieSeenS))), { lingerS });
    const flat = cycles.flat();
    for (const [type, v] of Object.entries(r)) {
      const mine = flat.filter(x => x.type === type);
      assert.strictEqual(v.count, mine.length);
      assert.strictEqual(v.stillThere, mine.filter(x => x.goneAfterS === null).length);
      assert.strictEqual(v.lingered, mine.filter(x => x.goneAfterS === null || x.goneAfterS > lingerS).length);
      assert.ok(v.lingered <= v.count);
    }
    assert.strictEqual(Object.values(r).reduce((a, v) => a + v.count, 0), flat.length);
  }));
});

// ---- start times from two sources: Get-Process (100 ns) vs CIM CreationDate (whole microseconds) -----------------

test('sameStart: a Get-Process FILETIME and the CIM one for the same process (truncated to the microsecond) match', () => {
  // Measured 2026-10-08 on one process: Get-Process 134359518853898904, CIM 134359518853898900.
  assert.strictEqual(census.sameStart('134359518853898904', '134359518853898900'), true);
  assert.strictEqual(census.sameStart('134359518853898900', '134359518853898904'), true);
  assert.strictEqual(census.sameStart('134359518853898914', '134359518853898900'), false, 'a different microsecond is another process');
  assert.strictEqual(census.sameStart('x', '1'), false);
});

test('descendantsOf: the launcher\'s start time (Get-Process precision) finds the root in CIM rows', () => {
  const rows = [row(10, 1, '134359518853898900', { type: 'main' }), row(11, 10, '134359518853999900')];
  assert.deepStrictEqual(census.descendantsOf(rows, 10, '134359518853898904').map(r => r.pid), [10, 11]);
  assert.deepStrictEqual(census.descendantsOf(rows, 10, '134359518853998904'), [], 'another start is another process');
});
