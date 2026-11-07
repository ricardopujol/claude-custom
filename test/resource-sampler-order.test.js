'use strict';
/**
 * BACKLOG #176: the sampler's pairs are formed in CAPTURE order, not in the order the records happen to land.
 *
 * PROVED 2026-11-06 (documentation/handoffs/CURRENT-fix-chip-cpu-and-refit.md, Progress): at app start resources-service's wakeLeftover
 * asks for an off-cadence sample before this window owns the shared poller, so it runs on a one-off powershell while the cadence sample
 * runs on the owner's persistent one. Two processes: the one that read the CPU counter first can finish second (a scratch run with the
 * real poller and PowerShell: 3 of 10 rounds, capture deltas of -13, -12 and -9 ms). Set in completion order, that pair goes backwards and
 * the chip reads "CPU —" for a whole sample (machineCpu: dWall < 0 -> null).
 *
 * The rule pinned here: a record that was in flight while a newer-captured one landed is LATE and replaces nothing (neither the machine
 * pair nor the full one). A record that started after the newest one landed is taken whatever its timestamp, so a clock that steps back
 * costs one "—", as before, instead of freezing the pair on the old figure.
 *
 * PR #240 review (Dexter 1-3, Miguel S2): each record is a SPAN of reads (the script reads the process table and the per-process counters
 * first, then the GPU engines, then the CPU counter last), so each delta section is ordered by its OWN timestamp: the machine pair by the
 * CPU and GPU ones, the full pair by the CPU and per-process ones. `sampleNow()` returns its OWN record's process list, whatever the
 * ordering decides about the deltas (Stop's re-read needs a list read after the click). A late record changes nothing the view sees:
 * not lastGoodAt, not lastMode, and it emits nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const R = require('../host/resource-sampler');
const { machineCpu, cpuPercents } = require('../host/resource-sample');
const { buildGpu } = require('../host/resource-gpu');

const T0 = 134384629128588005n;
const TICK = 10000000n;   // 1 s in 100 ns units
const tsOf = (c) => String(T0 + BigInt(c) * TICK);
const SYSTEM = { pid: 4, ppid: 0, name: 'System', cmd: null, start: '5' };
const ENGINE = 'pid_4_luid_0x00000000_0x0000D1A2_phys_0_eng_0_engtype_3D';
// A full sample whose three counter sections were read at their own times (step counts): `perf` (the per-process counters, read
// first), `gpu` (the engine rows; null: none), `cpu` (the _Total counter, read last). Every counter moves with its own clock: the
// machine is 50% busy, process 4 uses a little CPU, the GPU engine is 25% busy. `noIdle`: the CPU counter is unreadable.
const docOf = ({ cpu, perf = cpu, gpu = null, noIdle = false, procs = [SYSTEM] }) => JSON.stringify({
  procs,
  perf: [{ pid: 4, cpu: String(perf * 1000), ts: tsOf(perf) }],
  cpu: { idle: noIdle ? 'n/a' : String(cpu * 5000000), ts: tsOf(cpu) }, os: { totalKb: 1000, freeKb: 400 },
  ...(gpu === null ? {} : { gpu: { eng: [{ n: ENGINE, u: String(gpu * 2500000), t: tsOf(gpu) }] } }),
}) + '\nEND';
const capOf = (s) => (s && s.cpuTotal ? Number((s.cpuTotal.ts - T0) / TICK) : null);
const perfOf = (s) => (s && s.perf instanceof Map && s.perf.get(4) ? Number((s.perf.get(4).ts - T0) / TICK) : null);
const gpuOf = (s) => (s && s.gpu ? Number((s.gpu.ts - T0) / TICK) : null);
const pidsOf = (procs) => (Array.isArray(procs) ? procs.map((p) => p.pid) : procs);

// One flight per call to fetch, settled by the test: the cadence take and the off-cadence one each hold one.
// `land(kind, spec)`: spec is a capture step (all three sections read then) or { cpu, perf, gpu, noIdle, procs, mode, at }.
function harness() {
  const flights = { cadence: [], adhoc: [] };
  const updates = [];
  const fetch = (mode, adhoc) => {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    const f = {
      kind: adhoc ? 'adhoc' : 'cadence', asked: mode,
      land: (spec) => {
        const o = typeof spec === 'number' ? { cpu: spec } : spec;
        resolve({ text: docOf(o), at: o.at !== undefined ? o.at : 1000 + o.cpu, mode: o.mode || 'full' });
      },
    };
    flights[f.kind].push(f);
    p.kill = () => {};
    return p;
  };
  // A real (macrotask) timer the sampler can cancel, so its own cadence runs as in the app, with no wall-clock wait.
  const setTimer = (fn) => { const t = { off: false }; setImmediate(() => { if (!t.off) fn(); }); return t; };
  const clearTimer = (t) => { if (t) t.off = true; };
  const sampler = R.createSampler({ fetch, cores: 4, intervalMs: 0, setTimer, clearTimer, onUpdate: (u) => updates.push(u) });
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
  const open = (kind) => flights[kind].find((f) => !f.done);
  const land = async (kind, spec) => { const f = open(kind); f.done = true; f.land(spec); await flush(); };
  return { sampler, updates, flights, flush, open, land };
}

test('#176 the observed race: an off-cadence record captured BEFORE the cadence one but landing AFTER it replaces nothing', async () => {
  const h = harness();
  h.sampler.setWanted({ panel: true, chip: true });
  h.sampler.start();
  await h.flush();
  await h.land('cadence', 1);                                  // the first record: no pair yet
  const asked = h.sampler.sampleNow();                         // wakeLeftover's re-read, beside the next cadence take
  await h.flush();
  await h.land('cadence', 3);                                  // read the counter LATER, finished FIRST
  await h.land('adhoc', 2);                                    // read it earlier, finished second: late
  const snap = h.sampler.snapshot();
  assert.deepStrictEqual([capOf(snap.machine.prev), capOf(snap.machine.last)], [1, 3], 'the machine pair keeps the two newest captures, in order');
  assert.ok(typeof machineCpu(snap.machine.prev, snap.machine.last) === 'number', 'so the chip has a real CPU figure, not "—"');
  assert.deepStrictEqual([capOf(snap.prev), capOf(snap.sample)], [1, 3], 'the full pair the same');
  for (const u of h.updates) {
    if (u.machine.prev && u.machine.last) assert.ok(capOf(u.machine.last) > capOf(u.machine.prev), `no update ever carries a backwards pair: ${capOf(u.machine.prev)} -> ${capOf(u.machine.last)}`);
  }
  await asked;
  h.sampler.stop();
});

test('#240 Dexter 1: sampleNow() returns ITS OWN record\'s process list when that record lands late, not the cadence one read before the click', async () => {
  // The cadence record read its process table before the click (P not there yet); the off-cadence one, asked after P started, read it
  // after. The off-cadence one's CPU counter is older, so it's late for the deltas, but its process list is the one Stop asked for.
  const P = { pid: 900, ppid: 4, name: 'started-just-before-the-click.exe', cmd: null, start: '77' };
  const h = harness();
  h.sampler.setWanted({ panel: true, chip: true });
  h.sampler.start();
  await h.flush();
  await h.land('cadence', 1);
  const asked = h.sampler.sampleNow();
  await h.flush();
  await h.land('cadence', { cpu: 3, procs: [SYSTEM] });
  await h.land('adhoc', { cpu: 2, procs: [SYSTEM, P] });
  assert.deepStrictEqual(pidsOf(await asked), [4, 900], 'the re-read is the list taken after it was asked');
  const snap = h.sampler.snapshot();
  assert.deepStrictEqual([capOf(snap.machine.prev), capOf(snap.machine.last)], [1, 3], 'and the pairs still ignore the late record');
  assert.deepStrictEqual([capOf(snap.prev), capOf(snap.sample)], [1, 3]);
  h.sampler.stop();
});

test('#240 Dexter 1: a re-read that fails, or lands when nothing is wanted, is still null (never another record\'s list)', async () => {
  const h = harness();
  h.sampler.setWanted({ panel: true, chip: true });
  h.sampler.start();
  await h.flush();
  await h.land('cadence', 1);
  const failed = h.sampler.sampleNow();
  await h.flush();
  await h.land('cadence', 3);
  const f = h.open('adhoc'); f.done = true; f.land({ cpu: 4, noIdle: true, procs: 'not a list' });   // a document that won't parse
  await h.flush();
  assert.strictEqual(await failed, null);
  const unwanted = h.sampler.sampleNow();
  await h.flush();
  h.sampler.setWanted({ panel: false, chip: false });
  await h.land('adhoc', 5);
  assert.strictEqual(await unwanted, null, 'dropped: nothing wanted it');
  h.sampler.stop();
});

test('#240 Miguel S2: a late record changes nothing the view sees: not lastGoodAt, not lastMode, and no update is emitted for it', async () => {
  const h = harness();
  h.sampler.setWanted({ panel: true, chip: true });
  h.sampler.start();
  await h.flush();
  await h.land('cadence', 1);
  h.sampler.sampleNow();
  await h.flush();
  await h.land('cadence', { cpu: 3, at: 5003 });
  const before = h.updates.length;
  // Late (captured at 2, after 3 landed), with an older `at` and (as a shared source may say) another mode.
  await h.land('adhoc', { cpu: 2, at: 5002, mode: 'machine' });
  const snap = h.sampler.snapshot();
  assert.strictEqual(snap.lastGoodAt, 5003, 'lastGoodAt never goes back in time');
  assert.strictEqual(snap.mode, 'full', 'lastMode is the mode of what is shown');
  assert.strictEqual(h.updates.length, before, 'nothing is emitted for a record that moved nothing');
  h.sampler.stop();
});

test('#176 a record with the SAME capture time as the newest one (a cached counter) is late too: no zero-length pair', async () => {
  const h = harness();
  h.sampler.setWanted({ panel: true, chip: true });
  h.sampler.start();
  await h.flush();
  await h.land('cadence', 1);
  h.sampler.sampleNow();
  await h.flush();
  await h.land('cadence', 4);
  await h.land('adhoc', 4);
  const snap = h.sampler.snapshot();
  assert.deepStrictEqual([capOf(snap.machine.prev), capOf(snap.machine.last)], [1, 4]);
  assert.ok(typeof machineCpu(snap.machine.prev, snap.machine.last) === 'number');
  h.sampler.stop();
});

test('#176 a clock that steps BACK between two records that did not overlap is taken: one "—", then real figures again (never frozen on the old pair)', async () => {
  const h = harness();
  h.sampler.setWanted({ panel: true, chip: true });
  h.sampler.start();
  await h.flush();
  await h.land('cadence', 10);
  await h.land('cadence', 12);
  await h.land('cadence', 5);                                   // started after 12 landed: not late, the clock moved
  let snap = h.sampler.snapshot();
  assert.deepStrictEqual([capOf(snap.machine.prev), capOf(snap.machine.last)], [12, 5]);
  assert.strictEqual(machineCpu(snap.machine.prev, snap.machine.last), null, 'the step itself is honestly unknown');
  await h.land('cadence', 6);
  snap = h.sampler.snapshot();
  assert.deepStrictEqual([capOf(snap.machine.prev), capOf(snap.machine.last)], [5, 6]);
  assert.ok(typeof machineCpu(snap.machine.prev, snap.machine.last) === 'number', 'and the next pair is a real figure');
  h.sampler.stop();
});

test('#240 Dexter 2: two overlapping records whose sections disagree (later on the CPU, earlier on the per-process and GPU counters) never form a pair: every figure stays real', async () => {
  // Dexter's numbers, in 10 ms steps: A read perf 100.00 s, GPU 101.40 s, CPU 101.80 s; C read perf 99.60 s, GPU 101.30 s, CPU 101.81 s.
  const X = { cpu: 9000, perf: 9000, gpu: 9000 };
  const A = { cpu: 10180, perf: 10000, gpu: 10140 };
  const C = { cpu: 10181, perf: 9960, gpu: 10130 };
  for (const [first, second] of [[['adhoc', A], ['cadence', C]], [['cadence', C], ['adhoc', A]]]) {
    const h = harness();
    h.sampler.setWanted({ panel: true, chip: true });
    h.sampler.start();
    await h.flush();
    await h.land('cadence', X);
    h.sampler.sampleNow();
    await h.flush();
    await h.land(...first);
    await h.land(...second);
    const snap = h.sampler.snapshot();
    const label = `${first[0]} landed first`;
    assert.deepStrictEqual([capOf(snap.machine.prev), capOf(snap.machine.last)], [9000, first[1].cpu], `${label}: the machine pair keeps the first to land`);
    assert.deepStrictEqual([capOf(snap.prev), capOf(snap.sample)], [9000, first[1].cpu], `${label}: the full pair the same`);
    assert.strictEqual(typeof machineCpu(snap.machine.prev, snap.machine.last), 'number', `${label}: the chip's CPU`);
    assert.strictEqual(typeof buildGpu(snap.machine.prev, snap.machine.last).busy, 'number', `${label}: the chip's GPU`);
    assert.strictEqual(typeof cpuPercents(snap.prev, snap.sample, 4).get(4), 'number', `${label}: a process row`);
    h.sampler.stop();
  }
});

test('#240 Dexter 3: the full pair keeps its OWN ordering state: chip only, then the panel with an off-cadence take in flight, takes the panel\'s first full record', async () => {
  const h = harness();
  h.sampler.setWanted({ panel: false, chip: true });
  h.sampler.start();
  await h.flush();
  await h.land('cadence', { cpu: 1, mode: 'machine' });
  const asked = h.sampler.sampleNow();
  await h.flush();
  h.sampler.setWanted({ panel: true, chip: true });
  await h.flush();
  await h.land('cadence', { cpu: 3, mode: 'machine' });        // the machine pair moves during the off-cadence flight; the full pair doesn't
  await h.land('adhoc', 2);                                     // late for the machine pair, the first record of the full one
  const snap = h.sampler.snapshot();
  assert.deepStrictEqual([capOf(snap.machine.prev), capOf(snap.machine.last)], [1, 3]);
  assert.strictEqual(capOf(snap.sample), 2, 'the panel has its first full record now, not one cadence later');
  assert.deepStrictEqual(pidsOf(await asked), [4]);
  h.sampler.stop();
});

test('#240 Dexter 3: withdrawing the panel forgets the full pair\'s ordering state with the pair (an old capture time can\'t make a later record late)', async () => {
  const h = harness();
  h.sampler.setWanted({ panel: true, chip: true });
  h.sampler.start();
  await h.flush();
  await h.land('cadence', { cpu: 10, perf: 10 });
  h.sampler.setWanted({ panel: false, chip: true });
  h.sampler.setWanted({ panel: true, chip: true });
  h.sampler.sampleNow();
  await h.flush();
  // The cadence record moves the full pair with no CPU counter (it can't be ordered on it), then the off-cadence one lands: its CPU
  // time is behind the FORGOTTEN record's, and its per-process time is ahead of the one it overlapped.
  await h.land('cadence', { cpu: 11, perf: 12, noIdle: true });
  await h.land('adhoc', { cpu: 5, perf: 13 });
  assert.strictEqual(perfOf(h.sampler.snapshot().sample), 13, 'the off-cadence record is taken');
  h.sampler.stop();
});

test('#176 property: whatever the overlap, the landing order and the clocks (per-section reads, equal reads, one step back), a pair is out of capture order on a section only when its newer record overlapped no move of that pair, a delta is null only for a missing or non-forward counter, and a record that overlapped nothing is always taken', async () => {
  // A schedule is a list of choices; each picks one of the moves that are legal right now (index modulo how many there are): ask for an
  // off-cadence sample, a flight reads its next section (perf, then GPU, then CPU, as the script does), a flight that read all three lands.
  // The clock moves 0, 1 or 2 steps after each read (0: two equal reads), and at read number `stepAt` it steps back 50.
  // A record that overlapped no move of a pair can't be late for it, so it is taken whatever its times: that is where an equal or
  // backwards pair may form (one honest "—"). A record that overlapped one is ordered on every section both have.
  const SECTIONS = ['perf', 'gpu', 'cpu'];
  const timeOf = (s, sec) => (sec === 'cpu' ? capOf(s) : sec === 'perf' ? perfOf(s) : gpuOf(s));
  const forward = (p, l, sec) => timeOf(p, sec) !== null && timeOf(l, sec) !== null && timeOf(l, sec) > timeOf(p, sec);
  await fc.assert(fc.asyncProperty(
    fc.array(fc.nat(), { minLength: 4, maxLength: 48 }), fc.integer({ min: -1, max: 60 }), fc.boolean(), fc.boolean(),
    async (choices, stepAt, dropIdle, dropGpu) => {
      const h = harness();
      h.sampler.setWanted({ panel: true, chip: true });
      h.sampler.start();
      await h.flush();
      let clock = 100;
      let reads = 0;
      let nextAt = 1;
      const info = new Map();        // flight -> { got: { perf, gpu, cpu }, startMoves, overlapped, at, noIdle, noGpu }
      const byAt = new Map();        // a record's `at` -> its flight's info
      const moves = { machine: 0, full: 0 };
      let shown = { machine: null, full: null };
      const register = (f) => {
        if (info.has(f)) return;
        const at = nextAt++;
        const i = { got: {}, startMoves: { ...moves }, overlapped: null, at, noIdle: dropIdle && at === 3, noGpu: dropGpu && at === 5 };
        info.set(f, i); byAt.set(at, i);
      };
      for (const c of choices) {
        for (const kind of ['cadence', 'adhoc']) for (const f of h.flights[kind]) if (!f.done) register(f);
        const legal = [];
        if (h.flights.adhoc.every((f) => f.done)) legal.push({ k: 'ask' });
        for (const kind of ['cadence', 'adhoc']) {
          const f = h.open(kind);
          if (!f) continue;
          const i = info.get(f);
          const next = SECTIONS.find((s) => !(s in i.got));
          legal.push(next ? { k: 'read', f, sec: next } : { k: 'land', f });
        }
        if (legal.length === 0) break;
        const m = legal[c % legal.length];
        if (m.k === 'ask') { h.sampler.sampleNow().catch(() => null); await h.flush(); continue; }
        if (m.k === 'read') {
          const i = info.get(m.f);
          if (reads === stepAt) clock -= 50;
          reads += 1;
          i.got[m.sec] = clock;
          clock += Math.floor(c / 7) % 3;
          continue;
        }
        const i = info.get(m.f);
        i.overlapped = { machine: moves.machine !== i.startMoves.machine, full: moves.full !== i.startMoves.full };
        m.f.done = true;
        m.f.land({ cpu: i.got.cpu, perf: i.got.perf, gpu: i.noGpu ? null : i.got.gpu, noIdle: i.noIdle, at: i.at });
        await h.flush();
        const snap = h.sampler.snapshot();
        if (snap.machine.last !== shown.machine) moves.machine += 1;
        if (snap.sample !== shown.full) moves.full += 1;
        shown = { machine: snap.machine.last, full: snap.sample };

        const checkPair = (p, l, secs, which) => {
          for (const sec of secs) {
            if (timeOf(p, sec) === null || timeOf(l, sec) === null || forward(p, l, sec)) continue;
            assert.ok(!byAt.get(l.at).overlapped[which], `${which} pair out of capture order on ${sec} (${timeOf(p, sec)} -> ${timeOf(l, sec)}), and its newer record overlapped a move`);
          }
        };
        const p = snap.machine.prev;
        const l = snap.machine.last;
        if (p && l) {
          checkPair(p, l, ['cpu', 'gpu'], 'machine');
          assert.strictEqual(machineCpu(p, l) !== null, forward(p, l, 'cpu'), `the machine CPU is null exactly when its counter is missing or not forward (${capOf(p)} -> ${capOf(l)})`);
          assert.strictEqual(buildGpu(p, l).busy !== null, forward(p, l, 'gpu'), `the GPU is null exactly when its counter is missing or not forward (${gpuOf(p)} -> ${gpuOf(l)})`);
        }
        const fp = snap.prev;
        const fl = snap.sample;
        if (fp && fl) {
          checkPair(fp, fl, ['cpu', 'perf'], 'full');
          assert.strictEqual(cpuPercents(fp, fl, 4).get(4) !== null, forward(fp, fl, 'perf'), `a process row is null exactly when its counter is not forward (${perfOf(fp)} -> ${perfOf(fl)})`);
        }
        // Liveness: a record that landed with no move of a pair during its flight is never late for it, so it is what that pair shows.
        if (!i.overlapped.machine) assert.strictEqual(l && l.at, i.at, `a record that overlapped no move of the machine pair was not taken (at ${i.at})`);
        if (!i.overlapped.full) assert.strictEqual(fl && fl.at, i.at, `a record that overlapped no move of the full pair was not taken (at ${i.at})`);
      }
      h.sampler.stop();
    }), { numRuns: 200 });
});
