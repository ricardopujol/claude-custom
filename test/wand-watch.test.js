'use strict';
/**
 * host/wand-watch.js: tell this host when the wand's state file, or a skills directory, changes
 * underneath it. The loadout-watch pattern (watch the DIRECTORY, filter, debounce, re-arm), plus the two
 * things a skills directory needs that the state dir doesn't: it may not exist yet and must never be
 * CREATED by watching it (it is the CLI's own, in ~/.claude or the project), and it is recursive.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('node:events');

const { tmpDir } = require('./tmp-dir');
const { watchDir } = require('../host/wand-watch');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fakeWatch() {
  const calls = [];
  const watch = (dir, opts, cb) => {
    const w = new EventEmitter();
    w.closed = false;
    w.close = () => { w.closed = true; };
    w.cb = cb;
    w.dir = dir;
    w.opts = opts;
    calls.push(w);
    return w;
  };
  return { watch, calls };
}

test('a real write to the watched file fires onChange once, however many events it made', async () => {
  const dir = tmpDir('cc-ww-');
  let n = 0;
  const w = watchDir({ dir, match: f => f === 'wand.json', create: true, onChange: () => { n++; }, debounceMs: 60 });
  try {
    await sleep(100);
    fs.writeFileSync(path.join(dir, 'wand.json'), '1');
    fs.writeFileSync(path.join(dir, 'wand.json'), '2');
    await sleep(800);
    assert.strictEqual(n, 1);
  } finally { w.close(); }
});

test('another file does not fire it; a null filename (some platforms) does', async () => {
  const { watch, calls } = fakeWatch();
  let n = 0;
  const w = watchDir({ dir: tmpDir('cc-ww-'), match: f => f === 'wand.json', onChange: () => { n++; }, debounceMs: 10, watch });
  calls[0].cb('change', 'cooldowns.json');
  calls[0].cb('change', 'wand.json.tmp1');
  await sleep(40);
  assert.strictEqual(n, 0);
  calls[0].cb('change', null);
  await sleep(40);
  calls[0].cb('rename', 'wand.json');
  await sleep(40);
  w.close();
  assert.strictEqual(n, 2);
});

test('the filter sees a Buffer filename as its string', async () => {
  const { watch, calls } = fakeWatch();
  let n = 0;
  const w = watchDir({ dir: tmpDir('cc-ww-'), match: f => f === 'wand.json', onChange: () => { n++; }, debounceMs: 10, watch });
  calls[0].cb('change', Buffer.from('wand.json'));
  await sleep(40);
  w.close();
  assert.strictEqual(n, 1);
});

test('create:true makes the state dir; create:false (the default) never creates a directory', () => {
  const root = tmpDir('cc-ww-');
  const made = path.join(root, 'state');
  const left = path.join(root, 'skills');
  const a = watchDir({ dir: made, match: () => true, create: true, onChange() {}, rearmMs: 50 });
  const b = watchDir({ dir: left, match: () => true, onChange() {}, rearmMs: 50 });
  try {
    assert.ok(fs.existsSync(made), 'the state dir is ours to make');
    assert.ok(!fs.existsSync(left), "a directory that is the CLI's, never created by a watch");
  } finally { a.close(); b.close(); }
});

test('a directory that does not exist yet is picked up when it appears, and that fires onChange', async () => {
  const root = tmpDir('cc-ww-');
  const dir = path.join(root, 'skills');
  let n = 0;
  const w = watchDir({ dir, match: () => true, onChange: () => { n++; }, debounceMs: 20, rearmMs: 60 });
  try {
    await sleep(120);
    assert.strictEqual(n, 0);
    fs.mkdirSync(dir);
    await sleep(500);
    assert.ok(n >= 1, 'skills that were created after the host started are found');
    const before = n;
    fs.mkdirSync(path.join(dir, 'x'));
    fs.writeFileSync(path.join(dir, 'x', 'SKILL.md'), '---\nname: x\n---\n');
    await sleep(500);
    assert.ok(n > before, 'and a SKILL.md written inside it (recursive) is seen');
  } finally { w.close(); }
});

test('recursive is passed to the watch only when asked for', () => {
  const a = fakeWatch();
  const b = fakeWatch();
  const wa = watchDir({ dir: tmpDir('cc-ww-'), match: () => true, onChange() {}, watch: a.watch, recursive: true });
  const wb = watchDir({ dir: tmpDir('cc-ww-'), match: () => true, onChange() {}, watch: b.watch });
  wa.close(); wb.close();
  assert.strictEqual(a.calls[0].opts.recursive, true);
  assert.notStrictEqual(b.calls[0].opts.recursive, true);
});

test('a platform that refuses recursive watches falls back to a plain one, not to no watch', () => {
  const calls = [];
  const watch = (dir, opts, cb) => {
    calls.push(opts);
    if (opts.recursive) throw Object.assign(new Error('nope'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
    const w = new EventEmitter(); w.close = () => {}; w.cb = cb; return w;
  };
  const w = watchDir({ dir: tmpDir('cc-ww-'), match: () => true, onChange() {}, watch, recursive: true });
  w.close();
  assert.deepStrictEqual(calls.map(o => !!o.recursive), [true, false]);
});

test('a watcher error re-arms the watch and asks the caller to look again', async () => {
  const { watch, calls } = fakeWatch();
  let n = 0;
  const w = watchDir({ dir: tmpDir('cc-ww-'), match: () => true, onChange: () => { n++; }, debounceMs: 10, rearmMs: 30, watch });
  try {
    calls[0].emit('error', new Error('EPERM'));
    await sleep(150);
    assert.ok(calls[0].closed, 'the dead watcher is closed');
    assert.ok(calls.length >= 2, 're-armed');
    assert.ok(n >= 1, 'something may have changed while it was down');
  } finally { w.close(); }
});

test('close() stops everything: no event, no timer, no re-arm after it', async () => {
  const { watch, calls } = fakeWatch();
  let n = 0;
  const w = watchDir({ dir: tmpDir('cc-ww-'), match: () => true, onChange: () => { n++; }, debounceMs: 20, rearmMs: 20, watch });
  calls[0].cb('change', 'a');
  w.close();
  calls[0].emit('error', new Error('late'));
  await sleep(150);
  assert.strictEqual(n, 0);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].closed);
});

test('a throwing callback does not kill the watcher', async () => {
  const { watch, calls } = fakeWatch();
  let n = 0;
  const w = watchDir({ dir: tmpDir('cc-ww-'), match: () => true, onChange: () => { n++; throw new Error('boom'); }, debounceMs: 10, watch });
  calls[0].cb('change', 'a');
  await sleep(40);
  calls[0].cb('change', 'a');
  await sleep(40);
  w.close();
  assert.strictEqual(n, 2);
});

test('required options are checked, with a message that names the mistake', () => {
  assert.throws(() => watchDir({ match: () => true, onChange() {} }), /dir is required/);
  assert.throws(() => watchDir({ dir: 'x', match: () => true }), /onChange is required/);
  assert.throws(() => watchDir({ dir: 'x', onChange() {} }), /match is required/);
  assert.throws(() => watchDir(), /dir is required/);
});
