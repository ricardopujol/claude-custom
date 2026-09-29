'use strict';
/**
 * readMeta: the one place a subagent's `.meta.json` is read, with its failures
 * counted (shared by host/agent-stats.js and host/agent-log-session.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readMeta } = require('../host/transcripts');
const { tmpDir } = require('./tmp-dir');

function withMeta(content) {
  const dir = tmpDir();
  const jsonl = path.join(dir, 'agent-a.jsonl');
  fs.writeFileSync(jsonl, '');
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'agent-a.meta.json'), content);
  return jsonl;
}

test('a valid object is the meta, and not an error', async () => {
  assert.deepStrictEqual(await readMeta(withMeta('{"agentType":"x"}')), { meta: { agentType: 'x' }, error: false });
});

test('an ABSENT meta is ordinary: no meta, no error', async () => {
  assert.deepStrictEqual(await readMeta(withMeta(undefined)), { meta: null, error: false });
});

test('an existing meta that is not JSON, or not an object, is an ERROR', async () => {
  for (const bad of ['{nope', '', 'null', '0', '"s"', '[]', '[{"agentType":"x"}]']) {
    assert.deepStrictEqual(await readMeta(withMeta(bad)), { meta: null, error: true }, JSON.stringify(bad));
  }
});

test('an unreadable meta (a directory where the file should be) is an error, not an absence', async () => {
  const dir = tmpDir();
  const jsonl = path.join(dir, 'agent-a.jsonl');
  fs.writeFileSync(jsonl, '');
  fs.mkdirSync(path.join(dir, 'agent-a.meta.json'));
  assert.deepStrictEqual(await readMeta(jsonl), { meta: null, error: true });
});
