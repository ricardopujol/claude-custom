'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../host/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-'));

test('reading an absent file returns the default', () => {
  const s = createStore({ dir: tmp() });
  assert.deepStrictEqual(s.read('loadout', { agents: {} }), { agents: {} });
});

test('writes then reads back', () => {
  const s = createStore({ dir: tmp() });
  s.write('loadout', { agents: { miguel: ['whetstone'] } });
  assert.deepStrictEqual(s.read('loadout', {}), { agents: { miguel: ['whetstone'] } });
});

test('survives a process restart', () => {
  const dir = tmp();
  createStore({ dir }).write('stats', { runs: 3 });
  assert.deepStrictEqual(createStore({ dir }).read('stats', {}), { runs: 3 });
});

test('a corrupt file yields the default instead of throwing', () => {
  // One feature's state must not be able to take the session down. Everything
  // here is regenerable; none of it is worth an exception on a hot path.
  const dir = tmp();
  const s = createStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vault.json'), '{ not json');
  assert.deepStrictEqual(s.read('vault', { bugs: [] }), { bugs: [] });
});

test('one corrupt file does not affect the others', () => {
  // The reason for one file per concern rather than a single blob.
  const dir = tmp();
  const s = createStore({ dir });
  s.write('stats', { runs: 7 });
  fs.writeFileSync(path.join(dir, 'vault.json'), 'garbage');
  assert.deepStrictEqual(s.read('stats', {}), { runs: 7 });
});

test('writes atomically, so a crash mid-write cannot truncate the file', () => {
  // Observed earlier in this project: a hard exit truncated a file to zero
  // bytes straight after a synchronous write. A half-written JSON file reads
  // as corrupt and silently resets whatever feature owned it.
  const dir = tmp();
  const s = createStore({ dir });
  s.write('stats', { a: 1 });
  const before = fs.readFileSync(path.join(dir, 'stats.json'), 'utf8');
  s.write('stats', { a: 2 });
  const after = fs.readFileSync(path.join(dir, 'stats.json'), 'utf8');
  assert.notStrictEqual(before, after);
  assert.deepStrictEqual(JSON.parse(after), { a: 2 });
  // No temp files left lying around.
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => !f.endsWith('.json')), []);
});

test('creates its directory on demand', () => {
  const dir = path.join(tmp(), 'nested', 'deep');
  createStore({ dir }).write('stats', { ok: true });
  assert.ok(fs.existsSync(path.join(dir, 'stats.json')));
});

test('update applies a function to the current value', () => {
  const s = createStore({ dir: tmp() });
  s.write('stats', { runs: 1 });
  s.update('stats', { runs: 0 }, v => ({ runs: v.runs + 1 }));
  assert.strictEqual(s.read('stats', {}).runs, 2);
});

test('update on an absent file starts from the default', () => {
  const s = createStore({ dir: tmp() });
  s.update('stats', { runs: 0 }, v => ({ runs: v.runs + 1 }));
  assert.strictEqual(s.read('stats', {}).runs, 1);
});

test('a name that could escape the store directory is refused', () => {
  // Names may come from feature code and one day from config; a traversal here
  // would write outside the harness directory entirely.
  const dir = tmp();
  const s = createStore({ dir });
  assert.throws(() => s.write('../escape', { x: 1 }), /name/i);
  assert.throws(() => s.read('../../secrets', {}), /name/i);
});

test('exposes the path of a file for other processes to read', () => {
  // The hook helper reads loadout.json itself so items keep working with the
  // GUI closed, and it needs to be told where that is.
  const dir = tmp();
  const s = createStore({ dir });
  assert.strictEqual(s.pathOf('loadout'), path.join(dir, 'loadout.json'));
});
