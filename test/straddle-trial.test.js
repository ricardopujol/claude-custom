'use strict';
/** PR #135 Dexter 1 + 4: the #73 probe's gates. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runTrial } = require('../verify/lib/straddle-trial');

const base = (over = {}) => {
  const kills = [];
  return {
    kills,
    args: {
      root: { pid: 77, exitCode: null, signalCode: null },
      exited: new Promise(() => {}),
      scanSleepers: () => [1, 2],
      kill: (pid) => kills.push(pid),
      sleep: async () => {},
      ...over,
    },
  };
};

test('a live root is killed once and the sleepers left afterwards are counted', async () => {
  let scans = 0;
  const { kills, args } = base({ scanSleepers: () => (++scans === 1 ? [1, 2, 3] : [9]) });
  assert.deepStrictEqual(await runTrial(args), { left: 1 });
  assert.deepStrictEqual(kills, [77]);
});

test('a root that exited before the kill is NOT tree-killed (its pid is free) and the trial is inconclusive (D1)', async () => {
  const root = { pid: 77, exitCode: null, signalCode: null };
  const { kills, args } = base({ root, sleep: async () => { root.exitCode = 0; } });   // it ends while the loop turns
  const r = await runTrial(args);
  assert.deepStrictEqual(kills, []);
  assert.ok(r.inconclusive && !('left' in r));
});

test('a root ended by a signal is not killed either', async () => {
  const { kills, args } = base({ root: { pid: 77, exitCode: null, signalCode: 'SIGKILL' } });
  assert.ok((await runTrial(args)).inconclusive);
  assert.deepStrictEqual(kills, []);
});

test('a scan that sees no sleeper before the kill makes the trial inconclusive, nothing is killed (D4)', async () => {
  const { kills, args } = base({ scanSleepers: () => [] });
  assert.ok((await runTrial(args)).inconclusive);
  assert.deepStrictEqual(kills, []);
});

test('the probe scans sleepers by a marker the spawner does not carry, and the spawner has no spawn cap', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'verify', 'probe-kill-tree-straddle.js'), 'utf8');
  assert.match(src, /cc73s-/);
  assert.doesNotMatch(src, /n >= 400/);
  assert.match(src, /runTrial\(/);
});

test('the #72 test scans sleepers by a marker its spawner does not carry, and its spawner cannot end inside the test (D4, D7)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'status-relay-process.test.js'), 'utf8');
  assert.match(src, /cc72s-/);
  assert.doesNotMatch(src, /n >= 400/);
  assert.match(src, /deadlineMs: SPAWNER_DEADLINE_MS/);   // the spawners outlive the tests' timeout (BACKLOG #72: they now wait out a loaded machine)
  assert.match(src, /TEST_MS = 600000;/);
  assert.match(src, /SPAWNER_DEADLINE_MS = TEST_MS \+ 100000;/);
});
