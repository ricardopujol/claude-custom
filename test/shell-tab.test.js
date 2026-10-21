'use strict';
/**
 * BACKLOG #119 A5: the pure pieces of a shell tab (host/shell-tab.js) and how a shell HOST is told apart from a folder's own
 * host and from its side host: the key, the label, the env flag, the identity file, the port walk, the stop list.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shell = require('../host/shell-tab');
const side = require('../host/side-session');
const { hostEnv, PER_TAB_KEYS } = require('../host/tab-env');
const { writeIdentity, readIdentity } = require('../host/host-identity');
const { decideAttach } = require('../host/handshake');
const { resolvePort } = require('../host/port-for-project');

const PROJECT = { kind: 'flat', root: 'C:\\repo', dev: 'C:\\repo' };

test('the key: a suffix no path can contain, reversible, and never on a companion key', () => {
  const k = shell.shellKeyOf('c:\\proj\\feat-a');
  assert.strictEqual(k, 'c:\\proj\\feat-a|shell');
  assert.strictEqual(shell.isShellKey(k), true);
  assert.strictEqual(shell.parentKeyOfShell(k), 'c:\\proj\\feat-a');
  assert.strictEqual(shell.isShellKey('c:\\proj\\feat-a'), false);
  assert.strictEqual(shell.parentKeyOfShell('c:\\proj\\feat-a'), null);
  assert.strictEqual(shell.shellKeyOf(k), null, 'no shell of a shell');
  assert.strictEqual(shell.shellKeyOf(side.sideKeyOf('c:\\proj\\feat-a')), null, 'no shell of a side tab');
  assert.strictEqual(side.sideKeyOf(k), null, 'no side session of a shell tab');
  for (const bad of [null, undefined, '', 5, {}]) {
    assert.strictEqual(shell.shellKeyOf(bad), null, String(bad));
    assert.strictEqual(shell.isShellKey(bad), false, String(bad));
    assert.strictEqual(shell.parentKeyOfShell(bad), null, String(bad));
  }
});

test('property: parentKeyOfShell(shellKeyOf(k)) is k, and a shell key is never a side key', () => {
  fc.assert(fc.property(fc.string({ minLength: 1 }), (k) => {
    fc.pre(!shell.isCompanionKey(k));
    const s = shell.shellKeyOf(k);
    assert.strictEqual(shell.parentKeyOfShell(s), k);
    assert.strictEqual(side.isSideKey(s), false);
    assert.strictEqual(shell.isShellKey(side.sideKeyOf(k)), false);
  }), { numRuns: 200, seed: 7501 });
});

test('the suffixes in shell-tab.js and side-session.js agree (shell-tab can not require side-session without a cycle)', () => {
  assert.strictEqual(shell.COMPANION_SUFFIXES.includes(side.SIDE_SUFFIX), true);
  assert.strictEqual(shell.COMPANION_SUFFIXES.includes(shell.SHELL_SUFFIX), true);
});

test('the label: the branch tab\'s, then " · shell"', () => {
  assert.strictEqual(shell.shellLabel('feat/a'), 'feat/a \u00b7 shell');
});

test('isShellEnv: only the exact string "1"', () => {
  assert.strictEqual(shell.isShellEnv({ [shell.SHELL_HOST_ENV]: '1' }), true);
  for (const v of ['', '0', 'true', 'yes', undefined]) assert.strictEqual(shell.isShellEnv({ [shell.SHELL_HOST_ENV]: v }), false, String(v));
  assert.strictEqual(shell.isShellEnv(null), false);
  assert.strictEqual(shell.isShellEnv({}), false);
});

test('the host env flag is NOT the shell override: they are two variables', () => {
  assert.notStrictEqual(shell.SHELL_HOST_ENV, 'CLAUDE_CUSTOM_SHELL');
});

test('hostEnv: shell:true sets the host flag, and an inherited one never reaches the next host', () => {
  const on = hostEnv({}, { cwd: 'C:\\repo', port: 4100, token: 't', project: PROJECT, shell: true });
  assert.strictEqual(on[shell.SHELL_HOST_ENV], '1');
  const off = hostEnv({ [shell.SHELL_HOST_ENV]: '1', CLAUDE_CUSTOM_SIDE_SESSION: '1' }, { cwd: 'C:\\repo', port: 4100, token: 't', project: PROJECT });
  assert.ok(!(shell.SHELL_HOST_ENV in off), 'a shell host\'s flag is per-tab identity');
  assert.ok(PER_TAB_KEYS.includes(shell.SHELL_HOST_ENV));
});

test('hostEnv keeps CLAUDE_CUSTOM_SHELL (the person\'s choice of shell): the host reads it', () => {
  const env = hostEnv({ CLAUDE_CUSTOM_SHELL: 'nu' }, { cwd: 'C:\\repo', port: 4100, token: 't', project: PROJECT, shell: true });
  assert.strictEqual(env.CLAUDE_CUSTOM_SHELL, 'nu');
});

function inTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-shell-id-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('identity: a shell host says kind "shell", an ordinary and a side host say nothing of it', () => {
  inTmp((dir) => {
    writeIdentity({ dir, port: 4101, cwd: 'C:\\w', kind: 'shell' });
    writeIdentity({ dir, port: 4102, cwd: 'C:\\w' });
    writeIdentity({ dir, port: 4103, cwd: 'C:\\w', side: true });
    const raw = (p) => JSON.parse(fs.readFileSync(path.join(dir, 'hosts', `${p}.json`), 'utf8'));
    assert.strictEqual(raw(4101).kind, 'shell');
    assert.ok(!('kind' in raw(4102)));
    assert.ok(!('kind' in raw(4103)));
    assert.strictEqual(readIdentity({ dir, port: 4101 }).kind, 'shell');
    assert.ok(!('kind' in readIdentity({ dir, port: 4102 })));
    assert.ok(!('kind' in readIdentity({ dir, port: 4103 })));
  });
});

test('identity: only the exact word "shell" is a kind', () => {
  inTmp((dir) => {
    writeIdentity({ dir, port: 4101, cwd: 'C:\\w', kind: 'bogus' });
    assert.ok(!('kind' in JSON.parse(fs.readFileSync(path.join(dir, 'hosts', '4101.json'), 'utf8'))));
  });
});

test('handshake: a window looks for a host as the kind it is; a shell host is never the folder\'s own, nor its side', () => {
  const own = { cwd: 'C:\\w' };
  const sideHost = { cwd: 'C:\\w', side: true };
  const shellHost = { cwd: 'C:\\w', kind: 'shell' };
  const ask = (occupant, requested) => decideAttach({ requestedCwd: 'C:\\w', occupant, ...requested }).action;
  assert.strictEqual(ask(shellHost, { requestedKind: 'shell' }), 'attach');
  assert.strictEqual(ask(shellHost, {}), 'refuse');
  assert.strictEqual(ask(shellHost, { requestedSide: true }), 'refuse');
  assert.strictEqual(ask(own, { requestedKind: 'shell' }), 'refuse');
  assert.strictEqual(ask(sideHost, { requestedKind: 'shell' }), 'refuse');
  assert.strictEqual(ask(own, {}), 'attach');
  assert.strictEqual(ask(sideHost, { requestedSide: true }), 'attach');
  assert.strictEqual(ask(null, { requestedKind: 'shell' }), 'spawn');
  assert.strictEqual(decideAttach({ requestedCwd: 'C:\\w', occupant: shellHost, requestedKind: 'shell' }).action, 'attach');
  assert.strictEqual(decideAttach({ requestedCwd: 'C:\\w', occupant: { cwd: 'C:\\other', kind: 'shell' }, requestedKind: 'shell' }).reason, 'other-project');
});

test('port walk: a shell asks for a port of its own, past the folder\'s own host and its side host', async () => {
  const { portForCwd, PORT_BASE } = require('../host/port-for-project');
  const first = portForCwd('C:\\w');
  const next = (n) => PORT_BASE + ((first - PORT_BASE + n) % require('../host/port-for-project').PORT_SPAN);
  const hosts = new Map([[first, { cwd: 'C:\\w' }], [next(1), { cwd: 'C:\\w', side: true }]]);
  const occupantAt = async (p) => hosts.get(p) || null;
  const r = await resolvePort({ cwd: 'C:\\w', occupantAt, kind: 'shell' });
  assert.deepStrictEqual(r, { port: next(2), action: 'spawn' });
  hosts.set(next(2), { cwd: 'C:\\w', kind: 'shell' });
  assert.deepStrictEqual(await resolvePort({ cwd: 'C:\\w', occupantAt, kind: 'shell' }), { port: next(2), action: 'attach' });
  assert.deepStrictEqual(await resolvePort({ cwd: 'C:\\w', occupantAt }), { port: first, action: 'attach' }, 'the folder\'s own walk is unchanged');
});

test('shellHostsOf: [{ port, cwd }] of the shell hosts; null when an identity could not be read', () => {
  const ids = [
    { port: 1, parsed: { cwd: 'C:\\w\\a', kind: 'shell' } },
    { port: 2, parsed: { cwd: 'C:\\w\\a', side: true } },
    { port: 3, parsed: { cwd: 'C:\\w\\b' } },
    { port: 4, parsed: null },
  ];
  assert.deepStrictEqual(shell.shellHostsOf(ids), [{ port: 1, cwd: 'C:\\w\\a' }]);
  assert.strictEqual(shell.shellHostsOf([...ids, { unreadable: true }]), null);
  assert.strictEqual(shell.shellHostsOf(undefined), null);
  assert.deepStrictEqual(shell.shellHostsOf([]), []);
  assert.deepStrictEqual(side.sideHostsOf(ids), [{ port: 2, cwd: 'C:\\w\\a' }], 'side adoption never picks up a shell host');
});

test('siblingSessions: a shell host in the folder is no "other claude session" for the folder\'s host or the side host', () => {
  const ids = [{ port: 9, parsed: { port: 9, cwd: 'C:\\w', kind: 'shell', claudePid: 555 } }];
  assert.deepStrictEqual(side.siblingSessions(ids, { cwd: 'C:\\w', side: false, ownPort: 1 }), { pids: [], sessionIds: [] });
  assert.deepStrictEqual(side.siblingSessions(ids, { cwd: 'C:\\w', side: true, ownPort: 1 }), { pids: [], sessionIds: [] });
});

test('the Sessions menu labels a shell host as one, and never opens it as a window of its own (the handshake would refuse it)', () => {
  const { menuModel } = require('../app/background-menu');
  const row = { own: true, port: 7702, cwd: 'C:\w\feat-a', build: 'dev', startedAt: 1, windows: 0, kind: 'shell' };
  const away = menuModel({ verified: true, rows: [row] }, { now: 2 }).items[0];
  assert.match(away.label, /shell/);
  assert.strictEqual(away.open, null);
  const here = menuModel({ verified: true, rows: [row] }, { now: 2, tabsByPort: new Map([[7702, 'k|shell']]) }).items[0];
  assert.deepStrictEqual(here.open, { kind: 'select-tab', key: 'k|shell' });
});

test('the stop list carries a shell host kind, and an ordinary or side host carries none', async () => {
  const { listBackgroundHosts } = require('../host/background-hosts');
  const OWN = 'C:\\cc\\feat-a';
  const ft = ms => String((BigInt(ms) + 11644473600000n) * 10000n);
  const files = {
    7701: { port: 7701, cwd: 'C:/proj/feat-a', pid: 101, startedAt: 5000 },
    7702: { port: 7702, cwd: 'C:/proj/feat-a', pid: 102, startedAt: 5100, kind: 'shell' },
    7703: { port: 7703, cwd: 'C:/proj/feat-a', pid: 103, startedAt: 5200, side: true },
    7704: { port: 7704, cwd: 'C:/proj/feat-a', pid: 104, startedAt: 5300, kind: 'shellish' },
  };
  const deps = {
    installs: () => [OWN],
    identities: () => Object.entries(files).map(([port, parsed]) => ({ port: Number(port), parsed })),
    startTimes: async (pids) => new Map(pids.map(p => [p, ft(4800)])),
    windowCounts: async (targets) => new Map(targets.map(t => [t.pid, 0])),
  };
  const { rows } = await listBackgroundHosts({ ownInstall: OWN }, deps);
  const by = Object.fromEntries(rows.map(r => [r.port, r]));
  assert.strictEqual(by[7702].kind, 'shell');
  for (const p of [7701, 7703, 7704]) assert.ok(!('kind' in by[p]), String(p));
});
