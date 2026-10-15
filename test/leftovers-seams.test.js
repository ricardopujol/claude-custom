'use strict';
/**
 * host/leftovers-seams.js: the two questions the Leftovers stop asks the OS right before it kills (PR #132 Dexter F1, F6).
 */
const test = require('node:test');
const assert = require('node:assert');

const { createSeams } = require('../host/leftovers-seams');

const seams = (map) => createSeams({ startTimes: async () => map, kill: () => 'killed', removeEntries: () => ({ ok: true }) });
const entry = (launcher) => ({ pid: 100, start: '5', launcher });

test('launcherGone: only a launcher pid that is not running at all is gone', async () => {
  assert.strictEqual(await seams(new Map()).launcherGone(entry({ pid: 9, start: '7' })), true);
});

test('launcherGone F1: a listed pid keeps the row, whatever its start (same, different, unreadable), and so does a recorded start of null', async () => {
  for (const listed of ['7', '8', null]) {
    assert.strictEqual(await seams(new Map([[9, listed]])).launcherGone(entry({ pid: 9, start: '7' })), false, `start ${listed}`);
  }
  assert.strictEqual(await seams(new Map([[9, '7']])).launcherGone(entry({ pid: 9, start: null })), false);
});

test('launcherGone: doubt keeps: no launcher, a bad pid, a failed query, a query that throws', async () => {
  assert.strictEqual(await seams(new Map()).launcherGone(entry(null)), false);
  assert.strictEqual(await seams(new Map()).launcherGone({ pid: 100, start: '5' }), false);
  assert.strictEqual(await seams(new Map()).launcherGone(entry({ pid: 0, start: '7' })), false);
  assert.strictEqual(await seams(null).launcherGone(entry({ pid: 9, start: '7' })), false);
  const throwing = createSeams({ startTimes: async () => { throw new Error('ps'); }, kill: () => {}, removeEntries: () => {} });
  await assert.rejects(() => throwing.launcherGone(entry({ pid: 9, start: '7' })), /ps/, 'a throw is the caller\'s to treat as "not proven"');
});

test('launcherGone asks about the launcher\'s pid, and only that', async () => {
  const asked = [];
  const s = createSeams({ startTimes: async (pids) => { asked.push(pids); return new Map(); }, kill: () => {}, removeEntries: () => {} });
  await s.launcherGone(entry({ pid: 9, start: '7' }));
  assert.deepStrictEqual(asked, [[9]]);
});

test('isRunning F6: the exact start is running; absent or another start is gone; unreadable or a failed query is unknown', async () => {
  assert.strictEqual(await seams(new Map([[100, '5']])).isRunning(100, '5'), true);
  assert.strictEqual(await seams(new Map()).isRunning(100, '5'), false);
  assert.strictEqual(await seams(new Map([[100, '6']])).isRunning(100, '5'), false);
  assert.strictEqual(await seams(new Map([[100, null]])).isRunning(100, '5'), null);
  assert.strictEqual(await seams(null).isRunning(100, '5'), null);
});

test('the kill and the tombstone writer pass through untouched', () => {
  const kill = () => 'killed';
  const removeEntries = () => ({ ok: true });
  const s = createSeams({ startTimes: async () => new Map(), kill, removeEntries });
  assert.strictEqual(s.kill, kill);
  assert.strictEqual(s.removeEntries, removeEntries);
});
