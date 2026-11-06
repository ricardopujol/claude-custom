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
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const R = require('../host/resource-sampler');
const { machineCpu } = require('../host/resource-sample');

const T0 = 134384629128588005n;
const TICK = 10000000n;   // 1 s in 100 ns units
// A full sample captured at `cap` (a step count): the wall counter and the idle one both move with it, at 50% busy.
const docAt = (cap, { idleOf = (c) => c * 5000000 } = {}) => JSON.stringify({
  procs: [{ pid: 4, ppid: 0, name: 'System', cmd: null, start: '5' }],
  perf: [{ pid: 4, cpu: String(cap * 1000), ts: String(T0 + BigInt(cap) * TICK) }],
  cpu: { idle: String(idleOf(cap)), ts: String(T0 + BigInt(cap) * TICK) }, os: { totalKb: 1000, freeKb: 400 },
}) + '\nEND';
const capOf = (s) => (s && s.cpuTotal ? Number((s.cpuTotal.ts - T0) / TICK) : null);

// One flight per call to fetch, settled by the test: the cadence take and the off-cadence one each hold one.
function harness() {
  const flights = { cadence: [], adhoc: [] };
  const updates = [];
  const fetch = (mode, adhoc) => {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    const f = { kind: adhoc ? 'adhoc' : 'cadence', land: (cap, opts) => resolve({ text: docAt(cap, opts), at: 1000 + cap, mode: 'full' }) };
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
  const land = async (kind, cap, opts) => { const f = open(kind); f.done = true; f.land(cap, opts); await flush(); };
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
  const procs = await asked;
  assert.ok(Array.isArray(procs) && procs.length === 1, 'Stop\'s re-read still gets a process list taken after it was asked (the newer cadence one)');
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

test('#176 property: whatever the overlap and the landing order, every pair has a strictly later capture, the newest landed capture is always `last`, and a delta is null only for a missing or backwards counter', async () => {
  // A schedule is a list of choices; each picks one of the moves that are legal right now (index modulo how many there are):
  // ask for an off-cadence sample, a flight reads its counter (gets the next capture time), a flight that has read it lands.
  await fc.assert(fc.asyncProperty(fc.array(fc.nat(), { minLength: 4, maxLength: 40 }), fc.boolean(), async (choices, dropIdle) => {
    const h = harness();
    h.sampler.setWanted({ panel: true, chip: true });
    h.sampler.start();
    await h.flush();
    let clock = 0;
    let landedMax = null;
    const caps = new Map();                                   // flight -> its capture time
    // dropIdle: one capture somewhere has no idle counter, so "null only when a counter is missing" is exercised too.
    const missingAt = dropIdle ? 3 : -1;
    for (const c of choices) {
      const moves = [];
      if (h.flights.adhoc.every((f) => f.done)) moves.push({ k: 'ask' });
      for (const kind of ['cadence', 'adhoc']) {
        const f = h.open(kind);
        if (f && !caps.has(f)) moves.push({ k: 'read', f });
        if (f && caps.has(f)) moves.push({ k: 'land', f, kind });
      }
      if (moves.length === 0) break;
      const m = moves[c % moves.length];
      if (m.k === 'ask') { h.sampler.sampleNow().catch(() => null); await h.flush(); continue; }
      if (m.k === 'read') { clock += 1; caps.set(m.f, clock); continue; }
      const cap = caps.get(m.f);
      m.f.done = true;
      m.f.land(cap, cap === missingAt ? { idleOf: () => 'n/a' } : undefined);
      await h.flush();
      // The newest landed capture that has a counter (the record without one can't be ordered, so it isn't counted).
      if (cap !== missingAt) landedMax = landedMax === null ? cap : Math.max(landedMax, cap);
      const snap = h.sampler.snapshot();
      const p = snap.machine.prev;
      const l = snap.machine.last;
      if (p && l) {
        const cpu = machineCpu(p, l);
        if (capOf(p) !== null && capOf(l) !== null) {
          assert.ok(capOf(l) > capOf(p), `machine pair goes backwards: ${capOf(p)} -> ${capOf(l)}`);
          assert.ok(cpu !== null, `a null CPU with both counters present: ${capOf(p)} -> ${capOf(l)}`);
        } else assert.strictEqual(cpu, null, 'a missing counter is "—", never a number');
      }
      const fp = capOf(snap.prev);
      const fl = capOf(snap.sample);
      if (fp !== null && fl !== null) assert.ok(fl > fp, `full pair goes backwards: ${fp} -> ${fl}`);
      // A late record never replaces a newer one: what is shown is the newest capture that has landed.
      if (capOf(l) !== null) assert.strictEqual(capOf(l), landedMax, `last is ${capOf(l)}, the newest landed capture is ${landedMax}`);
    }
    h.sampler.stop();
  }), { numRuns: 150 });
});
