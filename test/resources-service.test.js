'use strict';
/**
 * app/resources-service.js (BACKLOG #63): what main does with the sampler. Which views want the panel, the
 * payload every tab page gets, the per-tab warning counters, and the Stop IPC. Everything it touches is handed in.
 */
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
// pid 23 burns `pct`% of a 4-core machine: pct/100 * 4 cores * 10 s per sample
const burn = pct => (pct / 100) * 4 * 10 * 1e7;

function rig(extra = {}) {
  const sent = [];
  const refreshed = [];
  const wanted = [];
  const killed = [];
  const procs = world();
  const claims = [{ pid: 20, port: 7701, cwd: 'C:\\r\\dev', processStartedAt: world()[1].start }];
  let selected = new Set(['v1']);
  let reread = procs;
  const svc = S.createResourcesService({
    sampler: { setWanted: w => wanted.push(w), sampleNow: async () => reread, snapshot: () => null },
    tabs: () => [{ key: 'k', cwd: 'C:\\r\\dev', branch: 'main', port: 7701 }, { key: 'k2', cwd: 'C:\\r\\feat', branch: null, port: 7702 }],
    claims: () => claims, installDirs: () => [INSTALL], ownPid: 10, cores: 4, labelOf: c => c.split('\\').pop(),
    send: payload => sent.push(payload),
    kill: async (targets) => { killed.push(...targets.map(t => t.pid)); return targets.map(t => ({ pid: t.pid, status: 'killed' })); },
    refreshStrip: () => refreshed.push(1), now: () => 5000, ...extra,
  });
  return { svc, sent, refreshed, wanted, killed, procs, setSelected: (s) => { selected = new Set(s); }, setReread: (r) => { reread = r; } };
}
const snap = (over = {}) => ({ mode: 'full', sample: null, prev: null, machine: { last: null, prev: null }, failures: 0, lastGoodAt: 4000, stale: false, expired: false, ...over });
const fullSnap = (n, pct, procs = world()) => snap({ sample: sampleAt(procs, burn(pct), n), prev: n > 1 ? sampleAt(procs, burn(pct), n - 1) : null,
  machine: { last: sampleAt(procs, burn(pct), n), prev: n > 1 ? sampleAt(procs, burn(pct), n - 1) : null } });

test('Q1: the process tree is sampled ALWAYS, with the panel open or closed, so the tab warning works with it closed', () => {
  const r = rig();
  r.svc.refresh();
  assert.deepStrictEqual(r.wanted.at(-1), { panel: true, chip: true });
  assert.strictEqual(typeof r.svc.setShown, 'undefined', 'what a page says about its panel no longer decides anything');
});

test('a minimised window stops the chip\'s sampling too', () => {
  const r = rig();
  r.svc.setMinimised(true);
  assert.deepStrictEqual(r.wanted.at(-1), { panel: false, chip: false });
  r.svc.setMinimised(false);
  assert.deepStrictEqual(r.wanted.at(-1), { panel: true, chip: true });
});

test('a full sample is pushed to every page: the model, the status, and the machine figures for the chip', () => {
  const r = rig();
  r.svc.onUpdate(fullSnap(2, 50));
  const p = r.sent.at(-1);
  assert.ok(p.model, 'the model is there');
  assert.strictEqual(p.model.project.rows[0].key, 'k');
  assert.strictEqual(p.model.project.rows[0].label, 'main');
  assert.ok(Math.abs(p.model.project.rows[0].cpu - 50) < 1e-6);
  assert.ok(Math.abs(p.machine.cpu - 50) < 1e-6);
  assert.deepStrictEqual(p.machine.mem, { usedBytes: 600, totalBytes: 1000 });
  assert.deepStrictEqual(p.status, { stale: false, expired: false, ageMs: 1000 });
});

test('a machine-only sample pushes the chip\'s figures and no model', () => {
  const r = rig();
  r.svc.onUpdate(snap({ mode: 'machine', machine: { last: sampleAt(world(), 0, 2), prev: sampleAt(world(), 0, 1) } }));
  const p = r.sent.at(-1);
  assert.strictEqual(p.model, null);
  assert.ok(Math.abs(p.machine.cpu - 50) < 1e-6);
});

test('before any sample the chip has no machine figures: null, not zeros', () => {
  const r = rig();
  r.svc.onUpdate(snap({ mode: 'machine', failures: 1, stale: true, lastGoodAt: null }));
  const p = r.sent.at(-1);
  assert.strictEqual(p.machine, null);
  assert.deepStrictEqual(p.status, { stale: true, expired: false, ageMs: null });
});

test('get returns the last payload for a page that just opened, or null', () => {
  const r = rig();
  assert.strictEqual(r.svc.get(), null);
  r.svc.onUpdate(fullSnap(2, 10));
  assert.strictEqual(r.svc.get(), r.sent.at(-1));
});

test('the tab warning: three samples over 40% turn it on and tell the strip; one under clears it', () => {
  const r = rig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.svc.onUpdate(fullSnap(3, 50));
  assert.strictEqual(r.svc.warnFor('k'), null, 'two samples are not 30 s');
  r.svc.onUpdate(fullSnap(4, 50));
  assert.deepStrictEqual(r.svc.warnFor('k'), { pct: 50, level: 'amber' });
  assert.ok(r.refreshed.length >= 1, 'the strip is told');
  const before = r.refreshed.length;
  r.svc.onUpdate(fullSnap(5, 80));
  assert.deepStrictEqual(r.svc.warnFor('k'), { pct: 80, level: 'red' });
  assert.ok(r.refreshed.length > before);
  r.svc.onUpdate(fullSnap(6, 5));
  assert.strictEqual(r.svc.warnFor('k'), null);
  assert.strictEqual(r.svc.warnFor('k2'), null);
});

test('the first sample has no CPU, so it counts toward nothing', () => {
  const r = rig();
  r.svc.onUpdate(fullSnap(1, 90));
  r.svc.onUpdate(fullSnap(2, 90));
  r.svc.onUpdate(fullSnap(3, 90));
  assert.strictEqual(r.svc.warnFor('k'), null);
});

test('when the panel is hidden the process tree is not sampled, so warnings and their chips are cleared, not left stale', () => {
  const r = rig();
  for (let n = 2; n <= 4; n++) r.svc.onUpdate(fullSnap(n, 60));
  assert.ok(r.svc.warnFor('k'));
  const before = r.refreshed.length;
  r.svc.onUpdate(snap({ mode: 'machine', machine: { last: sampleAt(world(), 0, 5), prev: sampleAt(world(), 0, 4) } }));
  assert.strictEqual(r.svc.warnFor('k'), null);
  assert.ok(r.refreshed.length > before);
  const quiet = r.refreshed.length;
  r.svc.onUpdate(snap({ mode: 'machine', machine: { last: sampleAt(world(), 0, 6), prev: sampleAt(world(), 0, 5) } }));
  assert.strictEqual(r.refreshed.length, quiet, 'nothing to clear: the strip is not told again');
});

test('N4: a minimise gap forgets the warning counts and clears a lit chip (the strip is told), so one reading after it is not the third', () => {
  const r = rig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.svc.onUpdate(fullSnap(3, 50));          // two over: one more would light it
  r.svc.setMinimised(true);
  r.svc.setMinimised(false);
  r.svc.onUpdate(fullSnap(1, 50));          // the first sample after the gap has no CPU
  r.svc.onUpdate(fullSnap(4, 50));
  assert.strictEqual(r.svc.warnFor('k'), null, 'the count did not carry across the gap');

  const lit = rig();
  for (let n = 2; n <= 4; n++) lit.svc.onUpdate(fullSnap(n, 60));
  assert.ok(lit.svc.warnFor('k'));
  const before = lit.refreshed.length;
  lit.svc.setMinimised(true);
  assert.strictEqual(lit.svc.warnFor('k'), null, 'the chip does not stay lit with an hour-old percentage');
  assert.ok(lit.refreshed.length > before, 'the strip is told');
});

test('N6: the Stop own re-read (an `adhoc` sample) is shown but does not step the warning counters', () => {
  const r = rig();
  r.svc.onUpdate(fullSnap(2, 60));
  r.svc.onUpdate(fullSnap(3, 60));
  r.svc.onUpdate({ ...fullSnap(4, 60), adhoc: true });
  assert.strictEqual(r.svc.warnFor('k'), null, 'two scheduled samples and one off-cadence one are not 30 s');
  assert.ok(r.sent.at(-1).model, 'the page still gets the fresh model');
  r.svc.onUpdate(fullSnap(5, 60));
  assert.ok(r.svc.warnFor('k'), 'the third scheduled sample lights it');
});

test('three failed samples in a row clear the warnings: a number nobody could measure is not a warning', () => {
  const r = rig();
  for (let n = 2; n <= 4; n++) r.svc.onUpdate(fullSnap(n, 60));
  assert.ok(r.svc.warnFor('k'));
  r.svc.onUpdate({ ...fullSnap(4, 60), failures: 3, stale: true, expired: true });
  assert.strictEqual(r.svc.warnFor('k'), null);
});

test('a tab whose host is not proven has no row and no warning, and a host with a reused pid is not believed', () => {
  const r = rig({ claims: () => [{ pid: 20, port: 7701, cwd: 'C:\\r\\dev', processStartedAt: '99999999999' }] });
  r.svc.onUpdate(fullSnap(2, 60));
  assert.deepStrictEqual(r.sent.at(-1).model.project.rows, []);
});

test('stop: forwards to the guard with this window\'s session hosts, kills that pid only, and says what happened', async () => {
  const r = rig();
  const procs = world();
  r.setReread(procs);
  const res = await r.svc.stop({ pid: 23, startTime: procs[3].start });
  assert.deepStrictEqual(res, { ok: true, pid: 23, name: 'node.exe' });
  assert.deepStrictEqual(r.killed, [23]);
});

test('stop: refuses claude, and anything when the request is malformed, and kills nothing', async () => {
  const r = rig();
  const procs = world();
  const a = await r.svc.stop({ pid: 22, startTime: procs[2].start });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.reason, 'protected');
  const b = await r.svc.stop({ pid: '23', startTime: procs[3].start });
  assert.strictEqual(b.reason, 'invalid');
  const c = await r.svc.stop(null);
  assert.strictEqual(c.reason, 'invalid');
  assert.deepStrictEqual(r.killed, []);
});

test('stop: a process list that cannot be read stops nothing', async () => {
  const r = rig();
  r.setReread(null);
  const res = await r.svc.stop({ pid: 23, startTime: '1' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'unreadable');
  assert.deepStrictEqual(r.killed, []);
});

test('warnAt moves the threshold (the probe seam), and unset it is 40', () => {
  const low = rig({ warnAt: 15 });
  for (let n = 2; n <= 4; n++) low.svc.onUpdate(fullSnap(n, 20));
  assert.deepStrictEqual(low.svc.warnFor('k'), { pct: 20, level: 'amber' }, '20% is over a 15% threshold');
  const std = rig();
  for (let n = 2; n <= 4; n++) std.svc.onUpdate(fullSnap(n, 20));
  assert.strictEqual(std.svc.warnFor('k'), null, '20% is under the default 40%');
  const explicitUndefined = rig({ warnAt: undefined });
  for (let n = 2; n <= 4; n++) explicitUndefined.svc.onUpdate(fullSnap(n, 20));
  assert.strictEqual(explicitUndefined.svc.warnFor('k'), null);
});

// ---- PR #113 review round 1 (Dexter 3, 8, 13) ----

test('D3: a failed sample re-sends the last good one; it must not step the counters again (one real 50% is one over)', () => {
  const r = rig();
  r.svc.onUpdate(fullSnap(2, 50));                       // the one real over-threshold measurement
  const good = fullSnap(3, 50);
  r.svc.onUpdate(good);                                  // over = 2
  r.svc.onUpdate({ ...good, failures: 1, stale: true }); // timeout: the same sample, re-sent
  r.svc.onUpdate({ ...good, failures: 2, stale: true });
  assert.strictEqual(r.svc.warnFor('k'), null, 'two real overs and two timeouts is not three overs');
  r.svc.onUpdate(fullSnap(4, 50));                       // a third REAL sample
  assert.deepStrictEqual(r.svc.warnFor('k'), { pct: 50, level: 'amber' });
});

test('D3: after the chip is on, a failed sample does not clear it either (nothing measured is not "under")', () => {
  const r = rig();
  for (let n = 2; n <= 4; n++) r.svc.onUpdate(fullSnap(n, 60));
  const last = fullSnap(5, 60);
  r.svc.onUpdate(last);
  r.svc.onUpdate({ ...last, failures: 1, stale: true });
  assert.ok(r.svc.warnFor('k'));
});

test('D8: a tab with no row for one sample keeps its count, and only a tab gone from the strip loses it', () => {
  let proven = true;
  const r = rig({ claims: () => (proven ? [{ pid: 20, port: 7701, cwd: 'C:\r\dev', processStartedAt: world()[1].start }] : []) });
  r.svc.onUpdate(fullSnap(2, 50));
  r.svc.onUpdate(fullSnap(3, 50));                       // over = 2
  proven = false;                                        // one read could not prove the host: no row
  r.svc.onUpdate(fullSnap(4, 50));
  assert.strictEqual(r.sent.at(-1).model.project.rows.length, 0);
  proven = true;
  r.svc.onUpdate(fullSnap(5, 50));                       // over = 3: on
  assert.deepStrictEqual(r.svc.warnFor('k'), { pct: 50, level: 'amber' });
});

test('D8: a tab that left the strip loses its count', () => {
  let tabs = [{ key: 'k', cwd: 'C:\r\dev', branch: 'main', port: 7701 }];
  const r = rig({ tabs: () => tabs });
  r.svc.onUpdate(fullSnap(2, 50));
  r.svc.onUpdate(fullSnap(3, 50));
  tabs = [];
  r.svc.onUpdate(fullSnap(4, 50));
  tabs = [{ key: 'k', cwd: 'C:\r\dev', branch: 'main', port: 7701 }];
  r.svc.onUpdate(fullSnap(5, 50));
  r.svc.onUpdate(fullSnap(6, 50));
  assert.strictEqual(r.svc.warnFor('k'), null, 'it started again from zero: two overs, not on');
});

test('D13/Q1: a minimised window wants nothing, whatever else; restoring it wants everything again', () => {
  const r = rig();
  r.svc.setMinimised(true);
  assert.deepStrictEqual(r.wanted.at(-1), { panel: false, chip: false });
  r.svc.setMinimised(false);
  assert.deepStrictEqual(r.wanted.at(-1), { panel: true, chip: true });
});

test('D14: the probe seam is parsed strictly', () => {
  assert.strictEqual(S.parseWarnAt('15'), 15);
  assert.strictEqual(S.parseWarnAt('1'), 1);
  assert.strictEqual(S.parseWarnAt('99'), 99);
  for (const bad of ['0x1E', ' 40', '40 ', '4e1', '1.5', '1e1', '', '0', '100', '-5', '015x', undefined, null, 15]) {
    assert.strictEqual(S.parseWarnAt(bad), undefined, String(bad));
  }
});

test('S5: the full payload (command lines) goes to the page showing the panel; a light one, machine figures only, to the rest', () => {
  const calls = [];
  const r = rig({ send: (full, light) => calls.push([full, light]) });
  r.svc.onUpdate(fullSnap(2, 50));
  const [full, light] = calls.at(-1);
  assert.ok(full.model);
  assert.strictEqual(light.model, null);
  assert.deepStrictEqual(light.machine, full.machine);
  assert.deepStrictEqual(light.status, full.status);
  assert.strictEqual(r.svc.get(true), full);
  assert.strictEqual(r.svc.get(false), light);
});

// ---- Q2: the top-bar chip's Window-menu toggle ----

test('Q2: the chip is ON by default, off only for a stored real false; a payload carries it', () => {
  assert.strictEqual(rig().svc.chipOn(), true);
  for (const stored of [null, true, 'false', 0, undefined]) assert.strictEqual(rig({ chipStore: { read: () => stored, write: () => {} } }).svc.chipOn(), true, String(stored));
  const off = rig({ chipStore: { read: () => false, write: () => {} } });
  assert.strictEqual(off.svc.chipOn(), false);
  off.svc.onUpdate(fullSnap(2, 10));
  assert.strictEqual(off.sent.at(-1).chipOn, false);
});

test('Q2: setChip saves the answer, tells every page at once, and refuses anything that is not a boolean', () => {
  const written = [];
  const calls = [];
  const r = rig({ chipStore: { read: () => null, write: v => written.push(v) }, send: (full, light) => calls.push([full, light]) });
  assert.strictEqual(r.svc.setChip('false'), true, 'a string is not a boolean: unchanged');
  assert.strictEqual(r.svc.setChip(1), true);
  assert.deepStrictEqual(written, []);
  r.svc.onUpdate(fullSnap(2, 10));
  assert.strictEqual(r.svc.setChip(false), false);
  assert.deepStrictEqual(written, [false]);
  const [full, light] = calls.at(-1);
  assert.strictEqual(full.chipOn, false);
  assert.strictEqual(light.chipOn, false);
  assert.ok(full.model, 'the model is not lost by a toggle');
  assert.strictEqual(r.svc.setChip(true), true);
  assert.deepStrictEqual(written, [false, true]);
});

test('Q2: the toggle never stops the sampling (the warning needs it with the chip off and the panel closed)', () => {
  const r = rig({ chipStore: { read: () => false, write: () => {} } });
  r.svc.refresh();
  assert.deepStrictEqual(r.wanted.at(-1), { panel: true, chip: true });
  r.svc.setChip(false);
  for (let n = 2; n <= 4; n++) r.svc.onUpdate(fullSnap(n, 60));
  assert.ok(r.svc.warnFor('k'));
});

test('Q2: a store that throws on save is logged, not raised, and the setting still holds for this run', () => {
  const logged = [];
  const r = rig({ chipStore: { read: () => null, write: () => { throw new Error('disk'); } }, log: (...a) => logged.push(a.join(' ')) });
  assert.strictEqual(r.svc.setChip(false), false);
  assert.match(logged.join(), /disk/);
});
