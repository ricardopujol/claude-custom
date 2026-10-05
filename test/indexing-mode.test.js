'use strict';
/**
 * Propose or direct (host/indexing-mode.js, backlog #66, DESIGN_INDEXING_ASSISTANT.md "Accuracy gate"): direct filing
 * only once a measurement passed the bar, and a setting can hold it in propose mode anyway.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const m = require('../host/indexing-mode');

test('the recorded measurement: llama3.2:3b, 2026-10-05, below the bar, so it did not pass', () => {
  assert.strictEqual(m.MEASURED.model, 'llama3.2:3b');
  assert.strictEqual(m.MEASURED.passed, false);
  assert.strictEqual(m.MEASURED.right, 30);
  assert.strictEqual(m.MEASURED.total, 46);
  assert.strictEqual(m.MEASURED.swaps, 4);
});

test('modeFor: direct only when the measurement passed and nothing holds it back', () => {
  const passed = { passed: true };
  assert.strictEqual(m.modeFor(passed, {}), 'direct');
  assert.strictEqual(m.modeFor(passed, { proposeOnly: true }), 'propose');
  assert.strictEqual(m.modeFor({ passed: false }, {}), 'propose');
  assert.strictEqual(m.modeFor(null, {}), 'propose');
  assert.strictEqual(m.modeFor({ passed: 'yes' }, {}), 'propose', 'only a real true passes');
});

test('modeFor: only a real true in the setting holds it; a missing or odd setting does not', () => {
  const passed = { passed: true };
  for (const s of [null, undefined, { proposeOnly: 'true' }, { proposeOnly: 1 }, []]) assert.strictEqual(m.modeFor(passed, s), 'direct', JSON.stringify(s));
});

test('readSettings: the JSON file, or {} when it is missing or broken', () => {
  const dir = tmpDir('cc-im-');
  const f = path.join(dir, 'indexing-settings.json');
  assert.deepStrictEqual(m.readSettings(f), {});
  fs.writeFileSync(f, '{"proposeOnly": true}');
  assert.deepStrictEqual(m.readSettings(f), { proposeOnly: true });
  fs.writeFileSync(f, 'nope');
  assert.deepStrictEqual(m.readSettings(f), {});
  fs.writeFileSync(f, '[1]');
  assert.deepStrictEqual(m.readSettings(f), {});
});
