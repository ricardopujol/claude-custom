'use strict';
/**
 * PR #130 review, Dexter #1 (High) and #9: a probe that holds a ChildProcess may kill it by pid only while the child
 * is still running. Once its 'exit' has been handled Node has closed the process handle, the pid is free, and Windows
 * hands it to the next process: a later `taskkill /PID <pid> /T /F` kills a stranger and its tree. probe-notify and
 * probe-roster did exactly that after an early app.exit(1) and ~19 s of sleeps.
 *
 * Pinned here: killChildTree (host/kill-tree.js) kills only a child that has neither an exitCode nor a signalCode;
 * the hygiene registry's registerChild drops the pid when the child exits; and a source rule keeps verify/ from
 * killing `<x>.pid` any other way.
 */
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const fs = require('fs');
const path = require('path');
const { killChildTree, killTree, trackExit } = require('../host/kill-tree');
const { createHygieneRegistry } = require('../verify/lib/process-hygiene');

function child(pid, { exitCode = null, signalCode = null } = {}) {
  const c = new EventEmitter();
  Object.assign(c, { pid, exitCode, signalCode, kill() {} });
  return c;
}

test('killChildTree: a child that already exited (exitCode set) is NOT killed by pid', () => {
  const kills = [];
  assert.strictEqual(killChildTree(child(77, { exitCode: 1 }), { killFn: (p) => kills.push(p) }), false);
  assert.deepStrictEqual(kills, []);
});

test('killChildTree: a child that ended by a signal (signalCode set, exitCode null) is NOT killed by pid', () => {
  const kills = [];
  assert.strictEqual(killChildTree(child(77, { signalCode: 'SIGTERM' }), { killFn: (p) => kills.push(p) }), false);
  assert.deepStrictEqual(kills, []);
});

test('killChildTree: a running child is killed by its pid, once; no child or no pid is a no-op', () => {
  const kills = [];
  assert.strictEqual(killChildTree(child(77), { killFn: (p) => kills.push(p) }), true);
  assert.strictEqual(killChildTree(null, { killFn: (p) => kills.push(p) }), false);
  assert.strictEqual(killChildTree(child(undefined), { killFn: (p) => kills.push(p) }), false);
  assert.deepStrictEqual(kills, [77]);
});

function ptyLike(pid) {
  let onExit = null;
  return { pid, onExit(cb) { onExit = cb; }, kill() {}, exit() { if (onExit) onExit({ exitCode: 0 }); } };
}

test('killChildTree (node-pty): an IPty whose exit was never tracked is not killed (it cannot be judged)', () => {
  const kills = [];
  assert.strictEqual(killChildTree(ptyLike(88), { killFn: (p) => kills.push(p) }), false);
  assert.deepStrictEqual(kills, []);
});

test('killChildTree (node-pty): a tracked IPty is killed while running, and not after its onExit fired', () => {
  const kills = [];
  const p = trackExit(ptyLike(88));
  assert.strictEqual(killChildTree(p, { killFn: (x) => kills.push(x) }), true);
  p.exit();
  assert.strictEqual(killChildTree(p, { killFn: (x) => kills.push(x) }), false);
  assert.deepStrictEqual(kills, [88]);
});

test('registerChild (node-pty): the pid leaves the registry on onExit', () => {
  const kills = [];
  const reg = createHygieneRegistry({ killFn: (x) => kills.push(x) });
  const p = ptyLike(89);
  reg.registerChild(p);
  p.exit();
  reg._emergencyCleanup('done');
  assert.deepStrictEqual(kills, []);
});

test('killTree: a child that ended by a signal is not tree-killed either', () => {
  let spawned = 0;
  killTree(child(77, { signalCode: 'SIGKILL' }), { spawnFn: () => { spawned++; } });
  assert.strictEqual(spawned, 0);
});

test('registerChild: a child that exits before the cleanup is not killed by pid (Dexter #9)', () => {
  const kills = [];
  const reg = createHygieneRegistry({ killFn: (p) => kills.push(p) });
  const a = child(10);
  const b = child(11);
  reg.registerChild(a);
  reg.registerChild(b);
  a.exitCode = 0; a.emit('exit', 0);
  reg._emergencyCleanup('done');
  assert.deepStrictEqual(kills, [11]);
});

test('registerChild: a child with no pid (spawn failed) is not registered', () => {
  const kills = [];
  const reg = createHygieneRegistry({ killFn: (p) => kills.push(p) });
  reg.registerChild(child(undefined));
  reg._emergencyCleanup('done');
  assert.deepStrictEqual(kills, []);
});

// ---- the source rule ---------------------------------------------------------------------------------------------

// `<x>.pid` handed to a raw-pid kill: killPidTree(x.pid), registerSpawnedTree(x.pid), process.kill(x.pid[, sig]),
// or a taskkill argv carrying String(x.pid). Signal 0 (a liveness test) kills nothing and is allowed.
function rawPidKills(src) {
  const out = [];
  const res = [
    /\bkillPidTree\(\s*[\w$.]+\.pid\s*\)/g,
    /\bregisterSpawnedTree\(\s*[\w$.]+\.pid\s*\)/g,
    /\bprocess\.kill\(\s*[\w$.]+\.pid\s*(?:,\s*(?!0\s*\))[^)]*)?\)/g,
    /taskkill['"]?\s*,\s*\[[^\]]*String\(\s*[\w$.]+\.pid\s*\)/g,
  ];
  for (const re of res) for (const m of src.matchAll(re)) out.push(m[0]);
  return out;
}

test('rule fixtures: each raw <x>.pid kill is flagged; the handle-holding forms and a signal-0 probe are not', () => {
  assert.strictEqual(rawPidKills("killPidTree(app.pid);").length, 1);
  assert.strictEqual(rawPidKills("require('../host/kill-tree').killPidTree(app.child.pid)").length, 1);
  assert.strictEqual(rawPidKills("hygiene.registerSpawnedTree(electron.pid);").length, 1);
  assert.strictEqual(rawPidKills("process.kill(k.pid);").length, 1);
  assert.strictEqual(rawPidKills("process.kill(k.pid, 'SIGTERM');").length, 1);
  assert.strictEqual(rawPidKills("execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'])").length, 1);
  assert.strictEqual(rawPidKills("spawnSync('taskkill', ['/pid', String(host.pid), '/T', '/F'])").length, 1);
  assert.deepStrictEqual(rawPidKills([
    'killChildTree(app);', 'hygiene.registerChild(electron);', 'process.kill(out.hostPid, 0);',
    'try { process.kill(pid, 0); return true; } catch {}', 'child.kill();',
  ].join('\n')), []);
});

test('rule: no file under verify/ kills a <x>.pid by a raw pid (use killChildTree / registerChild)', () => {
  const VERIFY = path.join(__dirname, '..', 'verify');
  const files = fs.readdirSync(VERIFY, { recursive: true }).filter(f => /\.js$/.test(f)).map(f => path.join(VERIFY, f));
  const bad = [];
  for (const f of files) {
    if (path.basename(f) === 'launch-electron.js') continue;   // kills only while it holds the handle (Dexter: sound)
    for (const v of rawPidKills(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(VERIFY, f)}: ${v}`);
  }
  assert.deepStrictEqual(bad, []);
});
