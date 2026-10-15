'use strict';
/**
 * PR #135 Dexter N1: the straddle spawner must not flood the machine when its owner dies without cleaning up.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { tmpDir } = require('./tmp-dir');
const path = require('path');
const { spawn } = require('child_process');
const { spawnerSource } = require('../verify/lib/spawner-source');
const { reapMarked, SLEEPER_SRC } = require('../verify/lib/reap-marked');

const onWin = process.platform === 'win32';
const opts = { skip: !onWin, timeout: 90000 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function launch(dir, name, over) {
  const marker = `ccspawn${process.pid}x${Date.now()}${name}`;
  const file = path.join(dir, `${name}.js`);
  const stats = path.join(dir, `${name}.stats`);
  fs.writeFileSync(file, spawnerSource({ sleeperSrc: SLEEPER_SRC, marker, readyFile: path.join(dir, `${name}.ready`), statsFile: stats, ...over }));
  const child = spawn(process.execPath, [file], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise(r => child.once('exit', r));
  return { child, exited, marker, stats };
}
const readStats = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

test('a spawner whose parent is gone exits by itself within a few seconds (N1)', opts, async () => {
  const dir = tmpDir('ccsp-');
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore', windowsHide: true });
  const s = launch(dir, 'orphan', { intervalMs: 25, parentPid: parent.pid });
  try {
    await new Promise(r => parent.once('exit', r));
    const t0 = Date.now();
    const done = await Promise.race([s.exited.then(() => true), sleep(8000).then(() => false)]);
    assert.ok(done, 'the orphaned spawner is still running 8 s after its parent ended');
    assert.ok(Date.now() - t0 < 4000, `it took ${Date.now() - t0} ms to notice`);
  } finally {
    if (s.child.exitCode === null) s.child.kill();
    try { reapMarked(s.marker); } catch { /* sleepers expire by themselves */ }
  }
});

test('a spawner keeps spawning but never more than liveMax sleepers alive (N1)', opts, async () => {
  const dir = tmpDir('ccsp-');
  const s = launch(dir, 'cap', { intervalMs: 5, parentPid: process.pid, liveMax: 20 });
  try {
    await sleep(4500);
    const st = readStats(s.stats);
    assert.ok(st, 'no stats written');
    assert.ok(st.spawned > 40, `it stopped spawning (${st.spawned}): the straddle needs spawning to go on`);
    assert.ok(st.live <= 21, `${st.live} sleepers alive, the cap is 20`);
  } finally {
    s.child.kill();
    try { reapMarked(s.marker); } catch { /* sleepers expire by themselves */ }
  }
});

test('both spawners (the #73 probe and the #72 test) are built from this source, with their parent pid', () => {
  for (const f of [path.join(__dirname, '..', 'verify', 'probe-kill-tree-straddle.js'), path.join(__dirname, 'status-relay-process.test.js')]) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /spawnerSource\(/, f);
    assert.match(src, /parentPid: process\.pid/, f);
  }
});
