'use strict';
/** The report script end to end, on a fixture file. Spawns node, so it stays out of Stryker's command. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tmpDir } = require('./tmp-dir');

test('the script prints the table for a fixture file, and reports a missing one calmly', () => {
  const dir = tmpDir('usage-report');
  const file = path.join(dir, 'usage-counters.json');
  fs.writeFileSync(file, JSON.stringify({ 'git:opened': { count: 5, last: new Date().toISOString() } }));
  const script = path.join(__dirname, '..', 'scripts', 'usage-report.js');
  const ok = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0);
  assert.match(ok.stdout, /key\s+count\s+last used\r?\ngit:opened\s+5\s+today/);
  const none = spawnSync(process.execPath, [script, path.join(dir, 'missing.json')], { encoding: 'utf8' });
  assert.strictEqual(none.status, 0);
  assert.match(none.stdout, /No usage recorded yet/);
  fs.writeFileSync(file, '{ bad');
  assert.strictEqual(spawnSync(process.execPath, [script, file], { encoding: 'utf8' }).status, 1);
});
