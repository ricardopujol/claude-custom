'use strict';
/**
 * The app lock (single-instance PR 3 step 4): one Jiandu process per install. host/app-owner.js is the owner-file core on `<dir>\app.json`;
 * host/app-claim.js is host/window-claim.js reused with that owner, the app pipe (`claude-custom-app-<pid>`), an `open` message
 * { cwd, install, probe, env }, the tag 'single instance' and a 10 s ack. Real files and real pipes; pids are made up (unique per test),
 * so a pipe name never meets a real process's.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');
const { samePath } = require('../host/project-layout');

const load = () => require('../host/app-claim');
const owner = () => require('../host/app-owner');
const uniquePid = () => 900_000_000 + Math.floor(Math.random() * 90_000_000);
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); }
};
const INSTALL = path.resolve('/apps/jiandu');
const CWD = path.resolve('/projects/alpha/dev');

// A launch of this install: every pid in `alive` (and only those) is running, with start `S<pid>`.
function launch({ dir, pid = uniquePid(), alive, acted = [], over = {} }) {
  const claim = load().createAppClaim({
    dir, pid, ownStart: async () => `S${pid}`,
    startTimes: async (pids) => new Map(pids.filter((p) => alive.has(p)).map((p) => [p, `S${p}`])),
    launchCwd: CWD, installDir: INSTALL, probe: false, env: {}, samePath,
    act: async (msg) => { acted.push(msg); }, onExit: () => {}, log: () => {}, readyBoundMs: 5000,
    ...over,
  });
  alive.add(pid);
  return { claim, pid, acted };
}
const appFile = (dir) => path.join(dir, 'app.json');
const readOwner = (dir) => { try { return JSON.parse(fs.readFileSync(appFile(dir), 'utf8')); } catch { return null; } };

test('no owner -> proceed and publish this process in <dir>\\app.json', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const a = launch({ dir, alive });
  try {
    assert.strictEqual(await a.claim.run(), 'proceed');
    assert.strictEqual(readOwner(dir).pid, a.pid);
    assert.strictEqual(readOwner(dir).start, `S${a.pid}`);
  } finally { a.claim.stop(); }
  assert.strictEqual(readOwner(dir), null, 'stop releases the file');
});

test('a dead owner -> proceed and take the file over', async () => {
  const dir = tmpDir('cc-app-');
  fs.writeFileSync(appFile(dir), JSON.stringify({ pid: 12345, start: 'S12345' }));
  const a = launch({ dir, alive: new Set() });
  try {
    assert.strictEqual(await a.claim.run(), 'proceed');
    assert.strictEqual(readOwner(dir).pid, a.pid);
  } finally { a.claim.stop(); }
});

test('an owner that cannot be proved -> proceed, no publish (the maybe-live owner keeps its file)', async () => {
  const dir = tmpDir('cc-app-');
  const text = JSON.stringify({ pid: 12345, start: 'S12345' });
  fs.writeFileSync(appFile(dir), text);
  const a = launch({ dir, alive: new Set(), over: { startTimes: async () => null } });
  try {
    assert.strictEqual(await a.claim.run(), 'proceed');
    assert.strictEqual(fs.readFileSync(appFile(dir), 'utf8'), text);
  } finally { a.claim.stop(); }
});

test('a live owner that accepts -> exit; the owner acts on { cwd, env } of the open', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const o = launch({ dir, alive });
  assert.strictEqual(await o.claim.run(), 'proceed');
  o.claim.markReady();
  const b = launch({ dir, alive, over: { env: { CLAUDE_CUSTOM_BIN: 'C:\\bin\\claude.exe', PATH: 'never sent' } } });
  try {
    assert.strictEqual(await b.claim.run(), 'exit');
    await until(() => o.acted.length === 1);
    assert.deepStrictEqual(o.acted[0], { cwd: CWD, env: { CLAUDE_CUSTOM_BIN: 'C:\\bin\\claude.exe' } });
    assert.strictEqual(readOwner(dir).pid, o.pid, 'the owner still owns the file');
  } finally { o.claim.stop(); b.claim.stop(); }
});

test('a live owner that is closing -> proceed, and the file is taken over with the judged bytes', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  // a closing owner: live, listening, named by the file, but saying no (a quit in progress)
  const closingPid = uniquePid();
  alive.add(closingPid);
  const name = require('../host/window-focus').appPipeNameFor(closingPid);
  fs.writeFileSync(appFile(dir), JSON.stringify({ pid: closingPid, start: `S${closingPid}` }));
  const srv = net.createServer((s) => { s.on('error', () => {}); s.setEncoding('utf8'); s.on('data', () => s.end('{"ack":true}\n{"ok":false,"error":"closing"}\n')); });
  await new Promise((r) => srv.listen(name, r));
  const b = launch({ dir, alive });
  try {
    assert.strictEqual(await b.claim.run(), 'proceed');
    assert.strictEqual(readOwner(dir).pid, b.pid);
  } finally { b.claim.stop(); await new Promise((r) => srv.close(r)); }
});

test('a live owner that does not acknowledge (hung) -> proceed and take the file over, after the second, full wait (PR #258 Dexter 1)', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const hungPid = uniquePid();
  alive.add(hungPid);
  fs.writeFileSync(appFile(dir), JSON.stringify({ pid: hungPid, start: `S${hungPid}` }));
  const socks = [];
  const srv = net.createServer((s) => { socks.push(s); s.on('error', () => {}); });
  await new Promise((r) => srv.listen(require('../host/window-focus').appPipeNameFor(hungPid), r));
  const b = launch({ dir, alive, over: { ackMs: 200, readyBoundMs: 100 } });
  try {
    const t0 = Date.now();
    assert.strictEqual(await b.claim.run(), 'proceed');
    // a missed ack from a live owner is not enough: the second send waits readyBound + 10 s slack, and only that silence passes the owner by
    assert.ok(Date.now() - t0 >= 10_000, `waited for the second answer (${Date.now() - t0} ms)`);
    assert.strictEqual(readOwner(dir).pid, b.pid);
  } finally { b.claim.stop(); for (const s of socks) s.destroy(); await new Promise((r) => srv.close(r)); }
});

test('the app claim asks for the ack with 10 s by default', () => {
  assert.strictEqual(load().APP_ACK_MS, 10_000);
});

test('an owner still starting holds the launch, then says ok at markReady', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const o = launch({ dir, alive });
  assert.strictEqual(await o.claim.run(), 'proceed');
  const b = launch({ dir, alive });
  let settled = null;
  const p = b.claim.run().then((r) => { settled = r; });
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(settled, null, 'held while the owner starts');
  o.claim.markReady();
  await p;
  assert.strictEqual(settled, 'exit');
  await until(() => o.acted.length === 1);
  o.claim.stop(); b.claim.stop();
});

test('an owner that stops while holding a launch says no: that launch proceeds on its own', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const o = launch({ dir, alive });
  assert.strictEqual(await o.claim.run(), 'proceed');
  const b = launch({ dir, alive });
  const p = b.claim.run();
  await new Promise((r) => setTimeout(r, 200));
  o.claim.stop();
  assert.strictEqual(await p, 'proceed');
  assert.strictEqual(o.acted.length, 0, 'nothing was opened by the owner that stopped');
  assert.strictEqual(readOwner(dir).pid, b.pid);
  b.claim.stop();
});

test('two launches racing on real files: exactly one publishes and the other is handed over', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const a = launch({ dir, alive });
  const b = launch({ dir, alive });
  const ready = (l) => l.claim.run().then((r) => { if (r === 'proceed') l.claim.markReady(); return r; });
  const rs = await Promise.all([ready(a), ready(b)]);
  try {
    assert.deepStrictEqual([...rs].sort(), ['exit', 'proceed']);
    const winner = rs[0] === 'proceed' ? a : b;
    assert.strictEqual(readOwner(dir).pid, winner.pid);
    await until(() => winner.acted.length === 1);
  } finally { a.claim.stop(); b.claim.stop(); }
});

test('P-A1: N launches of one install, any start order and ready delay: exactly one proceeds and owns the file; every other ends exit, handed to it', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ delay: fc.integer({ min: 0, max: 40 }), readyAfter: fc.integer({ min: 0, max: 60 }) }), { minLength: 2, maxLength: 4 }),
    async (plan) => {
      const dir = tmpDir('cc-app-pa1-');
      const alive = new Set();
      const ls = plan.map(() => launch({ dir, alive }));
      const ends = await Promise.all(ls.map((l, i) => new Promise((r) => setTimeout(r, plan[i].delay)).then(() => l.claim.run()).then(async (r) => {
        if (r === 'proceed') { await new Promise((x) => setTimeout(x, plan[i].readyAfter)); l.claim.markReady(); }
        return r;
      })));
      try {
        const owners = ls.filter((l, i) => ends[i] === 'proceed');
        assert.strictEqual(owners.length, 1, `ends: ${ends.join(',')}`);
        assert.ok(ends.every((e) => e === 'exit' || e === 'proceed'));
        assert.strictEqual(readOwner(dir).pid, owners[0].pid, 'the file names the one that proceeded');
        await until(() => owners[0].acted.length === ls.length - 1);
      } finally { for (const l of ls) l.claim.stop(); }
    }), { numRuns: 12 });
});

test('cleanOpen refuses a missing, relative or over-long cwd, another install, and a probe flag that differs from the owner\'s', () => {
  const { cleanOpenFor } = load();
  const clean = cleanOpenFor({ install: INSTALL, probe: false, samePath });
  const ok = { type: 'open', cwd: CWD, install: INSTALL, probe: false };
  assert.deepStrictEqual(clean(ok), { cwd: CWD, env: {} });
  assert.strictEqual(clean({ ...ok, cwd: undefined }), null);
  assert.strictEqual(clean({ ...ok, cwd: 'relative\\dir' }), null);
  assert.strictEqual(clean({ ...ok, cwd: path.resolve('/' + 'x'.repeat(1100)) }), null);
  assert.strictEqual(clean({ ...ok, install: path.resolve('/apps/other') }), null);
  assert.strictEqual(clean({ ...ok, probe: true }), null);
  assert.strictEqual(clean({ ...ok, probe: undefined }), null, 'the flag is compared strictly');
  assert.strictEqual(clean({ ...ok, type: 'focus' }), null);
  assert.strictEqual(clean(null), null);
  assert.deepStrictEqual(clean({ ...ok, install: INSTALL.toUpperCase() }), process.platform === 'win32' ? { cwd: CWD, env: {} } : null, 'one install in two spellings');
  // env: only the three names a launch may differ on, as text; anything else is dropped
  assert.deepStrictEqual(clean({ ...ok, env: { CLAUDE_CUSTOM_BIN: 'b', CLAUDE_CUSTOM_CONPTY: 'builtin', CLAUDE_CUSTOM_SHELL: 's', PATH: 'p', CLAUDE_CUSTOM_PORT: '1' } }).env,
    { CLAUDE_CUSTOM_BIN: 'b', CLAUDE_CUSTOM_CONPTY: 'builtin', CLAUDE_CUSTOM_SHELL: 's' });
  assert.deepStrictEqual(clean({ ...ok, env: { CLAUDE_CUSTOM_BIN: 7 } }).env, {});
});

test('Jiandu Home: a home launch is type \'home\' on the app pipe; the owner hears { cwd, env, home: true }, an open never carries home', () => {
  const { cleanOpenFor, sendFor } = load();
  const clean = cleanOpenFor({ install: INSTALL, probe: false, samePath });
  const ok = { type: 'home', cwd: CWD, install: INSTALL, probe: false };
  assert.deepStrictEqual(clean(ok), { cwd: CWD, env: {}, home: true });
  assert.strictEqual(clean({ ...ok, install: path.resolve('/apps/other') }), null, 'the same gates as an open');
  assert.strictEqual(clean({ ...ok, cwd: 'relative' }), null);
  assert.deepStrictEqual(clean({ ...ok, type: 'open', home: true }), { cwd: CWD, env: {} }, 'a home field on an open is ignored');
  const sent = [];
  sendFor({ send: (o) => { sent.push(o); return { ok: true }; }, home: true })({ pid: 5, msg: { cwd: CWD } });
  sendFor({ send: (o) => { sent.push(o); return { ok: true }; }, home: false })({ pid: 6, msg: { cwd: CWD } });
  assert.deepStrictEqual(sent.map((o) => [o.type, o.name]), [['home', '\\\\.\\pipe\\claude-custom-app-5'], ['open', '\\\\.\\pipe\\claude-custom-app-6']]);
});

test('app-owner: the file is <dir>\\app.json, made in a plain folder (no .claude-custom), and read() parses it', async () => {
  const dir = path.join(tmpDir('cc-app-'), 'nested', 'state');
  const o = owner();
  const r = await o.claim({ stateRoot: dir, self: { pid: 77, start: 'S77' }, startTimes: async () => new Map() });
  assert.strictEqual(r.published, true);
  assert.strictEqual(o.fileOf(dir), path.join(dir, 'app.json'));
  assert.deepStrictEqual(o.read(dir), { pid: 77, start: 'S77', at: o.read(dir).at });
  assert.strictEqual(o.release({ stateRoot: dir, selfPid: 77, selfStart: 'S77' }), true);
  assert.strictEqual(o.read(dir), null);
});

test('PR #258 Dexter 4: an owner that cannot be proven (startTimes null under load) -> proceed by the plan\'s rule, and the log says why', async () => {
  const dir = tmpDir('cc-app-');
  const text = JSON.stringify({ pid: 12345, start: 'S12345' });
  fs.writeFileSync(appFile(dir), text);
  const lines = [];
  const a = launch({ dir, alive: new Set(), over: { startTimes: async () => null, log: (l) => lines.push(l) } });
  try {
    assert.strictEqual(await a.claim.run(), 'proceed');
    assert.strictEqual(fs.readFileSync(appFile(dir), 'utf8'), text, 'never taken as "no owner": the file is not taken');
    assert.ok(lines.some((l) => /single instance: going on here without the owner file \(unproven-owner/.test(l)), lines.join('\n'));
  } finally { a.claim.stop(); }
});

test('PR #258 Dexter 4: no start time for this process -> proceed, publish nothing, and say so', async () => {
  const dir = tmpDir('cc-app-');
  const lines = [];
  const a = launch({ dir, alive: new Set(), over: { ownStart: async () => null, log: (l) => lines.push(l) } });
  try {
    assert.strictEqual(await a.claim.run(), 'proceed');
    assert.strictEqual(readOwner(dir), null);
    assert.ok(lines.some((l) => /without the owner file \(no-self-start/.test(l)), lines.join('\n'));
  } finally { a.claim.stop(); }
});

// --- fix/owner-proof: the live owner proves itself on its app pipe -----------------------------------------------------------------
// MEASURED 2026-11-27 (Ricardo's smoke test, then a forced 1 s budget): the launch's PowerShell query timed out, the running owner read
// 'unknown', and the launch went on as a SECOND Jiandu process ('unproven-owner', or 'no-self-start' when its own query failed too).

test('fix/owner-proof: a live owner is handed the launch even when the launch\'s start-time queries all fail (proof by the app pipe)', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const o = launch({ dir, alive });
  assert.strictEqual(await o.claim.run(), 'proceed');
  o.claim.markReady();
  const lines = [];
  const b = launch({ dir, alive, over: { startTimes: async () => null, log: (l) => lines.push(l) } });
  try {
    assert.strictEqual(await b.claim.run(), 'exit', lines.join('\n'));
    await until(() => o.acted.length === 1);
    assert.strictEqual(readOwner(dir).pid, o.pid);
  } finally { o.claim.stop(); b.claim.stop(); }
});

test('fix/owner-proof: ... and when the launch could not learn its OWN start either (was no-self-start)', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const o = launch({ dir, alive });
  assert.strictEqual(await o.claim.run(), 'proceed');
  o.claim.markReady();
  const b = launch({ dir, alive, over: { startTimes: async () => null, ownStart: async () => null } });
  try {
    assert.strictEqual(await b.claim.run(), 'exit');
    await until(() => o.acted.length === 1);
  } finally { o.claim.stop(); b.claim.stop(); }
});

test('fix/owner-proof: an app.json whose pid answers on its pipe with ANOTHER start is not proven by the pipe (the query decides)', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const o = launch({ dir, alive });
  assert.strictEqual(await o.claim.run(), 'proceed');
  // the file names o's pid with a start o does not have: an older process whose pid o now holds
  fs.writeFileSync(appFile(dir), JSON.stringify({ pid: o.pid, start: 'S-older' }));
  const b = launch({ dir, alive, over: { startTimes: async () => null } });
  try {
    assert.strictEqual(await b.claim.run(), 'proceed');
    assert.strictEqual(readOwner(dir).start, 'S-older', 'unproven: the file is not taken (PR #247 Miguel I4)');
  } finally { o.claim.stop(); b.claim.stop(); }
});

test('PR #258 Dexter 2: a displaced owner claims again: once the displacer released app.json, reclaim() makes it this process\'s again', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const a = launch({ dir, alive });
  try {
    assert.strictEqual(await a.claim.run(), 'proceed');
    a.claim.markReady();
    // a launch that took the file over (A looked hung) and then quit, releasing it: the install has no owner
    fs.rmSync(appFile(dir), { force: true });
    assert.strictEqual(await a.claim.reclaim(), true);
    assert.strictEqual(readOwner(dir).pid, a.pid);
    // and A's stop releases it again (released is reset)
  } finally { a.claim.stop(); }
  assert.strictEqual(readOwner(dir), null);
});

test('PR #258 Dexter 2: reclaim() leaves a LIVE other owner alone (two processes stay the residual, never a stolen file)', async () => {
  const dir = tmpDir('cc-app-');
  const alive = new Set();
  const other = uniquePid();
  alive.add(other);
  const a = launch({ dir, alive });
  try {
    assert.strictEqual(await a.claim.run(), 'proceed');
    const text = JSON.stringify({ pid: other, start: `S${other}` });
    fs.writeFileSync(appFile(dir), text);
    assert.strictEqual(await a.claim.reclaim(), false);
    assert.strictEqual(fs.readFileSync(appFile(dir), 'utf8'), text);
  } finally { a.claim.stop(); }
});

test('PR #258 Dexter 2: reclaim() after stop() does nothing (a quitting process claims nothing)', async () => {
  const dir = tmpDir('cc-app-');
  const a = launch({ dir, alive: new Set() });
  assert.strictEqual(await a.claim.run(), 'proceed');
  a.claim.stop();
  assert.strictEqual(await a.claim.reclaim(), false);
  assert.strictEqual(readOwner(dir), null);
});
