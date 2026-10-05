'use strict';
/** host/chip-store.js (PR #113 Q2, review D8 / Miguel I4): the chip's saved on/off, against the REAL store on a temp dir. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createStore } = require('../host/store');
const { createChipStore, watchChip, KEY } = require('../host/chip-store');
const { tmpDir } = require('./tmp-dir');

const rig = () => {
  const dir = tmpDir('cc-chip-');
  const store = createStore({ dir });
  return { dir, store, chip: createChipStore(store), file: path.join(dir, `${KEY}.json`) };
};

test('nothing stored reads as null (the caller turns that into ON), a written value round-trips', () => {
  const { chip } = rig();
  assert.strictEqual(chip.read(), null);
  chip.write(false);
  assert.strictEqual(chip.read(), false);
  chip.write(true);
  assert.strictEqual(chip.read(), true);
});

test('a corrupt file reads as null, and a write replaces it', () => {
  const { chip, file } = rig();
  fs.writeFileSync(file, '{ not json');
  assert.strictEqual(chip.read(), null);
  chip.write(false);
  assert.strictEqual(chip.read(), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { show: false });
});

test('a stored value that is not a real boolean reads as null', () => {
  const { chip, file } = rig();
  for (const bad of ['{"show":"false"}', '{"show":0}', '{"show":null}', '{}', '[]', 'null', '"x"', '{"hide":true}']) {
    fs.writeFileSync(file, bad);
    assert.strictEqual(chip.read(), null, bad);
  }
});

test('a store that throws reads as null instead of raising', () => {
  const chip = createChipStore({ read: () => { throw new Error('EBUSY'); }, update: () => {} });
  assert.strictEqual(chip.read(), null);
});

test('watch: every change of the file calls onChange, a throwing listener is contained, and stop() unwatches', () => {
  const handlers = [];
  const unwatched = [];
  const calls = [];
  const stop = watchChip({
    file: 'f.json', onChange: () => { calls.push(1); throw new Error('window gone'); },
    watchFile: (file, opts, fn) => { handlers.push({ file, opts, fn }); }, unwatchFile: (file, fn) => unwatched.push([file, fn]),
  });
  assert.strictEqual(handlers.length, 1);
  assert.strictEqual(handlers[0].file, 'f.json');
  assert.strictEqual(handlers[0].opts.persistent, false);
  handlers[0].fn();
  handlers[0].fn();
  assert.strictEqual(calls.length, 2);
  stop();
  assert.deepStrictEqual(unwatched, [['f.json', handlers[0].fn]]);
});
