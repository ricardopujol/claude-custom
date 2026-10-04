'use strict';
/**
 * Kill test for host/summary-store.js, from Mortimer's gate on release PR #109 (survivor 9).
 *
 * put() refuses a hostile session id and that guard was pinned; get() has the same guard and nothing called it with a
 * hostile id. Without it get('../outside') reads `<dir>/../outside.json`: a file outside the store.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createSummaryStore } = require('../host/summary-store');

const REC = { text: 'Working on: x\nNext: y', model: 'llama3.2:3b', turnsSeen: 12, newestKey: 'uuid-9', at: 5000 };
const body = JSON.stringify(REC) + '\n';

test('get() never reads a file outside the store, or one named by something that is not a plain session id', () => {
  const root = tmpDir('sumstore-kills-');
  const dir = path.join(root, 'store');
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  // Valid records exactly where each hostile id would resolve to if the guard were gone.
  fs.writeFileSync(path.join(root, 'outside.json'), body);   // '../outside'
  fs.writeFileSync(path.join(dir, 'a', 'b.json'), body);     // 'a/b'
  fs.writeFileSync(path.join(dir, '.json'), body);           // ''
  fs.writeFileSync(path.join(dir, '7.json'), body);          // 7
  fs.writeFileSync(path.join(dir, 'null.json'), body);       // null
  fs.writeFileSync(path.join(dir, 'ok.json'), body);         // a real id, to prove the fixture is readable

  const s = createSummaryStore({ dir });
  assert.deepStrictEqual(s.get('ok'), { ...REC, stale: true });
  for (const hostile of ['../outside', 'a/b', '', 7, null, undefined, { toString: () => 'ok' }]) {
    assert.strictEqual(s.get(hostile), null, `get(${String(hostile && hostile.toString ? hostile : hostile)}) must be null`);
  }
});
