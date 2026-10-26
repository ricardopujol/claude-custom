'use strict';
/**
 * host/dev-servers.js (BACKLOG #119 A4): the listener table, a worktree's port block, and the child-of-session join. Pure.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const ds = require('../host/dev-servers');
const { BLOCK, RANGE_START, RANGE_LAST_BASE } = require('../host/port-blocks');

const doc = (o) => `${JSON.stringify({ ok: true, ...o })}\nEND\n`;
const listener = (port, pid, addr = '127.0.0.1') => ({ port, pid, addr });
const proc = (pid, ppid, name, start = '100') => ({ pid, ppid, name, start });

// ---- parseTable -----------------------------------------------------------------------------------------------------------

test('parseTable reads the listeners and the process table', () => {
  const t = ds.parseTable(doc({ listeners: [listener(20003, 40)], procs: [proc(40, 4, 'node.exe')] }));
  assert.strictEqual(t.ok, true);
  assert.deepStrictEqual(t.listeners, [{ port: 20003, pid: 40, addr: '127.0.0.1' }]);
  assert.deepStrictEqual(t.procs, [{ pid: 40, ppid: 4, name: 'node.exe', start: '100' }]);
});

test('parseTable: one listener in the JSON may arrive as an object, not an array (PowerShell collapses a single element)', () => {
  const t = ds.parseTable(doc({ listeners: listener(20003, 40), procs: proc(40, 4, 'node.exe') }));
  assert.strictEqual(t.ok, true);
  assert.strictEqual(t.listeners.length, 1);
  assert.strictEqual(t.procs.length, 1);
});

test('parseTable: null for no listeners is an empty list, not a failure', () => {
  const t = ds.parseTable(doc({ listeners: null, procs: [] }));
  assert.strictEqual(t.ok, true);
  assert.deepStrictEqual(t.listeners, []);
});

test('parseTable refuses what is not the document: no sentinel, bad JSON, wrong shape', () => {
  for (const bad of [null, undefined, 42, '', 'END\n', '{"listeners":[]}', 'not json\nEND\n', '[]\nEND\n', '"x"\nEND\n', '{"x":1}\nEND\n']) {
    assert.strictEqual(ds.parseTable(bad).ok, false, String(bad));
  }
});

test('parseTable drops rows with a port or pid that is not a strict integer, and keeps the rest', () => {
  const t = ds.parseTable(doc({
    listeners: [listener(0, 1), listener(65536, 1), listener('3000', 1), listener(3000, -1), listener(3000, '5'), listener(null, 1), listener(1.5, 1),
      { port: 3000, pid: 7 }, listener(3000, 7, 42), listener(20001, 7)],
    procs: [],
  }));
  assert.deepStrictEqual(t.listeners.map(l => [l.port, l.pid]), [[20001, 7]]);
});

test('parseTable keeps only listeners another program on this computer can reach by localhost', () => {
  const t = ds.parseTable(doc({
    listeners: [listener(1001, 1, '127.0.0.1'), listener(1002, 1, '::1'), listener(1003, 1, '0.0.0.0'), listener(1004, 1, '::'), listener(1005, 1, '192.168.1.5'), listener(1006, 1, 'fe80::1')],
    procs: [],
  }));
  assert.deepStrictEqual(t.listeners.map(l => l.port), [1001, 1002, 1003, 1004]);
});

test('parseTable lists a port once, however many addresses or families it is listening on', () => {
  const t = ds.parseTable(doc({ listeners: [listener(3000, 9, '::'), listener(3000, 9, '0.0.0.0'), listener(3000, 9, '127.0.0.1')], procs: [] }));
  assert.strictEqual(t.listeners.length, 1);
});

test('parseTable drops a process row without integer pids or a string name', () => {
  const t = ds.parseTable(doc({ listeners: [], procs: [proc(1, 0, 'a.exe'), proc('2', 0, 'b.exe'), proc(3, null, 'c.exe'), { pid: 4, ppid: 0, name: 7 }] }));
  assert.deepStrictEqual(t.procs.map(p => p.pid), [1]);
});

// ---- the block ------------------------------------------------------------------------------------------------------------

test('inBlock: base <= port < base + BLOCK', () => {
  assert.strictEqual(ds.inBlock(20000, 20000), true);
  assert.strictEqual(ds.inBlock(20099, 20000), true);
  assert.strictEqual(ds.inBlock(20100, 20000), false);
  assert.strictEqual(ds.inBlock(19999, 20000), false);
});

test('inBlock is false for a worktree with no block, and for anything that is not an integer', () => {
  assert.strictEqual(ds.inBlock(20001, null), false);
  assert.strictEqual(ds.inBlock(20001, undefined), false);
  assert.strictEqual(ds.inBlock(20001, '20000'), false);
  assert.strictEqual(ds.inBlock('20001', 20000), false);
  assert.strictEqual(ds.inBlock(20001.5, 20000), false);
  assert.strictEqual(ds.inBlock(NaN, 20000), false);
  assert.strictEqual(ds.inBlock(20001, 20050), false, 'not a block start');
});

test('property: a port is in the block iff base <= port < base + BLOCK', () => {
  const base = fc.integer({ min: 0, max: (RANGE_LAST_BASE - RANGE_START) / BLOCK }).map(i => RANGE_START + i * BLOCK);
  fc.assert(fc.property(base, fc.integer({ min: 1, max: 65535 }), (b, port) => ds.inBlock(port, b) === (port >= b && port < b + BLOCK)), { numRuns: 1000 });
});

test('property: exactly BLOCK ports of 1-65535 are in any valid block', () => {
  const base = fc.integer({ min: 0, max: (RANGE_LAST_BASE - RANGE_START) / BLOCK }).map(i => RANGE_START + i * BLOCK);
  fc.assert(fc.property(base, (b) => {
    let n = 0;
    for (let p = b - 5; p < b + BLOCK + 5; p++) if (ds.inBlock(p, b)) n++;
    return n === BLOCK;
  }), { numRuns: 200 });
});

// ---- buildState -----------------------------------------------------------------------------------------------------------

test('buildState lists the block\'s listeners with the process name, sorted by port', () => {
  const s = ds.buildState({
    listeners: [listener(20007, 41), listener(20003, 40), listener(3000, 99)],
    procs: [proc(40, 4, 'node.exe'), proc(41, 4, 'python.exe'), proc(99, 4, 'other.exe')],
    base: 20000, hostPid: null,
  });
  assert.deepStrictEqual(s.inBlock, [{ port: 20003, pid: 40, name: 'node' }, { port: 20007, pid: 41, name: 'python' }]);
  assert.deepStrictEqual(s.outside, []);
  assert.strictEqual(s.base, 20000);
});

test('buildState: a port outside the block that a child of the session owns is listed, apart', () => {
  const s = ds.buildState({
    listeners: [listener(20003, 40), listener(5173, 51), listener(8080, 77)],
    procs: [proc(10, 1, 'node.exe', '100'), proc(11, 10, 'claude.exe', '110'), proc(51, 11, 'node.exe', '120'), proc(40, 51, 'node.exe', '130'), proc(77, 1, 'java.exe', '90')],
    base: 20000, hostPid: 10,
  });
  assert.deepStrictEqual(s.inBlock.map(r => r.port), [20003]);
  assert.deepStrictEqual(s.outside, [{ port: 5173, pid: 51, name: 'node' }], '8080 belongs to nobody in the session');
});

test('buildState: the session host itself is never listed as a dev server', () => {
  const s = ds.buildState({
    listeners: [listener(7701, 10)], procs: [proc(10, 1, 'electron.exe', '100')], base: 20000, hostPid: 10,
  });
  assert.deepStrictEqual(s.outside, []);
  assert.deepStrictEqual(s.inBlock, []);
});

test('buildState: with no block and no host there is nothing to list, and it says so', () => {
  const s = ds.buildState({ listeners: [listener(3000, 5)], procs: [proc(5, 1, 'node.exe')], base: null, hostPid: null });
  assert.deepStrictEqual(s, { base: null, inBlock: [], outside: [] });
});

test('buildState: a process that is not in the table is named "unknown" (a listener can outlive its row), never dropped', () => {
  const s = ds.buildState({ listeners: [listener(20001, 555)], procs: [], base: 20000, hostPid: null });
  assert.deepStrictEqual(s.inBlock, [{ port: 20001, pid: 555, name: 'unknown' }]);
});

test('buildState: a process name is shown without .exe and is cut to a sane length', () => {
  const s = ds.buildState({ listeners: [listener(20001, 5)], procs: [proc(5, 1, 'A'.repeat(80) + '.EXE')], base: 20000, hostPid: null });
  assert.ok(s.inBlock[0].name.length <= 40);
  assert.doesNotMatch(s.inBlock[0].name, /\.exe$/i);
});

test('property: a port is never both inside and outside, and every inside port is in the block', () => {
  const lis = fc.array(fc.record({ port: fc.integer({ min: 1, max: 65535 }), pid: fc.integer({ min: 1, max: 30 }), addr: fc.constant('127.0.0.1') }), { maxLength: 20 });
  const procs = fc.array(fc.record({ pid: fc.integer({ min: 1, max: 30 }), ppid: fc.integer({ min: 0, max: 30 }), name: fc.constant('x.exe'), start: fc.integer({ min: 1, max: 99 }).map(String) }), { maxLength: 30 });
  fc.assert(fc.property(lis, procs, fc.constantFrom(20000, 20100, 48900), fc.option(fc.integer({ min: 1, max: 30 }), { nil: null }), (l, p, base, host) => {
    const s = ds.buildState({ listeners: l, procs: p, base, hostPid: host });
    const inside = new Set(s.inBlock.map(r => r.port));
    for (const r of s.inBlock) if (!ds.inBlock(r.port, base)) return false;
    for (const r of s.outside) if (inside.has(r.port) || ds.inBlock(r.port, base)) return false;
    return true;
  }), { numRuns: 500 });
});

// ---- cadence --------------------------------------------------------------------------------------------------------------

test('the sampling rule: every 10 s, only while some window is in view and a session exists', () => {
  assert.strictEqual(ds.INTERVAL_MS, 10000);
  assert.strictEqual(ds.wanted({ minimised: false, tabs: 1 }), true);
  assert.strictEqual(ds.wanted({ minimised: true, tabs: 1 }), false);
  assert.strictEqual(ds.wanted({ minimised: false, tabs: 0 }), false);
  assert.strictEqual(ds.wanted({ minimised: undefined, tabs: 1 }), false, 'only a real false counts as in view');
  assert.strictEqual(ds.wanted({}), false);
});

test('the script prints the sentinel last and leaves no variable behind (the shell keeps state between calls)', () => {
  assert.match(ds.SCRIPT, /^& \{/m);
  assert.match(ds.SCRIPT.trim(), /'END'\s*\}$/);
  assert.match(ds.SCRIPT, /NETSTAT.EXE/);
  assert.doesNotMatch(ds.SCRIPT, /Get-NetTCPConnection/, "961 ms a call, against netstat 8 ms (measured)");
});

test('unseen: a window nobody can see (minimised, hidden to the tray, or not there yet) takes no samples', () => {
  assert.strictEqual(ds.unseen({ visible: true, minimized: false }), false);
  assert.strictEqual(ds.unseen({ visible: true, minimized: true }), true);
  assert.strictEqual(ds.unseen({ visible: false, minimized: false }), true, 'hidden to the tray');
  assert.strictEqual(ds.unseen({ visible: false, minimized: true }), true);
  for (const bad of [undefined, {}, null, { visible: 1, minimized: false }, { visible: true }]) assert.strictEqual(ds.unseen(bad), true, 'only real booleans count as in view');
});

// ---- PR #198 fix pass: a failed query is unknown, never "0 listeners" (Dexter 4) -------------------------------------------------

test('parseTable: a document the script marked ok:false, or did not mark at all, is not a table', () => {
  const body = { listeners: [], procs: [] };
  assert.strictEqual(ds.parseTable(`${JSON.stringify({ ok: false, ...body })}\nEND\n`).ok, false);
  assert.strictEqual(ds.parseTable(`${JSON.stringify(body)}\nEND\n`).ok, false, 'no ok field: an older or damaged script');
  assert.strictEqual(ds.parseTable(`${JSON.stringify({ ok: 'true', ...body })}\nEND\n`).ok, false, 'only a real true');
  assert.strictEqual(ds.parseTable(`${JSON.stringify({ ok: true, ...body })}\nEND\n`).ok, true);
});

test('the script reports failure of either half and reads the process table only when forced or an owner is unknown (Miguel Y2)', () => {
  assert.ok(ds.SCRIPT.includes('$good = $false'));
  assert.ok(ds.SCRIPT.includes('ok=$good'));
  assert.ok(ds.SCRIPT.includes('$fresh = ($force -or $unknown.Count -gt 0)'));
  assert.ok(ds.scriptFor({ pairs: [{ pid: 1, port: 80 }, { pid: 2, port: 443 }], force: false }).includes("$pairs = @('1:80','2:443')\n  $force = $false"));
  assert.ok(ds.scriptFor({ force: true }).includes('$pairs = @()\n  $force = $true'));
  // only integers are written into the script
  const dirty = [{ pid: 3, port: 80 }, { pid: '4); calc', port: 1 }, { pid: -1, port: 5 }, { pid: 1.5, port: 5 }, { pid: 7, port: 0 }, { pid: 7, port: 65536 }, null, { pid: 8, port: 9000 }];
  assert.ok(ds.scriptFor({ pairs: dirty }).includes("$pairs = @('3:80','8:9000')"));
});
