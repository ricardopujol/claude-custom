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
const MINUTE = 60_000;
const ftOf = ms => String(BigInt(ms) * 10000n + 116444736000000000n);
// a probe's Electron (pid 90) whose launcher (pid 91) is gone from the table; the window (10) is not its parent
function leftoverWorld() {
  const procs = world();
  procs.push({ pid: 90, ppid: 1, name: 'electron.exe', cmd: 'electron.exe probe', priv: 700, start: ftOf(NOWMS - 60 * MINUTE), threads: 9, handles: 80 });
  return procs;
}
const probeEntry = over => ({ pid: 90, start: ftOf(NOWMS - 60 * MINUTE), launcher: { pid: 91, start: ftOf(NOWMS - 61 * MINUTE) }, kind: 'probe-window', label: 'probe-x', createdAt: NOWMS - 30 * MINUTE, ...over });
const macrotask = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await macrotask(); };

// a service whose clock the test moves, with a reap that records what it does
function leftRig(extra = {}) {
  const clock = { t: NOWMS };
  const calls = { kill: [], removed: [] };
  const reap = {
    kill: (pid, start) => { calls.kill.push([pid, start]); return 'killed'; },
    launcherGone: async () => true, isRunning: async () => false,
    removeEntries: (es) => { calls.removed.push(...es.map(e => e.pid)); return { ok: true }; },
  };
  const r = rig({ now: () => clock.t, ledger: () => [probeEntry()], reap, ...extra });
  return { ...r, clock, calls };
}

test('Leftovers: the full page gets the readout, the light one never does', () => {
  const r = leftRig({ reap: null });
  r.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  const full = r.sent.at(-1);
  assert.deepStrictEqual(full.leftovers.probes.map(x => x.pid), [90]);
  assert.strictEqual(full.leftovers.probes[0].reapInMs, 15 * MINUTE, 'the 15 minutes start when the launcher is first seen gone');
  assert.strictEqual(full.leftovers.probes[0].bytes, 700);
  assert.strictEqual(full.leftovers.probes[0].provable, true);
  assert.ok(!('entry' in full.leftovers.probes[0]));
  assert.strictEqual((r.svc.get(false) || {}).leftovers, undefined);
});

test('Leftovers: nothing left means no readout (null), not an empty one', () => {
  const r = rig({ now: () => NOWMS, ledger: () => [] });
  r.svc.onUpdate(fullSnap(2, 10));
  assert.strictEqual(r.sent.at(-1).leftovers, null);
});

test('Leftovers (E): a probe is stopped 15 minutes after its launcher was FIRST seen gone, through the injected kill with the ledger\'s start, once, and listed as stopped', async () => {
  const r = leftRig();
  r.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  await settle();
  assert.deepStrictEqual(r.calls.kill, [], 'created 30 minutes ago, but the launcher only just went');
  r.clock.t += 15 * MINUTE;
  r.svc.onUpdate(fullSnap(3, 10, leftoverWorld()));
  await settle();
  assert.deepStrictEqual(r.calls.kill, [[90, probeEntry().start]]);
  assert.deepStrictEqual(r.calls.removed, [90]);
  r.svc.onUpdate(fullSnap(4, 10, world()));
  assert.deepStrictEqual(r.sent.at(-1).leftovers.stopped.map(s => [s.pid, s.label, s.by]), [[90, 'probe-x', 'auto']]);
  r.svc.onUpdate(fullSnap(5, 10, leftoverWorld()));
  await settle();
  assert.strictEqual(r.calls.kill.length, 1, 'never killed twice');
});

test('F2 + I1: the reap starts only AFTER the payload is sent, and no kill runs inside onUpdate\'s turn', async () => {
  const order = [];
  const calls = { kill: 0 };
  const sent = [];
  const clock = { t: NOWMS };
  const reap = {
    kill: () => { order.push('kill'); return 'killed'; }, launcherGone: async () => true, isRunning: async () => false, removeEntries: () => ({ ok: true }),
  };
  const r = rig({ now: () => clock.t, ledger: () => [probeEntry()], reap, send: () => order.push('send') });
  r.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  clock.t += 15 * MINUTE;
  order.length = 0;
  r.svc.onUpdate(fullSnap(3, 10, leftoverWorld()));
  assert.deepStrictEqual(order, ['send'], 'nothing was killed synchronously');
  await settle();
  assert.deepStrictEqual(order, ['send', 'kill']);
  assert.ok(calls && sent);
});

test('Leftovers: no reap wired, an expired sample, or a pid whose start does not match means nothing is stopped', async () => {
  const none = leftRig({ reap: null });
  none.clock.t += 99 * MINUTE; none.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  const expired = leftRig();
  expired.svc.onUpdate({ ...fullSnap(2, 10, leftoverWorld()), expired: true, failures: 3 });
  expired.clock.t += 99 * MINUTE;
  expired.svc.onUpdate({ ...fullSnap(3, 10, leftoverWorld()), expired: true, failures: 3 });
  const reused = leftRig({ ledger: () => [probeEntry({ start: ftOf(NOWMS - 5 * MINUTE) })] });
  reused.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  reused.clock.t += 99 * MINUTE;
  reused.svc.onUpdate(fullSnap(3, 10, leftoverWorld()));
  await settle();
  assert.deepStrictEqual([none.calls.kill, expired.calls.kill, reused.calls.kill], [[], [], []]);
});

test('I2: a piece of the Leftovers work that throws costs the section only; the model is still sent, and it is said', () => {
  const pieces = [
    ['the ledger', { ledger: () => { throw new Error('locked'); } }],
    ['a ledger entry', { ledger: () => [{ pid: 90, start: ftOf(NOWMS - 60 * MINUTE), launcher: { pid: 91 }, get kind() { throw new Error('bad entry'); } }] }],
  ];
  for (const [what, extra] of pieces) {
    const logs = [];
    const r = leftRig({ ...extra, log: (...a) => logs.push(a.join(' ')) });
    r.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
    assert.ok(r.sent.at(-1).model, `${what}: the model is still sent`);
    assert.strictEqual(r.sent.at(-1).leftovers, null, what);
    assert.ok(logs.some(l => /locked|no installs|bad entry/.test(l)), `${what}: said, not swallowed`);
  }
});

test('F4: a probe whose subtree holds one of this window\'s tab hosts is not listed (and so never stopped)', async () => {
  const procs = world();
  procs.push({ pid: 90, ppid: 1, name: 'electron.exe', cmd: 'electron.exe probe', priv: 700, start: ftOf(NOWMS - 60 * MINUTE), threads: 9, handles: 80 });
  // the tab host (pid 20) and its children hang under the probe root
  procs.find(p => p.pid === 20).ppid = 90;
  procs.find(p => p.pid === 20).start = ftOf(NOWMS - 30 * MINUTE);
  procs.find(p => p.pid === 22).start = ftOf(NOWMS - 29 * MINUTE);
  procs.find(p => p.pid === 23).start = ftOf(NOWMS - 28 * MINUTE);
  const claims = [{ pid: 20, port: 7701, cwd: 'C:\\r\\dev', processStartedAt: procs.find(p => p.pid === 20).start }];
  const r = leftRig({ claims: () => claims });
  r.svc.onUpdate(fullSnap(2, 10, procs));
  r.clock.t += 99 * MINUTE;
  r.svc.onUpdate(fullSnap(3, 10, procs));
  await settle();
  assert.deepStrictEqual(r.calls.kill, []);
  assert.strictEqual(r.sent.at(-1).leftovers, null);
});

test('B: a manual Stop ends provable rows now, resolved from the latest sample, never from what the page says', async () => {
  const r = leftRig();
  r.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  const res = await r.svc.stopLeftovers({ rows: [{ pid: 90, start: probeEntry().start }] });
  assert.deepStrictEqual(res, { ok: true, stopped: 1, failed: 0 });
  assert.deepStrictEqual(r.calls.kill, [[90, probeEntry().start]], 'no 15 minutes: the person asked');
  assert.deepStrictEqual(r.calls.removed, [90]);
});

test('B: a manual Stop refuses a pid the latest sample does not hold as provable, a wrong start, and junk', async () => {
  const r = leftRig();
  r.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  const requests = [
    { rows: [{ pid: 23, start: world()[3].start }] },
    { rows: [{ pid: 90, start: '1' }] },
    { rows: [{ pid: '90', start: probeEntry().start }] },
    { rows: [] }, { group: 'mcp' }, { group: 'nope' }, null, 'x', {},
  ];
  for (const req of requests) {
    const res = await r.svc.stopLeftovers(req);
    assert.strictEqual(res.ok, false, JSON.stringify(req));
  }
  assert.deepStrictEqual(r.calls.kill, []);
});

test('B: "Stop N" for a group stops every provable row of that group', async () => {
  const procs = leftoverWorld();
  procs.push({ pid: 92, ppid: 1, name: 'electron.exe', cmd: 'electron.exe probe2', priv: 300, start: ftOf(NOWMS - 50 * MINUTE), threads: 9, handles: 80 });
  const r = leftRig({ ledger: () => [probeEntry(), probeEntry({ pid: 92, start: ftOf(NOWMS - 50 * MINUTE), label: 'probe-z' })] });
  r.svc.onUpdate(fullSnap(2, 10, procs));
  const res = await r.svc.stopLeftovers({ group: 'probes' });
  assert.deepStrictEqual(res, { ok: true, stopped: 2, failed: 0 });
  assert.deepStrictEqual(r.calls.kill.map(k => k[0]).sort(), [90, 92]);
});

test('B: with no reap wired a manual Stop does nothing and says so', async () => {
  const r = leftRig({ reap: null });
  r.svc.onUpdate(fullSnap(2, 10, leftoverWorld()));
  assert.strictEqual((await r.svc.stopLeftovers({ group: 'probes' })).ok, false);
});


// ---- Leftovers: big task-output files (BACKLOG #74 F(3)) -------------------------------------------------------
// Ricardo's rule (PR #133 review): the app deletes by itself only a file whose session it SAW alive and then saw end, judged
// against a process list taken wholly AFTER the registry was read (Dexter #2).

const MBYTES = 1024 * 1024;
const taskFile = (over = {}) => ({
  path: `C:\\t\\claude\\p\\${over.session || 'sess-1'}\\tasks\\a1.output`, project: 'p', session: 'sess-1', name: 'a1.output',
  bytes: 300 * MBYTES, mtimeMs: NOWMS - 40 * MINUTE, dev: '1', ino: '10', nlink: 1, ...over,
});
// pid 4242 is session sess-1's claude: `world4242.on` says whether it is in the process table AND its registry entry exists
function taskRig(extra = {}, files = [taskFile()]) {
  const clock = { t: NOWMS };
  const calls = { scan: 0, removed: [], logs: [] };
  const world4242 = { on: true };
  const extraProcs = [];
  let regNow = null;
  const taskLogs = {
    everyMs: 60_000,
    scan: async () => { calls.scan++; return files; },
    registry: async () => regNow || ({ ok: true, entries: [{ pid: 5555, sessionId: 'tab' }, ...(world4242.on ? [{ pid: 4242, sessionId: 'sess-1' }] : [])] }),
    remove: async (row) => { calls.removed.push(row.key); return { deleted: row.paths.length, failed: 0, kept: 0, freed: row.bytes }; },
    ...extra.taskLogs,
  };
  const r = rig({ now: () => clock.t, ledger: () => [], taskLogs, log: (...a) => calls.logs.push(a.join(' ')), ...extra.rig });
  const procsWith = () => {
    const p = world();
    p.push({ pid: 5555, ppid: 1, name: 'claude.exe', cmd: 'claude.exe', priv: 10, start: '1' });
    if (world4242.on) p.push({ pid: 4242, ppid: 1, name: 'claude.exe', cmd: 'claude.exe', priv: 10, start: '2' });
    return [...p, ...extraProcs];
  };
  let n = 1;
  const tick = async (over = {}) => { r.svc.onUpdate({ ...fullSnap(++n, 10, procsWith()), ...over }); await settle(); };
  // a scan starts on one fresh sample; the file is judged on the SECOND fresh sample after the read (taken wholly after it)
  const judge = async () => { await tick(); await tick(); await tick(); };
  return { ...r, clock, calls, world4242, tick, judge, extraProcs, procsWith, syncReread: () => r.setReread(procsWith()), setRegistry: (x) => { regNow = x; } };
}

test('task logs: the first sample starts a scan; once judged, the payload lists the file with its size, age and why, and no paths', async () => {
  const r = taskRig({}, [taskFile({ mtimeMs: NOWMS - 5 * MINUTE })]);
  await r.tick();
  assert.strictEqual(r.sent.at(-1).leftovers, null, 'nothing scanned yet when the first payload went out');
  await r.judge();
  const row = r.sent.at(-1).leftovers.taskLogs[0];
  assert.deepStrictEqual([row.name, row.bytes, row.ageMs, row.why, row.sessions], ['a1.output', 300 * MBYTES, 5 * MINUTE, 'alive', ['sess-1']]);
  assert.ok(!('paths' in row));
  assert.strictEqual((r.svc.get(false) || {}).leftovers, undefined);
});

test('task logs: a file is removed only after its session was SEEN alive and then SEEN ended; listed as deleted with the bytes freed', async () => {
  const r = taskRig();
  await r.judge();                     // read 1 judged: sess-1 is alive (registry entry, pid listed): seen
  assert.deepStrictEqual(r.calls.removed, []);
  r.world4242.on = false;              // the session ends: its registry file goes, its process goes
  await r.tick();
  await r.tick();                      // inside the cadence: no scan
  assert.strictEqual(r.calls.scan, 1);
  assert.deepStrictEqual(r.calls.removed, []);
  r.clock.t += 61_000;
  await r.judge();                     // read 2 judged: seen, now ended
  assert.deepStrictEqual(r.calls.removed, ['1:10']);
  await r.tick();
  const l = r.sent.at(-1).leftovers;
  assert.deepStrictEqual(l.deleted.map(d => [d.name, d.bytes]), [['a1.output', 300 * MBYTES]]);
  assert.deepStrictEqual(l.taskLogs, [], 'a deleted file leaves the list at once');
});

test('REGRESSION (Dexter #1): registry [{5555,tab}] with pid 5555 live, a file of another session idle 20 min: NOT deleted, shown as unknown with a manual Delete', async () => {
  const r = taskRig({}, [taskFile({ session: 'other', path: 'C:\\t\\claude\\p\\other\\tasks\\a1.output' })]);
  await r.judge();
  r.clock.t += 61_000;
  await r.judge();
  await r.tick();
  assert.deepStrictEqual(r.calls.removed, []);
  const row = r.sent.at(-1).leftovers.taskLogs[0];
  assert.deepStrictEqual([row.why, row.deletable, row.manualDelete], ['unknown', false, true]);
});

test('task logs: a session alive now (registry entry, pid listed) is shown and never removed', async () => {
  const r = taskRig();
  for (let i = 0; i < 3; i++) { r.clock.t += 61_000; await r.judge(); }
  assert.deepStrictEqual(r.calls.removed, []);
  assert.strictEqual(r.sent.at(-1).leftovers.taskLogs[0].why, 'alive');
});

test('REGRESSION (Dexter #2): a session resumed between the process sample and the registry read is alive, not gone; with no such process it is ended', async () => {
  for (const [resumed, removed] of [[true, []], [false, ['1:10']]]) {
    const r = taskRig();
    await r.judge();                   // sess-1 seen alive (pid 4242)
    r.world4242.on = false;
    // the registry now names the resumed session's NEW pid 9999; the sample current when the read starts does not list it yet
    r.setRegistry({ ok: true, entries: [{ pid: 5555, sessionId: 'tab' }, { pid: 9999, sessionId: 'sess-1' }] });
    r.clock.t += 61_000;
    await r.tick();                    // the read starts (and ends) on this sample
    if (resumed) r.extraProcs.push({ pid: 9999, ppid: 1, name: 'claude.exe', cmd: 'claude.exe', priv: 10, start: '3' });
    await r.tick();
    assert.deepStrictEqual(r.calls.removed, [], 'one sample after the read is not yet enough to judge on');
    await r.tick();
    assert.deepStrictEqual(r.calls.removed, removed, resumed ? 'its new process is in the sample the judgement used' : 'no such process: the entry is stale and the session has ended');
  }
});

test('task logs: written in the last 15 minutes, or an unreadable registry, means shown only', async () => {
  for (const [files, extra, why] of [
    [[taskFile({ mtimeMs: NOWMS - 5 * MINUTE })], {}, 'alive'],
    [[taskFile({ session: 'gone', mtimeMs: NOWMS - 5 * MINUTE })], {}, 'young'],
    [[taskFile()], { taskLogs: { registry: async () => ({ ok: false, entries: [] }) } }, 'unknown'],
  ]) {
    const r = taskRig(extra, files);
    await r.judge();
    r.clock.t += 61_000;
    await r.judge();
    await r.tick();
    assert.deepStrictEqual(r.calls.removed, [], why);
    assert.strictEqual(r.sent.at(-1).leftovers.taskLogs[0].why, why);
  }
});

test('task logs: the scan runs on its own slow cadence, never twice at once', async () => {
  let release;
  const gate = new Promise(res => { release = res; });
  const r = taskRig({ taskLogs: { scan: async () => { r.calls.scan++; await gate; return []; } } });
  await r.tick();
  r.clock.t += 61_000;
  await r.tick();
  assert.strictEqual(r.calls.scan, 1, 'one in flight');
  release();
  await settle();
  await r.tick();
  await r.tick();
  await r.tick();
  assert.strictEqual(r.calls.scan, 1, 'a scan just finished: not again inside the cadence');
  r.clock.t += 61_000;
  await r.tick();
  assert.strictEqual(r.calls.scan, 2);
});

test('task logs: an expired sample, a stale one, a Stop re-read (adhoc) or a failing scan never scans or deletes, and a failing scan costs only the group', async () => {
  const exp = taskRig();
  await exp.tick({ expired: true, failures: 3 });
  const adhoc = taskRig();
  await adhoc.tick({ adhoc: true });
  const stale = taskRig();
  await stale.tick({ stale: true, failures: 1 });
  await stale.tick({ stale: true, failures: 1 });
  await stale.tick({ stale: true, failures: 2 });
  assert.deepStrictEqual([exp.calls.scan, exp.calls.removed, adhoc.calls.scan, adhoc.calls.removed, stale.calls.scan, stale.calls.removed], [0, [], 0, [], 0, []]);
  const bad = taskRig({ taskLogs: { scan: async () => { throw new Error('EPERM scan'); } } });
  await bad.tick();
  await bad.tick();
  assert.ok(bad.sent.at(-1).model);
  assert.ok(bad.calls.logs.some(l => /EPERM scan/.test(l)));
  assert.deepStrictEqual(bad.calls.removed, []);
});

test('task logs: the SAME sample object re-sent (the sampler does this after a failed read) counts once and never advances a judgement', async () => {
  const r = taskRig();
  const snapA = fullSnap(2, 10, r.procsWith());
  r.svc.onUpdate(snapA);
  await settle();
  r.svc.onUpdate(snapA);
  r.svc.onUpdate(snapA);
  r.svc.onUpdate(snapA);
  await settle();
  assert.deepStrictEqual(r.calls.removed, []);
  assert.strictEqual(r.sent.at(-1).leftovers, null, 'still waiting for two NEW samples: nothing was judged');
});

test('task logs: a manual Delete removes a row the person may choose to delete (even an unknown one), by its key, and refuses anything else', async () => {
  const unknown = [taskFile({ session: 'other', path: 'C:\\t\\claude\\p\\other\\tasks\\a1.output' })];
  const r = taskRig({ taskLogs: { everyMs: 1e12 } }, unknown);
  r.syncReread();
  await r.tick();
  for (const req of [{ taskLog: 'nope' }, { taskLog: 5 }, { taskLog: '' }]) assert.strictEqual((await r.svc.stopLeftovers(req)).ok, false, JSON.stringify(req));
  assert.deepStrictEqual(r.calls.removed, []);
  assert.deepStrictEqual(await r.svc.stopLeftovers({ taskLog: '1:10' }), { ok: true, stopped: 1, failed: 0 });
  assert.deepStrictEqual(r.calls.removed, ['1:10']);
  const young = taskRig({ taskLogs: { everyMs: 1e12 } }, [taskFile({ session: 'other', mtimeMs: NOWMS - MINUTE })]);
  young.syncReread();
  assert.strictEqual((await young.svc.stopLeftovers({ taskLog: '1:10' })).ok, false);
  const alive = taskRig({ taskLogs: { everyMs: 1e12 } });
  alive.syncReread();
  assert.strictEqual((await alive.svc.stopLeftovers({ taskLog: '1:10' })).ok, false, 'a live session\'s file has no manual Delete');
  assert.deepStrictEqual([young.calls.removed, alive.calls.removed], [[], []]);
});

test('REGRESSION (Dexter #2): a manual Delete judges against a process list taken AFTER it read the registry; if that list cannot be had it refuses', async () => {
  const unknown = [taskFile({ session: 'other', path: 'C:\\t\\claude\\p\\other\\tasks\\a1.output' })];
  const order = [];
  const r = taskRig({
    taskLogs: { everyMs: 1e12, registry: async () => { order.push('registry'); return { ok: true, entries: [{ pid: 5555, sessionId: 'tab' }, { pid: 9999, sessionId: 'other' }] }; } },
    rig: { sampler: { setWanted: () => {}, snapshot: () => null, sampleNow: async () => { order.push('sample'); return null; } } },
  }, unknown);
  assert.strictEqual((await r.svc.stopLeftovers({ taskLog: '1:10' })).ok, false, 'no fresh process list: refused');
  assert.deepStrictEqual(order, ['registry', 'sample'], 'the process list is read after the registry');
  assert.deepStrictEqual(r.calls.removed, []);
});

// An auto-delete round: the session was seen alive, then ends; the next judged read removes the file.
async function endedRig(remove) {
  const r = taskRig({ taskLogs: { remove: async (row) => { r.calls.removed.push(row.key); return remove(row); } } });
  await r.judge();
  r.world4242.on = false;
  r.clock.t += 61_000;
  return r;
}
const clean = (row, over = {}) => ({ deleted: row.paths.length, gone: 0, locked: 0, failed: 0, kept: 0, freed: row.bytes, held: false, deletedPaths: row.paths, ...over });

test('task logs (Dexter #3): a deleted file whose space is still held open is listed as deleted but "held", never as freed', async () => {
  const r = await endedRig(row => clean(row, { freed: 0, held: true }));
  await r.judge();
  await r.tick();
  const d = r.sent.at(-1).leftovers.deleted;
  assert.deepStrictEqual(d.map(x => [x.name, x.held]), [['a1.output', true]]);
});

test('task logs (Miguel I5): a locked file is not retried every minute; the row says locked, keeps a manual Delete, and is tried again after the back-off', async () => {
  const r = await endedRig(row => clean(row, { deleted: 0, locked: 1, freed: 0, deletedPaths: [] }));
  await r.judge();
  assert.deepStrictEqual(r.calls.removed, ['1:10']);
  for (let i = 0; i < 5; i++) { r.clock.t += 61_000; await r.judge(); }
  assert.strictEqual(r.calls.removed.length, 1, 'no retry inside the back-off');
  const row = r.sent.at(-1).leftovers.taskLogs[0];
  assert.deepStrictEqual([row.why, row.deletable, row.manualDelete], ['locked', false, true]);
  assert.strictEqual(r.sent.at(-1).leftovers.deleted.length, 0, 'nothing was freed');
  r.clock.t += 31 * 60_000;
  await r.judge();
  assert.strictEqual(r.calls.removed.length, 2, 'tried again after the back-off');
});

test('task logs (Miguel I6): a partial hard-link delete lists nothing freed, and backs off', async () => {
  const files = [taskFile({ nlink: 2 }), taskFile({ nlink: 2, name: 'a2.output', path: 'C:\t\claude\p\sess-1\tasks\a2.output' })];
  const r = taskRig({ taskLogs: { remove: async (row) => { r.calls.removed.push(row.key); return { deleted: 1, gone: 0, locked: 1, failed: 0, kept: 0, freed: 0, held: false, deletedPaths: [row.paths[0]] }; } } }, files);
  await r.judge();
  r.world4242.on = false;
  r.clock.t += 61_000;
  await r.judge();
  await r.tick();
  assert.deepStrictEqual(r.calls.removed, ['1:10']);
  assert.strictEqual(r.sent.at(-1).leftovers.deleted.length, 0, 'no freed claim');
  assert.notStrictEqual(r.sent.at(-1).leftovers.taskLogs[0].why, 'delete', 'the remaining link is kept until the next scan shows it');
});

test('task logs (Dexter #5): a file already gone (another window won the race) leaves the list quietly: no failure logged, no "freed" line', async () => {
  const r = await endedRig(row => clean(row, { deleted: 0, gone: row.paths.length, freed: 0, deletedPaths: [] }));
  await r.judge();
  await r.tick();
  assert.deepStrictEqual(r.sent.at(-1).leftovers, null, 'nothing left to show');
  assert.ok(!r.calls.logs.some(l => /not deleted/.test(l)), r.calls.logs.join('|'));
});

test('REGRESSION (Dexter #4): a forward wall-clock step does not make a just-written file "15 minutes idle"; it needs 15 monotonic minutes too, and the person\'s Delete is not held back', async () => {
  const m = { t: 1000 };
  const files = [taskFile({ mtimeMs: NOWMS - 30_000 })];       // written 30 s ago when first seen
  const r = taskRig({ rig: { mono: () => m.t }, taskLogs: { everyMs: 60_000 } }, files);
  await r.judge();                                               // first sighting: young, session alive (seen)
  r.world4242.on = false;
  r.clock.t += 20 * MINUTE; m.t += 70_000;                       // the wall clock jumps 20 min; 70 s really passed
  await r.judge();
  assert.deepStrictEqual(r.calls.removed, [], 'wall age is 20 min but only ~100 s are proven by the monotonic clock');
  const row = r.sent.at(-1).leftovers.taskLogs[0];
  assert.deepStrictEqual([row.why, row.deletable, row.manualDelete], ['settling', false, true]);
  r.clock.t += 16 * MINUTE; m.t += 16 * MINUTE;
  await r.judge();
  assert.deepStrictEqual(r.calls.removed, ['1:10'], 'idle for 15+ real minutes too: now it goes');
});

test('task logs: a file whose size or mtime changed between two judged reads starts its idle count again', async () => {
  const m = { t: 1000 };
  let size = 300 * MBYTES;
  const r = taskRig({ rig: { mono: () => m.t }, taskLogs: { scan: async () => [taskFile({ bytes: size, mtimeMs: NOWMS - 40 * MINUTE })] } });
  await r.judge();
  r.world4242.on = false;
  size += 4096;                                                   // grew, with the same (lagging) mtime
  r.clock.t += 61_000; m.t += 61_000;
  await r.judge();
  assert.deepStrictEqual(r.calls.removed, [], 'changed since the last read: first sighting again');
  r.clock.t += 61_000; m.t += 61_000;
  await r.judge();
  assert.deepStrictEqual(r.calls.removed, ['1:10'], 'unchanged across two reads: idle');
});

test('REGRESSION (Dexter r2 #1): a seen session whose registry entry disappears (its tab dir no longer read, a removed file) while its pid still runs is NEVER deleted; it goes when that pid goes', async () => {
  const r = taskRig();
  await r.judge();                                   // sess-1 seen alive under pid 4242
  r.setRegistry({ ok: true, entries: [{ pid: 5555, sessionId: 'tab' }] });   // the registry no longer lists sess-1; pid 4242 still runs
  for (let i = 0; i < 3; i++) { r.clock.t += 61_000; await r.judge(); }
  assert.deepStrictEqual(r.calls.removed, [], 'its process is still in the table');
  const row = r.sent.at(-1).leftovers.taskLogs[0];
  assert.deepStrictEqual([row.why, row.deletable, row.manualDelete], ['unknown', false, true]);
  r.world4242.on = false;                            // pid 4242 is gone from the table
  r.clock.t += 61_000;
  await r.judge();
  assert.deepStrictEqual(r.calls.removed, ['1:10']);
});

test('task logs: a pid that is reused by another process (another start) ends the seen session; the same start does not', async () => {
  const r = taskRig();
  await r.judge();
  r.setRegistry({ ok: true, entries: [{ pid: 5555, sessionId: 'tab' }] });
  r.world4242.on = false;
  r.extraProcs.push({ pid: 4242, ppid: 1, name: 'node.exe', cmd: 'node.exe', priv: 10, start: '500000000' });   // another process now has pid 4242 (its start is far from the recorded one)
  r.clock.t += 61_000;
  await r.judge();
  assert.deepStrictEqual(r.calls.removed, ['1:10']);
});

// ---- BACKLOG #82: the GPU figures ride the same sample ----

const gpuDoc = (n, busyTicks) => {
  const eng = (pid, u) => ({ n: `pid_${pid}_luid_0x00000000_0x000107EC_phys_0_eng_0_engtype_3D`, u: String(u), t: String(T0 + BigInt(n) * 10n * SEC) });
  return {
    eng: [eng(23, BigInt(n) * busyTicks), eng(20, 0n)],
    pm: [{ n: 'pid_23_luid_0x00000000_0x000107EC_phys_0', d: '300' }, { n: 'pid_20_luid_0x00000000_0x000107EC_phys_0', d: '50' }],
    am: [{ n: 'luid_0x00000000_0x000107EC_phys_0', d: '400' }], ad: [{ m: 'pci\\ven_1', b: '1000' }], pn: ['PCI\\VEN_1&DEV_2\\3'],
  };
};
const withGpu = (sample, n, busyTicks) => ({ ...sample, gpu: require('../host/resource-gpu').parseGpu(gpuDoc(n, busyTicks)) });
const gpuSnap = (n, busyTicks) => {
  const f = fullSnap(n, 10);
  return { ...f, machine: { last: withGpu(f.machine.last, n, busyTicks), prev: n > 1 ? withGpu(f.machine.prev, n - 1, busyTicks) : null } };
};

test('GPU: the machine part of EVERY payload carries busy % and memory, the process list only the full one', () => {
  const r = hrig();
  r.svc.onUpdate(gpuSnap(2, 25n * SEC / 10n));       // 2.5 s of a 10 s step: 25%
  const [full, light] = [r.sent.at(-1), r.svc.get(false)];
  assert.ok(Math.abs(full.machine.gpu.busy - 25) < 1e-9);
  assert.deepStrictEqual(full.machine.gpu.mem, { usedBytes: 400, totalBytes: 1000 });
  assert.deepStrictEqual(light.machine.gpu, full.machine.gpu);
  assert.deepStrictEqual(full.gpuProcs.rows.map(x => [x.pid, x.name, x.bytes]), [[23, 'node.exe', 300], [20, 'electron.exe', 50]]);
  assert.ok(Math.abs(full.gpuProcs.rows[0].busy - 25) < 1e-9);
  assert.strictEqual(light.gpuProcs, undefined, 'the light payload never carries process names');
});

test('GPU: the first sample has the memory but no busy %; a sample without GPU counters is all null, never 0', () => {
  const r = hrig();
  r.svc.onUpdate(gpuSnap(1, 5n * SEC));
  assert.strictEqual(r.sent.at(-1).machine.gpu.busy, null);
  assert.strictEqual(r.sent.at(-1).machine.gpu.mem.usedBytes, 400);
  const bare = hrig();
  bare.svc.onUpdate(fullSnap(2, 10));
  assert.deepStrictEqual(bare.sent.at(-1).machine.gpu, { busy: null, mem: null });
  assert.deepStrictEqual(bare.sent.at(-1).gpuProcs, { rows: [], more: 0 });
});

test('GPU: the history point carries busy % and memory used / total; unknown ones are null', () => {
  const r = hrig();
  r.svc.onUpdate(gpuSnap(2, 25n * SEC / 10n));
  const pt = r.sent.at(-1).history[0];
  assert.ok(Math.abs(pt.gpu - 25) < 0.06);
  assert.strictEqual(pt.gpuMemUsed, 400);
  assert.strictEqual(pt.gpuMemTotal, 1000);
  const bare = hrig();
  bare.svc.onUpdate(fullSnap(2, 10));
  const q = bare.sent.at(-1).history[0];
  assert.deepStrictEqual([q.gpu, q.gpuMemUsed, q.gpuMemTotal], [null, null, null]);
});

test('GPU: a machine-only snapshot still has the chip figures, and no process list', () => {
  const r = hrig();
  const a = withGpu(sampleAt(world(), 0, 1), 1, 5n * SEC);
  const b = withGpu(sampleAt(world(), 0, 2), 2, 5n * SEC);
  r.svc.onUpdate(snap({ mode: 'machine', machine: { last: b, prev: a } }));
  const p = r.sent.at(-1);
  assert.ok(Math.abs(p.machine.gpu.busy - 50) < 1e-9);
  assert.strictEqual(p.gpuProcs, null);
});
