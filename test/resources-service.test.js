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
  assert.deepStrictEqual(r.svc.get(), r.sent.at(-1));
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
  assert.deepStrictEqual(r.svc.get(true), full);
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

test('D8: reloadChip follows a change by another window to the saved setting, tells every page, and is quiet when nothing changed', () => {
  let stored = null;
  const calls = [];
  const r = rig({ chipStore: { read: () => stored, write: () => {} }, send: (full, light) => calls.push([full, light]) });
  r.svc.onUpdate(fullSnap(2, 10));
  const before = calls.length;
  assert.strictEqual(r.svc.reloadChip(), true);
  assert.strictEqual(calls.length, before, 'unchanged: nothing is sent');
  stored = false;
  assert.strictEqual(r.svc.reloadChip(), false);
  assert.strictEqual(r.svc.chipOn(), false);
  assert.strictEqual(calls.length, before + 1);
  assert.strictEqual(calls.at(-1)[0].chipOn, false);
  assert.strictEqual(calls.at(-1)[1].chipOn, false);
  assert.ok(calls.at(-1)[0].model, 'the model is not lost');
  stored = 'garbage';
  assert.strictEqual(r.svc.reloadChip(), true, 'an unusable value is "never set": on');
});

test('D8: a toggle made before the first sample is still sent to the pages (a payload with no model), not held back', () => {
  const calls = [];
  const r = rig({ chipStore: { read: () => null, write: () => {} }, send: (full, light) => calls.push([full, light]) });
  assert.strictEqual(r.svc.get(), null, 'no sample yet: nothing to hand out');
  assert.strictEqual(r.svc.setChip(false), false);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0].chipOn, false);
  assert.strictEqual(calls[0][0].model, null);
  assert.strictEqual(r.svc.get().chipOn, false, 'and a page that opens now is told');
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

// ---- the one-hour history (#63 follow-up) -----------------------------------------------------------------------
// Points are ordered and spaced by a MONOTONIC clock (`mono`), never by the wall clock (Dexter, PR #114 D1/D3): one wall-clock
// step must not freeze or reorder the ring. A break is explicit (a null point, a minimise, a long silence), never a guess from
// the spacing, because the cadence is a 10 s gap AFTER a sample and a slow sample is not a missed one (D3).

function hrig(extra = {}) {
  let t = 100000;
  let wall = 5000;
  const r = rig({ mono: () => t, now: () => wall, ...extra });
  r.tick = (ms) => { t += ms; wall += ms; };
  r.jumpWall = (ms) => { wall += ms; };
  return r;
}
const hist = r => r.sent.at(-1).history;

test('history: each fresh sample adds one point (machine and ours), in the SELECTED page payload', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(2, 50));
  const p = r.sent.at(-1);
  assert.strictEqual(p.history.length, 1);
  assert.strictEqual(p.historyNow, 100000, 'the monotonic "now" the points are measured against');
  const pt = p.history[0];
  assert.strictEqual(pt.at, 100000);
  assert.ok(Math.abs(pt.cpu - 50) < 0.06);
  assert.ok(Math.abs(pt.cpuOurs - 50) < 0.06);
  assert.strictEqual(pt.memUsed, 600);
  assert.strictEqual(pt.memTotal, 1000);
  assert.strictEqual(pt.memOurs, 850, 'ours: the private working sets of the process tree');
});

test('history: only the full (selected page) payload carries it, and get(false) does not', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(2, 50));
  assert.strictEqual(r.svc.get(true).history.length, 1);
  assert.strictEqual(r.svc.get(false).history, undefined);
  assert.strictEqual(r.svc.get(true).historyNow, 100000);
});

test('history: values are rounded at record time (CPU to 0.1)', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(2, 33.3333));
  assert.strictEqual(hist(r)[0].cpuOurs, 33.3);
});

test('history: the first sample has no CPU yet, so cpu is null (not 0) and memory is there', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(1, 50));
  const pt = hist(r)[0];
  assert.strictEqual(pt.cpu, null);
  assert.strictEqual(pt.memUsed, 600);
});

test('history: a machine-only sample records the machine and no "ours"', () => {
  const r = hrig();
  r.svc.onUpdate(snap({ mode: 'machine', machine: { last: sampleAt(world(), 0, 2), prev: sampleAt(world(), 0, 1) } }));
  const pt = hist(r)[0];
  assert.ok(Math.abs(pt.cpu - 50) < 0.06);
  assert.strictEqual(pt.cpuOurs, null);
  assert.strictEqual(pt.memOurs, null);
});

test('history: a re-sent old sample (the same sample object) adds no point', () => {
  const r = hrig();
  const s = fullSnap(2, 50);
  r.svc.onUpdate(s);
  r.tick(10000);
  r.svc.onUpdate({ ...s });
  assert.strictEqual(hist(r).length, 1);
});

test('D1: one wall-clock step (4 h ahead, then corrected) neither freezes nor reorders the ring', () => {
  const r = hrig();
  r.svc.onUpdate({ ...fullSnap(2, 50), lastGoodAt: 1000 });
  r.tick(10000); r.jumpWall(4 * 3600 * 1000);
  r.svc.onUpdate({ ...fullSnap(3, 50), lastGoodAt: 4 * 3600 * 1000 + 11000 });
  r.tick(10000); r.jumpWall(-4 * 3600 * 1000);
  r.svc.onUpdate({ ...fullSnap(4, 50), lastGoodAt: 21000 });
  r.tick(10000);
  r.svc.onUpdate({ ...fullSnap(5, 50), lastGoodAt: 31000 });
  const h = hist(r);
  assert.strictEqual(h.length, 4, 'every fresh sample kept its point');
  assert.deepStrictEqual(h.map(p => p.at), [100000, 110000, 120000, 130000], 'in monotonic order, 10 s apart');
});

test('D1: a wall-clock step shows as a break (a jump of either sign), the monotonic spacing does not', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.tick(10000);
  r.svc.onUpdate(fullSnap(3, 50));
  r.tick(10000); r.jumpWall(-3600 * 1000);
  r.svc.onUpdate(fullSnap(4, 50));
  const h = hist(r);
  assert.strictEqual(h[1].brk, undefined);
  assert.strictEqual(h[2].brk, true);
});

test('D3: a slow but good sample (30 s after the last) is not a break', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.tick(30000);
  r.svc.onUpdate(fullSnap(3, 50));
  assert.strictEqual(hist(r)[1].brk, undefined);
});

test('history: a long silence (over a minute with no sample at all) is a break', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.tick(61000);
  r.svc.onUpdate(fullSnap(3, 50));
  assert.strictEqual(hist(r)[1].brk, true);
});

test('D4: a Stop re-read that stands in for a cadence tick still records its point; one right after a point adds none', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.tick(9500);
  r.svc.onUpdate({ ...fullSnap(3, 50), adhoc: true });       // the cadence tick joined this read: it is that slot's point
  assert.strictEqual(hist(r).length, 2);
  r.tick(1000);
  r.svc.onUpdate({ ...fullSnap(4, 50), adhoc: true });       // a second read 1 s later is not a new slot
  assert.strictEqual(hist(r).length, 2);
});

test('history: a failed Stop re-read records nothing; a failed cadence sample is a null point (a break, never a 0)', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.tick(10000);
  r.svc.onUpdate({ ...fullSnap(2, 50), failures: 1, stale: true, adhoc: true });
  assert.strictEqual(hist(r).length, 1);
  r.svc.onUpdate({ ...fullSnap(2, 50), failures: 1, stale: true });
  const h = hist(r);
  assert.strictEqual(h.length, 2);
  assert.deepStrictEqual([h[1].cpu, h[1].memUsed, h[1].cpuOurs, h[1].memOurs], [null, null, null, null]);
});

test('history: minimising marks a break before the next point; the points already there stay', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.svc.setMinimised(true);
  r.tick(6000);
  r.svc.setMinimised(false);
  r.svc.onUpdate(fullSnap(3, 50));
  const h = hist(r);
  assert.strictEqual(h.length, 2);
  assert.strictEqual(h[1].brk, true);
});

test('history: a chip toggle keeps the history and adds no break', () => {
  const r = hrig();
  r.svc.onUpdate(fullSnap(2, 50));
  r.svc.setChip(false);
  assert.strictEqual(hist(r).length, 1);
  assert.strictEqual(hist(r)[0].brk, undefined);
});

test('history: a bare push before any sample carries an empty history, and resend() sends the last payloads again', () => {
  const r = hrig();
  r.svc.setChip(false);
  assert.deepStrictEqual(hist(r), []);
  r.svc.onUpdate(fullSnap(2, 50));
  const n = r.sent.length;
  r.svc.resend();
  assert.strictEqual(r.sent.length, n + 1);
  assert.strictEqual(r.sent.at(-1).history.length, 1);
});

// ---- Leftovers (BACKLOG #74 item 6) ---------------------------------------------------------------------------

const NOWMS = 1_800_000_000_000;
const ftOf = ms => String(BigInt(ms) * 10000n + 116444736000000000n);
// a probe's Electron (pid 90) whose launcher (pid 91) is gone; the window (10) is not its parent
function leftoverWorld() {
  const procs = world();
  procs.push({ pid: 90, ppid: 1, name: 'electron.exe', cmd: 'electron.exe probe', priv: 700, start: ftOf(NOWMS - 60 * 60_000), threads: 9, handles: 80 });
  return procs;
}
const probeEntry = over => ({ pid: 90, start: ftOf(NOWMS - 60 * 60_000), launcher: { pid: 91, start: ftOf(NOWMS - 61 * 60_000) }, kind: 'probe-window', label: 'probe-x', createdAt: NOWMS - 30 * 60_000, ...over });
const tick = () => new Promise(r => setImmediate(r));

test('Leftovers: the full page gets the readout, the light one never does', () => {
  const r = rig({ now: () => NOWMS, ledger: () => [probeEntry({ createdAt: NOWMS - 5 * 60_000 })] });
  r.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  const full = r.sent.at(-1);
  assert.deepStrictEqual(full.leftovers.probes.map(x => x.pid), [90]);
  assert.strictEqual(full.leftovers.probes[0].reapInMs, 10 * 60_000);
  assert.strictEqual(full.leftovers.probes[0].bytes, 700);
  assert.ok(!('entry' in full.leftovers.probes[0]));
  assert.ok(!('leftovers' in (r.svc.get(false) || {})) || r.svc.get(false).leftovers === undefined);
});

test('Leftovers: nothing left means no readout (null), not an empty one', () => {
  const r = rig({ now: () => NOWMS, ledger: () => [] });
  r.svc.onUpdate(fullSnap(2, 10));
  assert.strictEqual(r.sent.at(-1).leftovers, null);
});

test('Leftovers: a proven probe older than 15 minutes is stopped through the injected kill with the ledger\'s start, once, and listed as stopped', async () => {
  const calls = [];
  const tomb = [];
  const r = rig({
    now: () => NOWMS, ledger: () => [probeEntry()],
    reap: { kill: (pid, start) => { calls.push([pid, start]); return 'killed'; }, removeEntries: (es) => { tomb.push(...es.map(e => e.pid)); return { ok: true }; } },
  });
  r.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  await tick();
  assert.deepStrictEqual(calls, [[90, probeEntry().start]]);
  assert.deepStrictEqual(tomb, [90]);
  r.svc.onUpdate(fullSnap(3, 10, world()));
  assert.deepStrictEqual(r.sent.at(-1).leftovers.stopped.map(s => [s.pid, s.label]), [[90, 'probe-x']]);
  r.svc.onUpdate(fullSnap(4, 10, leftoverWorld()));
  await tick();
  assert.strictEqual(calls.length, 1, 'never killed twice');
});

test('Leftovers: no reap is wired (or the sample is expired, or the pid is not proven) means nothing is stopped', async () => {
  const calls = [];
  const kill = (pid) => { calls.push(pid); return 'killed'; };
  const none = rig({ now: () => NOWMS, ledger: () => [probeEntry()] });
  none.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  const expired = rig({ now: () => NOWMS, ledger: () => [probeEntry()], reap: { kill } });
  expired.svc.onUpdate({ ...fullSnap(2, 10, leftoverWorld()), expired: true, failures: 3 });
  const reused = rig({ now: () => NOWMS, ledger: () => [probeEntry({ start: ftOf(NOWMS - 5 * 60_000) })], reap: { kill } });
  reused.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  await tick();
  assert.deepStrictEqual(calls, []);
});

test('Leftovers: a ledger that throws does not stop the panel; the readout is just empty', () => {
  const r = rig({ now: () => NOWMS, ledger: () => { throw new Error('locked'); }, log: () => {} });
  r.svc.onUpdate(fullSnap(2, 10));
  assert.ok(r.sent.at(-1).model);
});
