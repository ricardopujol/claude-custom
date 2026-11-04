'use strict';
// The two orphan-sweep tests that start real processes (node children, one PowerShell table read). They live apart from
// test/orphan-sweep.test.js so that file stays fast and can sit in stryker.conf.json's command (BACKLOG #169).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const { MARK_VAR, parseMark } = require('../host/probe-mark');
const { readProcessTable } = require('../verify/lib/orphan-sweep');

test('a probe\'s launcher marks process.env and the mark survives the env stripping; a unit test run marks nothing', () => {
  const probeFile = path.join(__dirname, '..', 'verify', 'probe-dock-tree.js');
  const code = `process.argv[1] = ${JSON.stringify(probeFile)};
    const le = require(${JSON.stringify(path.join(__dirname, '..', 'verify', 'lib', 'launch-electron.js'))});
    const mark = process.env.${MARK_VAR};
    const kept = le.cleanElectronEnv({ ...process.env }).${MARK_VAR};
    const probe = le.probeEnv({ ...process.env, CLAUDE_CUSTOM_X: '1' }, { ...process.env, CLAUDE_CUSTOM_X: '1' }).${MARK_VAR};
    console.log(JSON.stringify({ mark, kept, probe }));`;
  const env = { ...process.env, HEAVY_LOCK_HELD: '1' };   // no real machine lock for this child
  delete env[MARK_VAR];
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.ok(parseMark(out.mark), 'a probe process carries a valid mark');
  assert.strictEqual(parseMark(out.mark).pid > 0, true);
  assert.strictEqual(out.kept, out.mark, 'cleanElectronEnv keeps it');
  assert.strictEqual(out.probe, out.mark, 'probeEnv keeps it');
  const notProbe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'verify', 'lib', 'launch-electron.js'))}); console.log(String(process.env.${MARK_VAR}))`], { encoding: 'utf8', env });
  assert.strictEqual(notProbe.stdout.trim(), 'undefined', 'not a probe: no mark');
});

test('readProcessTable: the real machine\'s table has this process, started before now, with its parent', () => {
  const t = readProcessTable();
  if (!t) return;   // off Windows, or PowerShell unavailable here: nothing to measure
  const me = t.get(process.pid);
  assert.ok(me, 'this process is in the table');
  assert.strictEqual(me.ppid, process.ppid);
  assert.ok(me.created > 0n);
});
