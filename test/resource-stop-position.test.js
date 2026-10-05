'use strict';
/**
 * PR #113 review round 1 (Dexter 1, 2, 4, 5, 11; Miguel I1): Stop protects by POSITION, ends exactly the guarded subtree
 * leaf first, re-proves each process at the kill, and reports what really happened.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const S = require('../host/resource-stop');
const T = require('../host/resource-tree');
const K = require('../host/resource-kill');
const M = require('../host/resource-model');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
let n;
const row = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd: cmd || null, start: String(start === undefined ? (n += 10) : start), priv: 1 });
const win = pid => row(pid, 1, 'electron.exe', `${EXE} ${INSTALL}`);
const host = (pid, ppid) => row(pid, ppid, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`);
const ask = (procs, pid, hosts = [20]) => S.stopDecision({ pid, startTime: procs.find(p => p.pid === pid).start }, procs, { sessionHostPids: hosts });

test('D1: the kill set is exactly the guarded subtree, so an older orphan that only NAMES a reused pid is never in it', () => {
  n = 1000;
  // target 30; 31 started BEFORE it and only names its (reused) pid; 32 is a real child
  const procs2 = [win(10), host(20, 10), row(22, 20, 'claude.exe', 'claude.exe'), row(30, 22, 'node.exe', 'node target', 5000), row(31, 30, 'node.exe', 'orphan', 100), row(32, 30, 'node.exe', 'real child', 5100)];
  const r = ask(procs2, 30);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.kill.map(k => k.pid), [32, 30], 'orphan 31 started before its "parent" and is NOT killed');
  assert.ok(r.kill.every(k => typeof k.start === 'string'), 'each carries the start time to re-prove it by');
});

test('D2a: the process the pty launched is protected whatever it is called (cmd.exe under CLAUDE_CUSTOM_BIN, a launcher)', () => {
  n = 1000;
  const procs = [win(10), host(20, 10), row(21, 20, 'conhost.exe', 'conhost.exe --headless'), row(22, 20, 'cmd.exe', 'cmd.exe --dangerously-skip-permissions'), row(23, 22, 'node.exe', 'node server.js')];
  assert.deepStrictEqual(ask(procs, 22), { ok: false, reason: 'protected' });
  assert.strictEqual(ask(procs, 23).ok, true, 'what it started is still stoppable');
});

test('D2b: a process whose subtree holds a window, a host or claude is protected (npm start inside a session)', () => {
  n = 1000;
  const procs = [win(10), host(20, 10), row(22, 20, 'claude.exe', 'claude.exe'), row(30, 22, 'node.exe', 'node npm-cli.js start'),
    win2(40, 30), host(50, 40), row(52, 50, 'claude.exe', 'claude.exe')];
  function win2(pid, ppid) { return row(pid, ppid, 'electron.exe', `${EXE} ${INSTALL}`); }
  assert.deepStrictEqual(ask(procs, 30), { ok: false, reason: 'protected' });
  // ...also when the thing below it is only a host by command line, or a direct child of ANOTHER session host
  const procs2 = [win(10), host(20, 10), row(22, 20, 'claude.exe', 'claude.exe'), row(30, 22, 'node.exe', 'node wrapper'), host(50, 30)];
  assert.deepStrictEqual(ask(procs2, 30, [20, 50]), { ok: false, reason: 'protected' });
});

test('D2c: a plain build or server in the session, with ordinary children, may be stopped', () => {
  n = 1000;
  const procs = [win(10), host(20, 10), row(22, 20, 'claude.exe', 'claude.exe'), row(30, 22, 'node.exe', 'node build'), row(31, 30, 'esbuild.exe', 'esbuild')];
  const r = ask(procs, 30);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.kill.map(k => k.pid), [31, 30]);
});

test('D2/D11: the view model offers Stop exactly where the guard allows it, and never on a session with no tab', () => {
  n = 1000;
  const procs = [win(10), host(20, 10), row(21, 20, 'conhost.exe', 'conhost.exe --headless'), row(22, 20, 'cmd.exe', 'cmd.exe --dangerously-skip-permissions'),
    row(23, 22, 'node.exe', 'node server.js'), row(30, 10, 'electron.exe', `${EXE} --type=renderer`),
    host(60, 10), row(62, 60, 'claude.exe', 'claude.exe'), row(63, 62, 'node.exe', 'node other.js')];
  const perf = new Map(procs.map(p => [p.pid, { cpu: 0n, ts: 1n }]));
  const sample = { at: 0, procs, perf, cpuTotal: null, os: null };
  const m = M.buildModel({ sample, prev: null, cores: 4, tabs: [{ key: 'k', label: 'main', hostPid: 20 }],
    hosts: [{ pid: 20, cwd: 'C:\\r\\dev' }, { pid: 60, cwd: 'C:\\r\\old' }], installDirs: [INSTALL], ownPid: 10 });
  const tab = m.project.rows.find(r => r.key === 'k');
  assert.deepStrictEqual(tab.children.map(c => [c.pid, c.canStop]), [[23, true]]);
  assert.strictEqual(tab.claude.pid, 22, 'the CLI root is found by position even when it is called cmd.exe');
  const noTab = m.project.rows.find(r => r.key === 'host:60');
  assert.ok(noTab);
  assert.ok(noTab.children.length > 0 && noTab.children.every(c => c.canStop === false), 'a session with no tab: the guard would refuse, so no button');
  for (const c of tab.children) {
    assert.strictEqual(S.stopDecision({ pid: c.pid, startTime: c.start }, procs, { sessionHostPids: [20] }).ok, c.canStop, `pid ${c.pid}`);
  }
});

test('D12: a claim with no start time, or one that does not match, is not a host: a reused pid is not believed', () => {
  n = 1000;
  const procs = [host(20, 10)];
  assert.deepStrictEqual(T.provenHosts(procs, [{ pid: 20, port: 1, cwd: 'x' }]), []);
  assert.deepStrictEqual(T.provenHosts(procs, [{ pid: 20, port: 1, cwd: 'x', processStartedAt: procs[0].start }]).length, 1);
});

// ---- the kill itself ----
test('D4: the kill script re-proves each process through a handle at the moment it ends it, leaf first, one call', () => {
  const s = K.killScript([{ pid: 24, start: '1100' }, { pid: 23, start: '1000' }]);
  assert.ok(s.indexOf('K 24 1100') < s.indexOf('K 23 1000'), 'leaf first');
  assert.match(s, /\$null = \$p\.Handle/);
  assert.ok(s.indexOf('$p.Handle') < s.indexOf('$p.StartTime') && s.indexOf('$p.StartTime') < s.indexOf('$p.Kill()'), 'handle, then the start time through it, then the kill');
  assert.match(s, /return "\$id reused"/);
  assert.doesNotMatch(s, /taskkill|\/T\b|Stop-Process -Name|-Name/);
  assert.match(s, /'END'$/);
});

test('D5: the kill reports what really happened, per process, and a missing or partial answer is a failure', async () => {
  const targets = [{ pid: 24, start: '1100' }, { pid: 23, start: '1000' }];
  const say = (text) => ({ exec: async () => text });
  assert.deepStrictEqual(await K.killVerified(targets, say('24 killed\n23 killed\nEND\n')), [{ pid: 24, status: 'killed' }, { pid: 23, status: 'killed' }]);
  assert.deepStrictEqual((await K.killVerified(targets, say('24 gone\n23 reused\nEND'))).map(r => r.status), ['gone', 'reused']);
  const denied = await K.killVerified(targets, say('24 killed\n23 failed Access is denied\nEND'));
  assert.deepStrictEqual(denied[1], { pid: 23, status: 'failed', text: 'Access is denied' });
  const partial = await K.killVerified(targets, say('24 killed\n'));
  assert.deepStrictEqual(partial.map(r => r.status), ['failed', 'failed'], 'no END: nothing is believed');
  const boom = await K.killVerified(targets, { exec: async () => { throw new Error('timed out'); } });
  assert.ok(boom.every(r => r.status === 'failed' && /timed out/.test(r.text)));
  assert.deepStrictEqual((await K.killVerified([{ pid: 0, start: 'x' }], say('END'))).map(r => r.status), ['failed']);
  assert.deepStrictEqual(await K.killVerified([], say('END')), []);
});

test('D5: stop() says "Stopped" only when the TARGET was reported killed; denied, gone and reused are said as they are', async () => {
  n = 1000;
  const procs = [win(10), host(20, 10), row(22, 20, 'claude.exe', 'claude.exe'), row(30, 22, 'node.exe', 'node x', 5000)];
  const run = (statuses) => S.stop({ pid: 30, startTime: '5000' }, {
    readProcs: async () => procs, hostPids: () => [20], kill: async (t) => t.map(x => ({ pid: x.pid, ...statuses })),
  });
  assert.deepStrictEqual(await run({ status: 'killed' }), { ok: true, pid: 30, name: 'node.exe' });
  const denied = await run({ status: 'failed', text: 'Access is denied' });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.reason, 'kill-failed');
  assert.match(denied.text, /Access is denied/);
  assert.deepStrictEqual(await run({ status: 'gone' }), { ok: false, reason: 'gone', text: 'Already exited' });
  assert.strictEqual((await run({ status: 'reused' })).reason, 'reused');
  const none = await S.stop({ pid: 30, startTime: '5000' }, { readProcs: async () => procs, hostPids: () => [20], kill: async () => [] });
  assert.strictEqual(none.reason, 'kill-failed', 'no answer for the target: not stopped');
});

test('property: whatever the table, an accepted Stop never has a protected process, a host or a host\'s direct child in its kill set', () => {
  const NAMES = [['electron.exe', `${EXE} ${INSTALL}`], ['electron.exe', `${EXE} --type=gpu-process`], ['electron.exe', `${EXE} ${INSTALL}\\host\\host.js`],
    ['claude.exe', 'claude.exe'], ['conhost.exe', 'conhost.exe'], ['node.exe', 'node a'], ['git.exe', 'git b'], ['cmd.exe', 'cmd.exe c']];
  const rowArb = fc.record({ ppid: fc.integer({ min: 0, max: 25 }), kind: fc.integer({ min: 0, max: NAMES.length - 1 }), start: fc.integer({ min: 1, max: 30 }) });
  fc.assert(fc.property(fc.array(rowArb, { minLength: 1, maxLength: 25 }), fc.array(fc.integer({ min: 1, max: 25 }), { maxLength: 4 }), fc.integer({ min: 1, max: 26 }), (rows, hostPids, pid) => {
    const procs = rows.map((r, i) => ({ pid: i + 1, ppid: r.ppid, name: NAMES[r.kind][0], cmd: NAMES[r.kind][1], start: String(r.start), priv: 1 }));
    const me = procs.find(p => p.pid === pid);
    if (!me) return;
    const d = S.stopDecision({ pid, startTime: me.start }, procs, { sessionHostPids: hostPids });
    if (!d.ok) return;
    const ix = new Map(procs.map(p => [p.pid, p]));
    const directOfHosts = new Set(procs.filter(p => hostPids.includes(p.ppid)).map(p => p.pid));
    for (const k of d.kill) {
      const p = ix.get(k.pid);
      assert.ok(!T.isProtectedRole(T.roleOf(p)), `pid ${k.pid} has a protected role`);
      assert.ok(!hostPids.includes(k.pid), `pid ${k.pid} is a session host`);
      assert.ok(!directOfHosts.has(k.pid), `pid ${k.pid} is a host's direct child`);
    }
    assert.strictEqual(d.kill.at(-1).pid, pid, 'the target is last');
  }));
});

// ---- the real script, against processes this test starts itself (Windows only) ----
const { spawn, execFileSync } = require('child_process');
test('D4/D5 real PowerShell: kills a process with the right start time, refuses a wrong one, and reports a dead pid as gone', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const { createExec } = require('../host/resource-sampler');
  const exec = createExec(30000);
  const mk = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  const startOf = (pid) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { encoding: 'utf8', windowsHide: true }).trim();
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const a = mk(); const b = mk();
  try {
    await new Promise(r => setTimeout(r, 400));
    const sa = startOf(a.pid);
    const sb = startOf(b.pid);
    const wrong = String(BigInt(sb) + 50000000n);         // 5 s off: "a different process now holds this pid"
    const res = await K.killVerified([{ pid: a.pid, start: sa }, { pid: b.pid, start: wrong }, { pid: 2147483000, start: sa }], { exec });
    assert.deepStrictEqual(res.map(r => r.status), ['killed', 'reused', 'gone'], JSON.stringify(res));
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(alive(a.pid), false, 'the right start time: ended');
    assert.strictEqual(alive(b.pid), true, 'the wrong start time: left alone');
    const again = await K.killVerified([{ pid: a.pid, start: sa }], { exec });
    assert.strictEqual(again[0].status, 'gone', 'already dead: "Already exited"');
  } finally {
    for (const c of [a, b]) { try { process.kill(c.pid); } catch { /* gone */ } }
  }
});
