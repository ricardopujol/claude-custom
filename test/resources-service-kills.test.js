'use strict';
// app/resources-service.js boundaries and guards that the main tests pass through without pinning. Release #117 Mortimer
// survivor 4: an unclaimed host, the half-cadence boundary pair, what a restore (minimised: false) must NOT do, and the
// snapshot-shape guards in onUpdate.
const test = require('node:test');
const assert = require('node:assert');

const S = require('../app/resources-service');

const INSTALL = 'C:\\r\\dev';
const EXE = `${INSTALL}\\node_modules\\electron\\dist\\electron.exe`;
const T0 = 134000000000000000n;
const SEC = 10000000n;

function world() {
  let c = 1000;
  const p = (pid, ppid, name, cmd, priv) => ({ pid, ppid, name, cmd, priv, start: String(c += 10) });
  return [
    p(10, 1, 'electron.exe', `${EXE} ${INSTALL}`, 100),
    p(20, 10, 'electron.exe', `${EXE} ${INSTALL}\\host\\host.js`, 50),
    p(22, 20, 'claude.exe', 'claude.exe', 300),
    p(23, 22, 'node.exe', 'node server.js', 400),
  ];
}
const sampleAt = (procs, cpu23, n) => ({
  at: 0, procs,
  perf: new Map(procs.map(p => [p.pid, { cpu: p.pid === 23 ? BigInt(Math.round(cpu23 * n)) : 0n, ts: T0 + BigInt(n) * 10n * SEC, ws: p.priv }])),
  cpuTotal: { idle: BigInt(n) * 5n * SEC, ts: T0 + BigInt(n) * 10n * SEC }, os: { totalBytes: 1000, freeBytes: 400 },
});
const burn = pct => (pct / 100) * 4 * 10 * 1e7;

function rig(extra = {}) {
  let t = 100000;
  let wall = 5000;
  const sent = [];
  const procs = world();
  const claims = [{ pid: 20, port: 7701, cwd: 'C:\\r\\dev', processStartedAt: procs[1].start }];
  const killed = [];
  const svc = S.createResourcesService({
    sampler: { setWanted: () => {}, sampleNow: async () => procs, snapshot: () => null },
    tabs: () => [{ key: 'k', cwd: 'C:\\r\\dev', branch: 'main', port: 7701 }],
    claims: () => claims, installDirs: () => [INSTALL], ownPid: 10, cores: 4, labelOf: c => c.split('\\').pop(),
    send: (full, light) => sent.push([full, light]),
    kill: async (targets) => { killed.push(...targets.map(x => x.pid)); return targets.map(x => ({ pid: x.pid, status: 'killed' })); },
    refreshStrip: () => {}, now: () => wall, mono: () => t, ...extra,
  });
  return { svc, sent, procs, killed, tick: (ms) => { t += ms; wall += ms; } };
}
const snap = (over = {}) => ({ mode: 'full', sample: null, prev: null, machine: { last: null, prev: null }, failures: 0, lastGoodAt: 4000, stale: false, expired: false, ...over });
const fullSnap = (n, pct, procs = world()) => snap({
  sample: sampleAt(procs, burn(pct), n), prev: n > 1 ? sampleAt(procs, burn(pct), n - 1) : null,
  machine: { last: sampleAt(procs, burn(pct), n), prev: n > 1 ? sampleAt(procs, burn(pct), n - 1) : null },
});
const hist = r => r.sent.at(-1)[0].history;

test('stop: a host claimed on a port NO tab uses is not one of this window\'s hosts, so its processes are not ours to stop', async () => {
  const procs = world();
  const claims = [{ pid: 20, port: 9999, cwd: 'C:\\x', processStartedAt: procs[1].start }];
  const r = rig({ claims: () => claims });
  const res = await r.svc.stop({ pid: 23, startTime: procs[3].start });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not-ours');
  assert.deepStrictEqual(r.killed, []);
});

test('stop: a host claimed on a tab\'s port IS ours (the control for the unclaimed row)', async () => {
  const r = rig();
  const res = await r.svc.stop({ pid: 23, startTime: r.procs[3].start });
  assert.strictEqual(res.ok, true);
});

test('tabs: a tab is matched to the host claiming ITS port, never to whichever host is first', () => {
  const r = rig({ tabs: () => [{ key: 'other', cwd: 'C:\\o', branch: null, port: 7702 }, { key: 'k', cwd: 'C:\\r\\dev', branch: 'main', port: 7701 }] });
  r.svc.onUpdate(fullSnap(2, 50));
  const rows = r.sent.at(-1)[0].model.project.rows;
  assert.deepStrictEqual(rows.map(x => x.key), ['k']);
});

test('history: an ad-hoc read just UNDER half a cadence after the last point is dropped, exactly AT half a cadence it is recorded', () => {
  const under = rig();
  under.svc.onUpdate(fullSnap(2, 50));
  under.tick(4999);
  under.svc.onUpdate({ ...fullSnap(3, 50), adhoc: true });
  assert.strictEqual(hist(under).length, 1);

  const at = rig();
  at.svc.onUpdate(fullSnap(2, 50));
  at.tick(5000);
  at.svc.onUpdate({ ...fullSnap(3, 50), adhoc: true });
  assert.strictEqual(hist(at).length, 2);
});

test('history: a non-adhoc sample under half a cadence after the last point is still recorded', () => {
  const r = rig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.tick(100);
  r.svc.onUpdate(fullSnap(3, 50));
  assert.strictEqual(hist(r).length, 2);
});

test('minimise: restoring (minimised false) adds no break to the history and clears no warning', () => {
  const r = rig();
  r.svc.onUpdate(fullSnap(2, 60));
  r.tick(1000);
  r.svc.setMinimised(false);
  r.svc.onUpdate(fullSnap(3, 60));
  assert.strictEqual(hist(r).length, 2);
  assert.strictEqual(hist(r)[1].brk, undefined, 'a restore that was never minimised is not a gap');

  const lit = rig();
  for (let n = 2; n <= 4; n++) lit.svc.onUpdate(fullSnap(n, 60));
  assert.ok(lit.svc.warnFor('k'));
  lit.svc.setMinimised(false);
  assert.ok(lit.svc.warnFor('k'), 'not minimised: the lit chip stays');
  lit.svc.setMinimised('yes');
  assert.ok(lit.svc.warnFor('k'), 'only a real true minimises');
});

test('minimise: minimising marks a break on the next point and clears the warning', () => {
  const r = rig();
  r.svc.onUpdate(fullSnap(2, 60));
  r.svc.setMinimised(true);
  r.tick(1000);
  r.svc.setMinimised(false);
  r.svc.onUpdate(fullSnap(3, 60));
  assert.strictEqual(hist(r)[1].brk, true);
});

test('onUpdate: a full snapshot with no sample builds no model; a machine snapshot that carries a sample builds none either', () => {
  const r = rig();
  r.svc.onUpdate(snap({ mode: 'full', sample: null }));
  assert.strictEqual(r.sent.at(-1)[0].model, null);
  r.svc.onUpdate({ ...fullSnap(2, 50), mode: 'machine' });
  assert.strictEqual(r.sent.at(-1)[0].model, null);
  assert.ok(r.sent.at(-1)[0].machine, 'the chip figures are still there');
});

test('onUpdate: a snapshot with no machine, or an empty one, reports no machine figures and does not throw', () => {
  const r = rig();
  r.svc.onUpdate({ mode: 'machine', failures: 0, lastGoodAt: 4000 });
  assert.strictEqual(r.sent.at(-1)[0].machine, null);
  r.svc.onUpdate(snap({ mode: 'machine', machine: { last: null, prev: null } }));
  assert.strictEqual(r.sent.at(-1)[0].machine, null);
});

test('onUpdate: status carries stale and expired only for a real true', () => {
  const r = rig();
  r.svc.onUpdate(snap({ mode: 'machine', stale: true, expired: true }));
  assert.deepStrictEqual(r.sent.at(-1)[0].status, { stale: true, expired: true, ageMs: 1000 });
  r.svc.onUpdate(snap({ mode: 'machine', stale: 'yes', expired: 1 }));
  assert.deepStrictEqual(r.sent.at(-1)[0].status, { stale: false, expired: false, ageMs: 1000 });
  r.svc.onUpdate(snap({ mode: 'machine', lastGoodAt: undefined }));
  assert.strictEqual(r.sent.at(-1)[0].status.ageMs, null);
});

test('onUpdate: an expired snapshot clears the warnings and steps nothing, even with a model', () => {
  const r = rig();
  for (let n = 2; n <= 4; n++) r.svc.onUpdate(fullSnap(n, 60));
  assert.ok(r.svc.warnFor('k'));
  r.svc.onUpdate({ ...fullSnap(5, 60), expired: true });
  assert.strictEqual(r.svc.warnFor('k'), null);
});

test('resend before any sample sends a bare payload to both kinds of page; after one, the light one keeps its figures', () => {
  const r = rig();
  r.svc.resend();
  const [full, light] = r.sent.at(-1);
  assert.deepStrictEqual(full.model, null);
  assert.deepStrictEqual(light, { model: null, status: { stale: false, expired: false, ageMs: null }, machine: null, chipOn: true });
  r.svc.onUpdate(fullSnap(2, 50));
  r.svc.resend();
  const [, light2] = r.sent.at(-1);
  assert.ok(light2.machine, 'the light payload keeps the machine figures');
  assert.strictEqual(light2.model, null);
  assert.strictEqual(light2.status.ageMs, 1000);
});

test('resend after a sample keeps the full payload: its model and machine, not a bare one', () => {
  const r = rig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.svc.resend();
  const [full] = r.sent.at(-1);
  assert.ok(full.model);
  assert.ok(full.machine);
  assert.strictEqual(full.chipOn, true);
});
