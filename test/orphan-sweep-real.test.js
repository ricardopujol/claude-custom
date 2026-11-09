'use strict';
// The two orphan-sweep tests that start real processes (node children, one PowerShell table read). They live apart from
// test/orphan-sweep.test.js so that file stays fast and can sit in stryker.conf.json's command (BACKLOG #169).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

// Not required from host/probe-mark.js: that module is mutated by Stryker, and this file starts real processes so it stays out of its command.
const MARK_VAR = 'CC_PROBE_MARK';
const MARK_SHAPE = /^pm1-([1-9]\d{0,9})-[0-9a-f]{12}$/;
const parseMark = (v) => { const m = MARK_SHAPE.exec(String(v)); return m ? { pid: Number(m[1]) } : null; };
const { readProcessTable, START_TOLERANCE } = require('../verify/lib/orphan-sweep');

test('a probe\'s launcher marks process.env and the mark survives the env stripping; a unit test run marks nothing', () => {
  const probeFile = path.join(__dirname, '..', 'verify', 'probe-dock-tree.js');
  const code = `process.argv[1] = ${JSON.stringify(probeFile)};
    const le = require(${JSON.stringify(path.join(__dirname, '..', 'verify', 'lib', 'launch-electron.js'))});
    const mark = process.env.${MARK_VAR};
    const kept = le.cleanElectronEnv({ ...process.env }).${MARK_VAR};
    const probe = le.probeEnv({ ...process.env, CLAUDE_CUSTOM_X: '1' }, { ...process.env, CLAUDE_CUSTOM_X: '1' }).${MARK_VAR};
    console.log(JSON.stringify({ mark, kept, probe }));`;
  // No real machine lock for this child: the lock script is pointed at a path that doesn't exist ('missing'). HEAVY_LOCK_HELD=1
  // alone no longer does it: with nobody holding the slot (this file run on its own) that is a stale flag, and the child would
  // take the real lock (host/heavy-lock.js RE-ENTRANCY).
  const env = { ...process.env, HEAVY_LOCK_SCRIPT: path.join(__dirname, 'no-such-heavy-lock.ps1') };
  delete env.HEAVY_LOCK_HELD;
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

test('readProcessTable: the real machine\'s table has this process, started before now, with its parent (on Windows a null table is a BROKEN script, not a pass)', () => {
  if (process.platform !== 'win32') return;   // the table is read through PowerShell/CIM: nothing to measure elsewhere
  const t = readProcessTable();
  assert.ok(t, 'readProcessTable returned null on Windows: the CIM script is broken or PowerShell is unavailable (PR #232 Miguel Y3)');
  const me = t.get(process.pid);
  assert.ok(me, 'this process is in the table');
  assert.strictEqual(me.ppid, process.ppid);
  assert.ok(me.created > 0n);
});

// PR #232 Dexter 3 / Miguel G3: the sweep compares TWO sources of a start time, the host's own (host/proc-start.js, what it writes to its
// identity file) and the process table's (CIM). They must agree for one real pid within the tolerance the sweep allows, or every real
// orphan would read as "the pid belongs to another process".
test('the start time a host writes (Get-Process) and the one the sweep reads (CIM) agree within the sweep\'s tolerance for a real pid', async () => {
  if (process.platform !== 'win32') return;
  // Asked in a child (host/proc-start.js is a Stryker-mutated module, and this file stays out of that run): the host's own query for THIS pid.
  const modulePath = path.join(__dirname, '..', 'host', ['proc', 'start.js'].join('-'));
  const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).startTimes([${process.pid}]).then(m => console.log(String(m && m.get(${process.pid}))))`], { encoding: 'utf8' });
  const hostSide = child.stdout.trim();
  assert.match(hostSide, /^\d+$/, `the host-side query answered with a start time for this process (${hostSide} ${child.stderr})`);
  const t = readProcessTable();
  assert.ok(t && t.get(process.pid));
  const a = BigInt(hostSide);
  const b = t.get(process.pid).created;
  const diff = a > b ? a - b : b - a;
  assert.ok(diff <= START_TOLERANCE, `start times differ by ${diff} ticks, more than the sweep's ${START_TOLERANCE}`);
});
