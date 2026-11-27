'use strict';
/**
 * startProject at the same time on one folder (single-instance PR 3 step 3): now that the claim runs before registry.add, two opens of one
 * project in flight would each build a window and the second registry.add would throw. They make ONE window and resolve to the same one.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createProjectRegistry } = require('../app/project-registry');
const { createProjectLifecycle } = require('../app/project-lifecycle');

function rig() {
  const registry = createProjectRegistry();
  const made = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const lc = createProjectLifecycle({
    registry,
    rootOf: (cwd) => cwd.replace(/[\\/](dev|feat-\w+)$/, ''),
    makeWindow: (cwd) => {
      const pw = {
        root: cwd.replace(/[\\/](dev|feat-\w+)$/, ''), label: 'p', win: null, log: [],
        claim: { run: async () => { await gate; return 'proceed'; }, markReady() {}, stop() {} },
        async start() { return { started: true }; }, startPoll() {}, dispose() {}, focusWindow() { this.log.push('focus'); }, showLane(c) { this.log.push(['lane', c]); },
      };
      made.push(pw);
      return pw;
    },
    makeRecord() {}, stopRecord() {}, makeUnits() {}, dropUnits() {}, dropWatch() {}, dropExit() {}, getAppStart: () => null, log() {},
  });
  return { lc, registry, made, release };
}

test('two startProject calls on one folder at the same time make one window and resolve to the same one', async () => {
  const t = rig();
  const a = t.lc.startProject('C:/p/dev');
  const b = t.lc.startProject('C:/p/dev');
  t.release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(t.made.length, 1, 'one window built');
  assert.strictEqual(ra.pw, rb.pw);
  assert.strictEqual(t.registry.size(), 1);
});

test('two opens of one project from two of its folders in flight: one window, and the second open\'s lane is shown on it', async () => {
  const t = rig();
  const a = t.lc.startProject('C:/p/dev');
  const b = t.lc.startProject('C:/p/feat-a');
  t.release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(t.made.length, 1);
  assert.strictEqual(ra.pw, rb.pw);
  assert.deepStrictEqual(t.made[0].log, ['focus', ['lane', 'C:/p/feat-a']]);
});

test('opens of two projects at the same time are not merged', async () => {
  const t = rig();
  const a = t.lc.startProject('C:/p/dev');
  const b = t.lc.startProject('C:/q/dev');
  t.release();
  await Promise.all([a, b]);
  assert.strictEqual(t.made.length, 2);
  assert.strictEqual(t.registry.size(), 2);
});
