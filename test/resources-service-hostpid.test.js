'use strict';
/**
 * app/resources-service.js hostPidOf (BACKLOG #119 A4): the session host each tab was proven to have in the last full sample, which the
 * Dev servers join walks from. A tab whose host could not be proven has none, and a sample with no process table changes nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../app/resources-service');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
const T0 = 134000000000000000n;
const SEC = 10000000n;

let c = 1000;
const p = (pid, ppid, name, cmd) => ({ pid, ppid, name, cmd, priv: 10, start: String(c += 10) });
const procs = [
  p(10, 1, 'electron.exe', `${EXE} ${INSTALL}`),
  p(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`),
  p(22, 20, 'claude.exe', 'claude.exe'),
];
const sampleAt = (n) => ({
  at: 0, procs,
  perf: new Map(procs.map(x => [x.pid, { cpu: 0n, ts: T0 + BigInt(n) * 10n * SEC, ws: 10 }])),
  cpuTotal: { idle: BigInt(n) * 5n * SEC, ts: T0 + BigInt(n) * 10n * SEC }, os: { totalBytes: 1000, freeBytes: 400 },
});
const snap = (n) => ({ mode: 'full', sample: sampleAt(n), prev: n > 1 ? sampleAt(n - 1) : null, machine: { last: sampleAt(n), prev: n > 1 ? sampleAt(n - 1) : null },
  failures: 0, lastGoodAt: 4000, stale: false, expired: false });

function rig() {
  const claims = [{ pid: 20, port: 7701, cwd: 'C:\\r\\dev', processStartedAt: procs[1].start }];
  return S.createResourcesService({
    sampler: { setWanted() {}, sampleNow: async () => procs, snapshot: () => null },
    tabs: () => [{ key: 'k', cwd: 'C:\\r\\dev', branch: 'main', port: 7701 }, { key: 'k2', cwd: 'C:\\r\\feat', branch: null, port: 7702 }],
    claims: () => claims, installDirs: () => [INSTALL], ownPid: 10, cores: 4, labelOf: x => x.split('\\').pop(),
    send() {}, kill: async () => [], refreshStrip() {}, now: () => 5000,
  });
}

test('hostPidOf is null until a full sample has proven a host', () => {
  assert.strictEqual(rig().hostPidOf('k'), null);
});

test('after a full sample, a tab whose host was proven has its pid and one that was not has none', () => {
  const svc = rig();
  svc.onUpdate(snap(2));
  assert.strictEqual(svc.hostPidOf('k'), 20);
  assert.strictEqual(svc.hostPidOf('k2'), null);
  assert.strictEqual(svc.hostPidOf('nope'), null);
});

test('a sample with no process table leaves the last proven hosts as they were', () => {
  const svc = rig();
  svc.onUpdate(snap(2));
  svc.onUpdate({ ...snap(3), mode: 'machine', sample: null });
  assert.strictEqual(svc.hostPidOf('k'), 20);
});
