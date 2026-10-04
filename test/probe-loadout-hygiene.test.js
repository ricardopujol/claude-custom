'use strict';
/**
 * PR #68, Miguel B1 / S4: verify/probe-loadout.js must leave the user's REAL
 * `.harness/state/loadout.json` exactly as it found it -- on the normal path
 * and on the emergency (Ctrl+C) path -- and must kill the trees it spawned.
 * Tested on the helpers, not by delivering SIGINT to the test process.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('./tmp-dir');
const { snapshotFile } = require('../verify/lib/file-snapshot');
const { createHygieneRegistry } = require('../verify/lib/process-hygiene');

const BELT = '{"agents":{"code-reviewer":["pace-sonnet"]}}';

test('snapshot then restore puts back byte-identical content, including odd bytes', () => {
  const file = path.join(tmpDir('cc-snap-'), 'loadout.json');
  const original = Buffer.concat([Buffer.from(BELT), Buffer.from([0x0d, 0x0a, 0xff, 0x00])]);
  fs.writeFileSync(file, original);
  const snap = snapshotFile(file);
  fs.writeFileSync(file, '{"agents":{"code-reviewer":["pace-opus"]}}');
  assert.strictEqual(snap.restore(), true);
  assert.ok(fs.readFileSync(file).equals(original));
});

test('a file that did not exist is removed again on restore', () => {
  const file = path.join(tmpDir('cc-snap-'), 'loadout.json');
  const snap = snapshotFile(file);
  assert.strictEqual(snap.existed, false);
  fs.writeFileSync(file, BELT);
  snap.restore();
  assert.strictEqual(fs.existsSync(file), false);
});

test('a file that was deleted meanwhile is recreated', () => {
  const file = path.join(tmpDir('cc-snap-'), 'loadout.json');
  fs.writeFileSync(file, BELT);
  const snap = snapshotFile(file);
  fs.unlinkSync(file);
  snap.restore();
  assert.strictEqual(fs.readFileSync(file, 'utf8'), BELT);
});

test('restore is idempotent, leaves no temp file, and never throws', () => {
  const dir = tmpDir('cc-snap-');
  const file = path.join(dir, 'loadout.json');
  fs.writeFileSync(file, BELT);
  const snap = snapshotFile(file);
  snap.restore();
  fs.writeFileSync(file, 'changed after restore');
  assert.strictEqual(snap.restore(), true, 'a second restore is a no-op');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'changed after restore');
  assert.deepStrictEqual(fs.readdirSync(dir), ['loadout.json']);
  // A directory that no longer exists: false, not an exception.
  const gone = snapshotFile(path.join(dir, 'x', 'y.json'));
  fs.writeFileSync(path.join(dir, 'z'), 'q');
  assert.doesNotThrow(() => snapshotFile(path.join(dir, 'nope', 'q.json')).restore());
  assert.ok(gone);
});

test('the emergency path restores the file AFTER killing the trees', () => {
  // Order matters: a host still alive could rewrite the file being restored.
  const file = path.join(tmpDir('cc-snap-'), 'loadout.json');
  fs.writeFileSync(file, BELT);
  const snap = snapshotFile(file);
  const order = [];
  const registry = createHygieneRegistry({ killFn: (pid) => order.push(`kill ${pid}`) });
  registry.registerSpawnedTree(4242);
  registry.addCleanup(() => { order.push('restore'); snap.restore(); });
  fs.writeFileSync(file, '{"agents":{"code-reviewer":["pace-opus"]}}');   // the probe's belt

  registry._emergencyCleanup('SIGINT');

  assert.deepStrictEqual(order, ['kill 4242', 'restore']);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), BELT, 'the real belt is back after Ctrl+C');
});

test('a throwing extra cleanup does not stop the others', () => {
  const registry = createHygieneRegistry({ killFn: () => {} });
  const ran = [];
  registry.addCleanup(() => { throw new Error('boom'); });
  registry.addCleanup(() => ran.push('second'));
  assert.doesNotThrow(() => registry._emergencyCleanup('test'));
  assert.deepStrictEqual(ran, ['second']);
});

test('removeCleanup takes a cleanup back out', () => {
  const registry = createHygieneRegistry({ killFn: () => {} });
  const ran = [];
  const fn = () => ran.push('x');
  registry.addCleanup(fn);
  registry.removeCleanup(fn);
  registry._emergencyCleanup('test');
  assert.deepStrictEqual(ran, []);
});
