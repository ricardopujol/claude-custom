'use strict';
/**
 * verify/reap-probes.js (BACKLOG #74 B): kills only ledger PIDs whose start time still matches and whose launcher is
 * gone. Never by name. The selection itself is pinned in test/pid-ledger.test.js; this pins what the reaper DOES with it.
 */
const test = require('node:test');
const assert = require('node:assert');
const { tmpDir } = require('./tmp-dir');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('../host/pid-ledger');
const { reap } = require('../verify/reap-probes');

const E = (pid, over = {}) => ({ pid, start: `S${pid}`.replace('S', '1'), launcher: { pid: 9000 + pid, start: '2' }, kind: 'probe-window', label: 'p', createdAt: 1, ...over });

function setup(entries) {
  const dir = tmpDir('cc-reap-test-');
  const file = path.join(dir, 'l.jsonl');
  for (const e of entries) ledger.appendEntry(file, e);
  return { dir, file };
}

test('kills a recorded process whose start matches and whose launcher is gone, and removes its line', async () => {
  const { dir, file } = setup([E(10)]);
  try {
    const killed = [];
    const r = await reap({ file, startTimes: async () => new Map([[10, '110']].filter(([p]) => !killed.includes(p))), kill: (p) => killed.push(p), dryRun: false });
    assert.deepStrictEqual(killed, [10]);
    assert.deepStrictEqual(r.killed, [10]);
    assert.deepStrictEqual(ledger.readLedger(file), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a reused pid (start differs) is not killed, and its stale line is dropped', async () => {
  const { dir, file } = setup([E(10)]);
  try {
    const killed = [];
    await reap({ file, startTimes: async () => new Map([[10, 'other']]), kill: (p) => killed.push(p), dryRun: false });
    assert.deepStrictEqual(killed, []);
    assert.deepStrictEqual(ledger.readLedger(file), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a live launcher protects its Electron; the line stays', async () => {
  const { dir, file } = setup([E(10, { start: '5', launcher: { pid: 99, start: '6' } })]);
  try {
    const killed = [];
    await reap({ file, startTimes: async () => new Map([[10, '5'], [99, '6']]), kill: (p) => killed.push(p), dryRun: false });
    assert.deepStrictEqual(killed, []);
    assert.strictEqual(ledger.readLedger(file).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed start-time query kills nothing and touches nothing', async () => {
  const { dir, file } = setup([E(10)]);
  try {
    const killed = [];
    const r = await reap({ file, startTimes: async () => null, kill: (p) => killed.push(p), dryRun: false });
    assert.deepStrictEqual(killed, []);
    assert.strictEqual(r.verified, false);
    assert.strictEqual(ledger.readLedger(file).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dry run reports what it would kill and kills nothing, removes nothing', async () => {
  const { dir, file } = setup([E(10, { start: '5', launcher: { pid: 9990, start: '1' } })]);
  try {
    const killed = [];
    const r = await reap({ file, startTimes: async () => new Map([[10, '5']]), kill: (p) => killed.push(p), dryRun: true });
    assert.deepStrictEqual(killed, []);
    assert.deepStrictEqual(r.wouldKill, [10]);
    assert.strictEqual(ledger.readLedger(file).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the reaper asks for the start times of the entries AND their launchers, in one query', async () => {
  const { dir, file } = setup([E(10), E(11)]);
  try {
    let asked = null;
    let calls = 0;
    await reap({ file, startTimes: async (pids) => { calls++; asked = pids.slice().sort((a, b) => a - b); return new Map(); }, kill: () => {}, dryRun: true });
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(asked, [10, 11, 9010, 9011]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a kill that throws does not stop the others, and the survivor keeps its line', async () => {
  const { dir, file } = setup([E(10, { start: '5', launcher: { pid: 9990, start: '1' } }), E(11, { start: '6', launcher: { pid: 9990, start: '1' } })]);
  try {
    const killed = [];
    const r = await reap({
      file, startTimes: async () => new Map([[10, '5'], [11, '6']]), dryRun: false,
      kill: (p) => { if (p === 10) throw new Error('denied'); killed.push(p); },
      stillRunning: async (pids) => new Set(pids.filter(p => p === 10)),
    });
    assert.deepStrictEqual(killed, [11]);
    assert.deepStrictEqual(r.failed, [10]);
    assert.deepStrictEqual(ledger.readLedger(file).map(e => e.pid), [10]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
