'use strict';
/**
 * BACKLOG #74 H: a probe that kills host pids it only READ (identity files, the app's state) holds no handle, so the
 * pid may be reused by the time it kills. createSeenPids records each pid's start time when first seen and ends it only
 * through killProven(pid, start) (the start proven on a held handle), never by pid alone.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createSeenPids } = require('../verify/lib/seen-pids');

const rig = (starts = {}) => {
  const proven = [];
  const seen = createSeenPids({ startOf: (pid) => starts[pid] || null, prove: (pid, start) => { proven.push([pid, start]); return 'killed'; } });
  return { seen, proven };
};

test('killAll ends each pid through the proven kill, with the start recorded when it was first seen', () => {
  const { seen, proven } = rig({ 10: '111', 11: '222' });
  seen.add(10);
  seen.add(11, '999');                       // an identity file's own recorded start wins over a fresh read
  seen.killAll();
  assert.deepStrictEqual(proven, [[10, '111'], [11, '999']]);
});

test('a pid first seen again later keeps its FIRST start (a reused pid must not adopt the newcomer)', () => {
  const starts = { 10: '111' };
  const { seen, proven } = rig(starts);
  seen.add(10);
  starts[10] = '555';                        // the pid is now another process
  seen.add(10);
  seen.killAll();
  assert.deepStrictEqual(proven, [[10, '111']]);
});

test('a pid whose start could not be read is never killed', () => {
  const { seen, proven } = rig({});
  seen.add(10);
  seen.killAll();
  assert.deepStrictEqual(proven, []);
});

test('invalid pids are ignored; killAll twice kills once', () => {
  const { seen, proven } = rig({ 10: '1' });
  seen.add(undefined); seen.add(0); seen.add(-3); seen.add('7'); seen.add(10);
  seen.killAll();
  seen.killAll();
  assert.deepStrictEqual(proven, [[10, '1']]);
});

test('kill(pid) ends just that recorded pid, once; an unrecorded pid is not touched', () => {
  const { seen, proven } = rig({ 10: '1', 11: '2' });
  seen.add(10); seen.add(11);
  seen.kill(10);
  seen.kill(10);
  seen.kill(99);
  seen.killAll();
  assert.deepStrictEqual(proven, [[10, '1'], [11, '2']]);
});

test('a throwing proven kill does not stop the rest', () => {
  const proven = [];
  const seen = createSeenPids({ startOf: () => '1', prove: (pid) => { if (pid === 10) throw new Error('x'); proven.push(pid); } });
  seen.add(10); seen.add(11);
  seen.killAll();
  assert.deepStrictEqual(proven, [11]);
});
