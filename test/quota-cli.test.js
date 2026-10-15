'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { recordPoll } = require('../host/quota-share');

const CLI = path.join(__dirname, '..', 'host', 'quota-cli.js');
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('prints the one-line text for a fresh file and exits 0', () => {
  const d = tmpDir('quota-cli-');
  recordPoll({ dir: d, now: () => Date.now() - 30_000, result: {
    ok: true, windows: [{ key: 'session', label: '5h', percent: 42 }, { key: 'weekly_all', label: 'week', percent: 61 }],
  } });
  const r = run(['--dir', d]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout.trim(), /^5h 42% · week 61% · read \d+ s ago$/);
});

test('prints unknown with the reason and exits 0 when there is no file', () => {
  const r = run(['--dir', tmpDir('quota-cli-')]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout.trim(), /^unknown \(no quota file/);
});

test('--json prints the parsed object, with empty windows (not zeros) when unknown', () => {
  const r = run(['--dir', tmpDir('quota-cli-'), '--json']);
  assert.strictEqual(r.status, 0);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.state, 'absent');
  assert.deepStrictEqual(o.windows, []);
});

test('--json for a fresh file carries windows with numeric percents', () => {
  const d = tmpDir('quota-cli-');
  recordPoll({ dir: d, now: () => Date.now(), result: { ok: true, windows: [{ key: 'session', label: '5h', percent: 7 }] } });
  const o = JSON.parse(run(['--dir', d, '--json']).stdout);
  assert.strictEqual(o.state, 'fresh');
  assert.strictEqual(o.windows[0].percent, 7);
});
