'use strict';
/**
 * host/shared-poller.js (BACKLOG #100 c): ONE sampler across app instances. The first instance to start owns the samples and
 * publishes them to a shared folder; the others read. These tests run several pollers over a real temp folder with a fake
 * world: one clock, one timer wheel, a table of which pids are alive and what start time each has.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const SP = require('../host/shared-poller');
const policy = require('../host/poller-policy');

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

function makeWorld() {
  const dir = tmpDir('cc-poller-');
  let clock = 5_000_000;
  let id = 0;
  const timers = [];
  const alive = new Set();
  const starts = new Map();
  const world = {
    dir, alive, starts, calls: [], oneShots: [], pollers: new Map(), crashed: new Set(), execDelay: 0,
    now: () => clock,
    setTimer: (fn, ms) => { const t = { id: ++id, at: clock + ms, fn, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    async advance(ms) {
      const target = clock + ms;
      for (;;) {
        await settle();
        const due = timers.filter(t => t.live && t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        clock = Math.max(clock, due.at);
        due.live = false;
        due.fn();
      }
      clock = target;
      await settle();
    },
    /** Make poller `pid`, alive, with its own start time and a fake persistent exec that records every call. */
    make(pid, opts = {}) {
      alive.add(pid);
      starts.set(pid, 'S' + pid);
      let n = 0;
      const p = SP.createSharedPoller({
        // A crashed process does not tick and does not finish a sample it had in flight.
        dir, self: { pid }, now: world.now, clearTimer: world.clearTimer,
        setTimer: (fn, ms) => world.setTimer(() => { if (!world.crashed.has(pid)) fn(); }, ms),
        selfStart: async () => starts.get(pid) || null,
        pidAlive: (q) => alive.has(q),
        proveOwner: async (o) => (alive.has(o.pid) ? starts.get(o.pid) === o.start : false),
        script: (mode) => 'script:' + mode,
        makeExec: () => {
          const e = (script) => { world.calls.push({ pid, script, at: clock, ownerPid: world.ownerPid() }); n++; if (opts.failWith) return Promise.reject(new Error(opts.failWith)); return world.execDelay > 0 ? new Promise((r) => { world.setTimer(() => { if (!world.crashed.has(pid)) r(`doc-${pid}-${n}\nEND`); }, world.execDelay); }) : Promise.resolve(`doc-${pid}-${n}\nEND`); };
          e.close = () => { e.closed = true; };
          return e;
        },
        oneShot: () => (script) => { world.oneShots.push({ pid, script }); return Promise.resolve('oneshot\nEND'); },
        ...opts.poller,
      });
      world.pollers.set(pid, p);
      return p;
    },
    /** The pid owner.json names right now (null: absent or unreadable). */
    ownerPid() { try { return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')).pid; } catch { return null; } },
    crash(pid) { alive.delete(pid); world.crashed.add(pid); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return world;
}
const callsOf = (w, pid) => w.calls.filter(c => c.pid === pid);

async function withWorld(fn) {
  const w = makeWorld();
  try { await fn(w); } finally {
    for (const p of w.pollers.values()) { try { p.stop(); } catch { /* ignore */ } }
    w.cleanup();
  }
}

test('alone: the instance claims the folder, samples at once, then every 30 s at the chip level', () => withWorld(async (w) => {
  const a = w.make(100);
  a.setLevel('chip');
  await a.start();
  await w.advance(0);
  assert.strictEqual(a.role(), 'owner');
  assert.strictEqual(callsOf(w, 100).length, 1, 'the first sample is immediate');
  await w.advance(29000);
  assert.strictEqual(callsOf(w, 100).length, 1, 'not before 30 s');
  await w.advance(2000);
  assert.strictEqual(callsOf(w, 100).length, 2);
  assert.ok(callsOf(w, 100).every(c => c.script === 'script:full'));
}));

test('the panel in view samples every 10 s', () => withWorld(async (w) => {
  const a = w.make(100);
  a.setLevel('panel');
  await a.start();
  await w.advance(35000);
  assert.strictEqual(callsOf(w, 100).length, 4, 'at 0, 10, 20, 30 s');
}));

test('hidden: no sample, and not even a shell is made (the exec factory is lazy)', () => withWorld(async (w) => {
  let made = 0;
  const a = w.make(100, { poller: { makeExec: () => { made++; return () => Promise.resolve('x'); } } });
  a.setLevel('hidden');
  await a.start();
  await w.advance(120000);
  assert.strictEqual(a.role(), 'owner');
  assert.strictEqual(made, 0);
  assert.strictEqual(w.calls.length, 0);
}));

test('a gap, not a rate: the next sample is one interval after the last one ENDED', () => withWorld(async (w) => {
  let release;
  const a = w.make(100, { poller: { makeExec: () => (s) => { w.calls.push({ pid: 100, script: s, at: w.now() }); return new Promise((r) => { release = () => r('d\nEND'); }); } } });
  a.setLevel('panel');
  await a.start();
  await w.advance(0);
  assert.strictEqual(w.calls.length, 1);
  await w.advance(25000);
  assert.strictEqual(w.calls.length, 1, 'a slow sample is never piled on');
  release();
  await w.advance(0);
  await w.advance(9000);
  assert.strictEqual(w.calls.length, 1);
  await w.advance(2000);
  assert.strictEqual(w.calls.length, 2);
}));

test('two instances: ONE samples, the other reads what it published', () => withWorld(async (w) => {
  const a = w.make(100);
  const b = w.make(200);
  a.setLevel('chip'); b.setLevel('chip');
  await a.start();
  await b.start();
  await w.advance(0);
  assert.strictEqual(a.role(), 'owner');
  assert.strictEqual(b.role(), 'follower');
  const rec = await b.next({ after: null, maxAgeMs: 60000, timeoutMs: 60000 });
  assert.strictEqual(rec.ok, true);
  assert.match(rec.text, /^doc-100-1/);
  await w.advance(95000);
  assert.strictEqual(callsOf(w, 200).length, 0, 'the follower never samples');
  assert.strictEqual(callsOf(w, 100).length, 4, 'at 0, 30, 60, 90 s: the same as one instance alone');
}));

test('the follower\'s wait is answered by the NEXT record, once per record, in order', () => withWorld(async (w) => {
  const a = w.make(100);
  const b = w.make(200);
  a.setLevel('panel'); b.setLevel('panel');
  await a.start(); await b.start();
  await w.advance(0);
  let key = null;
  const seqs = [];
  for (let i = 0; i < 3; i++) {
    const p = b.next({ after: key, maxAgeMs: 9000, timeoutMs: 30000 });
    await w.advance(10000);
    const r = await p;
    seqs.push(r.seq);
    key = r.key;
  }
  assert.deepStrictEqual(seqs, [seqs[0], seqs[0] + 1, seqs[0] + 2]);
}));

test('next(): a record older than maxAgeMs is not served as new; a timeout rejects; kill() cancels', () => withWorld(async (w) => {
  const a = w.make(100);
  a.setLevel('chip');
  await a.start();
  await w.advance(0);
  const first = await a.next({ after: null, maxAgeMs: 5000, timeoutMs: 1000 });
  assert.ok(first);
  a.setLevel('hidden');
  await w.advance(60000);
  const stale = a.next({ after: null, maxAgeMs: 5000, timeoutMs: 1000 });
  const assertion = assert.rejects(stale, /no sample/);
  await w.advance(1500);
  await assertion;
  const cancelled = a.next({ after: first.key, maxAgeMs: 5000, timeoutMs: 100000 });
  const c = assert.rejects(cancelled, /cancel/);
  cancelled.kill();
  await c;
}));

test('a follower at the panel level raises the owner to 10 s within one control tick, and back down when it goes', () => withWorld(async (w) => {
  const a = w.make(100);
  const b = w.make(200);
  a.setLevel('chip'); b.setLevel('chip');
  await a.start(); await b.start();
  await w.advance(1000);
  const before = callsOf(w, 100).length;
  b.setLevel('panel');
  await w.advance(30000);
  const during = callsOf(w, 100).length - before;
  assert.ok(during >= 2 && during <= 4, `about 10 s steps while the panel is in view (got ${during})`);
  b.setLevel('chip');
  await w.advance(2500);
  const mark = callsOf(w, 100).length;
  await w.advance(29000);
  assert.ok(callsOf(w, 100).length - mark <= 1, 'back to 30 s');
}));

test('every instance hidden: sampling stops; one coming back samples at once', () => withWorld(async (w) => {
  const a = w.make(100);
  const b = w.make(200);
  a.setLevel('chip'); b.setLevel('chip');
  await a.start(); await b.start();
  await w.advance(1000);
  a.setLevel('hidden'); b.setLevel('hidden');
  await w.advance(2500);
  const n = w.calls.length;
  await w.advance(300000);
  assert.strictEqual(w.calls.length, n, 'nobody looking, nothing sampled');
  b.setLevel('chip');
  await w.advance(2500);
  assert.strictEqual(w.calls.length, n + 1, 'the first sample after the gap is immediate, not a wait of one interval');
}));

test('the owner crashes: a follower claims within one control tick and samples within one interval of the last sample', () => withWorld(async (w) => {
  const a = w.make(100);
  const b = w.make(200);
  a.setLevel('panel'); b.setLevel('panel');
  await a.start(); await b.start();
  await w.advance(25000);
  const lastAt = callsOf(w, 100).slice(-1)[0].at;
  w.crash(100);
  await w.advance(15000);
  assert.strictEqual(b.role(), 'owner');
  const first = callsOf(w, 200)[0];
  assert.ok(first, 'the follower took over sampling');
  assert.ok(first.at - lastAt <= policy.CADENCE.panel.intervalMs + SP.CONTROL_MS, `gap ${first.at - lastAt} ms`);
}));

test('takeover continues the sequence: a follower never sees seq go backwards', () => withWorld(async (w) => {
  const a = w.make(100);
  const b = w.make(200);
  a.setLevel('panel'); b.setLevel('panel');
  await a.start(); await b.start();
  await w.advance(21000);
  const seen = [await b.next({ after: null, maxAgeMs: 60000, timeoutMs: 1000 })];
  w.crash(100);
  await w.advance(30000);
  seen.push(await b.next({ after: seen[0].key, maxAgeMs: 60000, timeoutMs: 1000 }));
  assert.ok(seen[1].seq > seen[0].seq);
}));

test('a clean stop releases the folder at once: the other instance owns by its next tick', () => withWorld(async (w) => {
  const a = w.make(100);
  const b = w.make(200);
  a.setLevel('chip'); b.setLevel('chip');
  await a.start(); await b.start();
  await w.advance(1000);
  a.stop();
  assert.strictEqual(fs.existsSync(path.join(w.dir, 'owner.json')), false);
  assert.strictEqual(fs.existsSync(path.join(w.dir, 'want-100.json')), false);
  await w.advance(SP.CONTROL_MS + 100);
  assert.strictEqual(b.role(), 'owner');
}));

test('a recorded owner whose pid is alive but belongs to ANOTHER process (reused) is taken once its heartbeat is stale', () => withWorld(async (w) => {
  fs.writeFileSync(path.join(w.dir, 'owner.json'), JSON.stringify({ pid: 300, start: 'OLD', since: w.now() - 99999, beat: w.now() - 99999 }));
  w.alive.add(300); w.starts.set(300, 'NEW');
  const b = w.make(200);
  b.setLevel('chip');
  await b.start();
  await w.advance(0);
  assert.strictEqual(b.role(), 'owner');
}));

test('a live owner with the SAME start time and a stale heartbeat (hung) is NOT taken from: doubt keeps', () => withWorld(async (w) => {
  fs.writeFileSync(path.join(w.dir, 'owner.json'), JSON.stringify({ pid: 300, start: 'S300', since: w.now() - 99999, beat: w.now() - 99999 }));
  w.alive.add(300); w.starts.set(300, 'S300');
  const b = w.make(200);
  b.setLevel('chip');
  await b.start();
  await w.advance(30000);
  assert.strictEqual(b.role(), 'follower');
  assert.strictEqual(callsOf(w, 200).length, 0);
}));

test('the owner renews its heartbeat, so a healthy owner never reads as stale', () => withWorld(async (w) => {
  const a = w.make(100);
  a.setLevel('hidden');
  await a.start();
  await w.advance(120000);
  const o = JSON.parse(fs.readFileSync(path.join(w.dir, 'owner.json'), 'utf8'));
  assert.ok(w.now() - o.beat <= SP.BEAT_MS + SP.CONTROL_MS, `beat ${w.now() - o.beat} ms old`);
  assert.strictEqual(o.pid, 100);
  assert.strictEqual(o.start, 'S100');
}));

test('an owner that finds the folder handed to someone else stops: the sample that ended after the handover is NOT published', () => withWorld(async (w) => {
  let release;
  const a = w.make(100, { poller: { makeExec: () => (s) => new Promise((r) => { w.calls.push({ pid: 100, script: s, at: w.now() }); release = () => r('late\nEND'); }) } });
  a.setLevel('panel');
  await a.start();
  await w.advance(0);
  fs.writeFileSync(path.join(w.dir, 'owner.json'), JSON.stringify({ pid: 999, start: 'X', since: w.now(), beat: w.now() }));
  w.alive.add(999); w.starts.set(999, 'X');
  release();
  await w.advance(100);
  assert.strictEqual(fs.existsSync(path.join(w.dir, 'sample.json')), false, 'nothing published by the deposed owner');
  await w.advance(3000);
  assert.strictEqual(a.role(), 'follower');
}));

test('a failed sample is published as a failure, so every reader counts it, not just the owner', () => withWorld(async (w) => {
  const a = w.make(100, { failWith: 'timed out' });
  const b = w.make(200);
  a.setLevel('chip'); b.setLevel('chip');
  await a.start(); await b.start();
  await w.advance(0);
  const r = await b.next({ after: null, maxAgeMs: 60000, timeoutMs: 1000 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.strictEqual(r.text, null);
}));

test('sampleNow: the owner asks its persistent shell; a follower makes its own one-off call and publishes nothing', () => withWorld(async (w) => {
  const a = w.make(100);
  const b = w.make(200);
  a.setLevel('chip'); b.setLevel('chip');
  await a.start(); await b.start();
  await w.advance(0);
  const before = callsOf(w, 100).length;
  const seqBefore = fs.readFileSync(path.join(w.dir, 'sample.json'), 'utf8').split('\n')[0];
  const x = await a.sampleNow();
  assert.strictEqual(callsOf(w, 100).length, before + 1);
  assert.strictEqual(x.mode, 'full');
  const y = await b.sampleNow();
  assert.strictEqual(w.oneShots.length, 1);
  assert.match(y.text, /oneshot/);
  assert.strictEqual(fs.readFileSync(path.join(w.dir, 'sample.json'), 'utf8').split('\n')[0], seqBefore, 'an off-cadence sample is nobody else\'s');
}));

test('stop() ends the persistent shell by its handle and removes the instance\'s want', () => withWorld(async (w) => {
  const a = w.make(100);
  a.setLevel('chip');
  await a.start();
  await w.advance(0);
  assert.ok(fs.existsSync(path.join(w.dir, 'want-100.json')));
  a.stop();
  assert.strictEqual(fs.existsSync(path.join(w.dir, 'want-100.json')), false);
  assert.strictEqual(a.role(), 'idle');
}));

test('a want from a pid that is gone is ignored and removed; a want that nobody renews goes stale and is ignored', () => withWorld(async (w) => {
  fs.writeFileSync(path.join(w.dir, 'want-777.json'), JSON.stringify({ pid: 777, level: 'panel', at: w.now() }));
  const a = w.make(100);
  a.setLevel('chip');
  await a.start();
  await w.advance(1000);
  assert.strictEqual(fs.existsSync(path.join(w.dir, 'want-777.json')), false, 'its pid is not alive');
  w.alive.add(778);
  fs.writeFileSync(path.join(w.dir, 'want-778.json'), JSON.stringify({ pid: 778, level: 'panel', at: w.now() }));
  await w.advance(2500);
  const rate = callsOf(w, 100).length;
  await w.advance(SP.WANT_STALE_MS + 2500);
  const during = callsOf(w, 100).length - rate;
  await w.advance(95000);
  const after = callsOf(w, 100).length - rate - during;
  assert.ok(during >= 3, 'while the want is fresh it raises the cadence');
  assert.ok(after <= 4, `after it went stale the cadence is the chip's 30 s (got ${after} in 95 s)`);
}));

test('a start time that could not be read is asked for again, and nothing claims the pool without one', () => withWorld(async (w) => {
  let asked = 0;
  let answer = null;
  const a = w.make(100, { poller: { selfStart: async () => { asked++; return answer; } } });
  a.setLevel('chip');
  await a.start();
  await w.advance(SP.CONTROL_MS * 2);
  assert.ok(asked >= 3, `asked again on later ticks (asked ${asked})`);
  assert.notStrictEqual(a.role(), 'owner', 'a claim with a null start could never be told from a reused pid');
  assert.strictEqual(fs.existsSync(path.join(w.dir, 'owner.json')), false);
  answer = 'S100';
  await w.advance(SP.CONTROL_MS * 2);
  assert.strictEqual(a.role(), 'owner');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(w.dir, 'owner.json'), 'utf8')).start, 'S100');
  const before = asked;
  await w.advance(SP.CONTROL_MS * 3);
  assert.strictEqual(asked, before, 'once known it is kept, not asked again');
}));

test('an owner recorded with a null start, whose pid was reused, is taken over once its beat is stale', () => withWorld(async (w) => {
  fs.writeFileSync(path.join(w.dir, 'owner.json'), JSON.stringify({ pid: 100, start: null, since: w.now(), beat: w.now() }));
  w.alive.add(100); w.starts.set(100, 'SOMEONE-ELSE');
  const b = w.make(200);
  b.setLevel('chip');
  await b.start();
  await w.advance(policy.STALE_BEAT_MS - 5000);
  assert.notStrictEqual(b.role(), 'owner', 'a fresh beat is kept');
  await w.advance(policy.STALE_BEAT_MS + SP.CONTROL_MS * 3);
  assert.strictEqual(b.role(), 'owner');
}));

test('the pool folder removed while running is made again and exactly one instance owns; every window gets samples', () => withWorld(async (w) => {
  const a = w.make(100);
  const b = w.make(200);
  a.setLevel('panel'); b.setLevel('panel');
  await a.start(); await b.start();
  await w.advance(0);
  assert.strictEqual(a.role(), 'owner');
  fs.rmSync(w.dir, { recursive: true, force: true });
  await w.advance(SP.CONTROL_MS * 3);
  const roles = [a.role(), b.role()].sort();
  assert.deepStrictEqual(roles, ['follower', 'owner']);
  assert.ok(fs.existsSync(path.join(w.dir, 'owner.json')), 'the folder and the owner record are back');
  await w.advance(10000 + SP.CONTROL_MS);
  const ra = await a.next({ after: null, maxAgeMs: 20000, timeoutMs: 1000 });
  const rb = await b.next({ after: null, maxAgeMs: 20000, timeoutMs: 1000 });
  assert.ok(ra.ok && rb.ok);
}));

test('a folder that cannot be made again after it went falls back to solo: this window samples for itself', () => withWorld(async (w) => {
  const a = w.make(100);
  a.setLevel('panel');
  await a.start();
  await w.advance(0);
  fs.rmSync(w.dir, { recursive: true, force: true });
  fs.writeFileSync(w.dir, 'a file where the folder was');
  await w.advance(SP.CONTROL_MS * 3);
  assert.strictEqual(a.role(), 'owner');
  const n = callsOf(w, 100).length;
  await w.advance(10000 + SP.CONTROL_MS);
  assert.ok(callsOf(w, 100).length > n, 'still sampling');
  fs.rmSync(w.dir, { force: true });
}));

test('seq keeps counting up across owners even when the old sample cannot be read at the moment of the claim', () => withWorld(async (w) => {
  const a = w.make(100);
  a.setLevel('panel');
  await a.start();
  await w.advance(35000);
  const seqOf = () => JSON.parse(fs.readFileSync(path.join(w.dir, 'sample.json'), 'utf8').split(String.fromCharCode(10))[0]).seq;
  const last = seqOf();
  assert.ok(last >= 3);
  w.crash(100); a.stop();
  let failures = 0;
  const readText = (file) => {
    if (/sample\.json$/.test(file) && failures < 1) { failures++; return null; }   // a scanner held it
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
  };
  const b = w.make(200, { poller: { readText } });
  b.setLevel('panel');
  await b.start();
  await w.advance(1000);
  assert.strictEqual(b.role(), 'owner');
  assert.strictEqual(failures, 1, 'the claim-time read was the one that failed');
  assert.ok(seqOf() > last, `seq ${seqOf()} must pass ${last}`);
}));

test('a want that could not be written is tried again on the next tick, not after a full refresh period', () => withWorld(async (w) => {
  fs.mkdirSync(path.join(w.dir, 'want-100.json'));      // a folder in the file's place: the write fails
  const a = w.make(100);
  a.setLevel('chip');
  await a.start();
  assert.notStrictEqual(fs.existsSync(path.join(w.dir, 'want-100.json')) && fs.statSync(path.join(w.dir, 'want-100.json')).isFile(), true);
  fs.rmdirSync(path.join(w.dir, 'want-100.json'));
  await w.advance(SP.CONTROL_MS * 2);
  assert.ok(fs.statSync(path.join(w.dir, 'want-100.json')).isFile(), 'written within two ticks');
}));

test('a want file named for pid 0 or a pid beyond the integer range is not a want', () => withWorld(async (w) => {
  for (const name of ['want-0.json', 'want-99999999999999999999.json']) {
    fs.writeFileSync(path.join(w.dir, name), JSON.stringify({ pid: 0, level: 'panel', at: w.now() }));
  }
  const a = w.make(100, { poller: { pidAlive: () => true } });
  a.setLevel('chip');
  await a.start();
  await w.advance(35000);
  assert.ok(callsOf(w, 100).length <= 2, `chip cadence only (got ${callsOf(w, 100).length})`);
}));

test('a deposed owner whose sample is still running finishes it but neither publishes it nor starts another (BACKLOG #126)', () => withWorld(async (w) => {
  w.execDelay = 15000;
  const a = w.make(1001);
  a.setLevel('panel');
  await a.start();
  await w.advance(10000);
  assert.strictEqual(callsOf(w, 1001).length, 1, '1001 is mid-sample');
  // A foreign process takes the folder and dies; the dead record forces 1002 to claim at once. (pid 5001 is that process.)
  w.alive.add(5001); w.starts.set(5001, 'F5001');
  fs.writeFileSync(path.join(w.dir, 'owner.json'), JSON.stringify({ pid: 5001, start: 'F5001', since: w.now(), beat: w.now() }));
  w.alive.delete(5001);
  const b = w.make(1002);
  b.setLevel('panel');
  await b.start();
  await w.advance(100);
  assert.strictEqual(callsOf(w, 1002).length, 1, '1002 samples at once');
  await w.advance(30000);
  assert.strictEqual(callsOf(w, 1001).length, 1, '1001 started no second sample after it was deposed');
  assert.ok(w.calls.every(c => c.ownerPid === c.pid), 'every sample started while owner.json named its own process');
  const head = JSON.parse(fs.readFileSync(path.join(w.dir, 'sample.json'), 'utf8').split('\n')[0]);
  assert.strictEqual(head.ownerPid, 1002, '1001 late sample did not overwrite 1002');
  assert.strictEqual(a.role(), 'follower');
  assert.strictEqual(b.role(), 'owner');
}));

test('a deposed owner whose sample ends BEFORE its next control tick publishes nothing over its successor (BACKLOG #126)', () => withWorld(async (w) => {
  w.execDelay = 11000;
  const a = w.make(1001);
  a.setLevel('panel');
  await a.start();
  await w.advance(10001);                  // 1001's last tick was at 10000; the next is 12000; its sample ends at 11000
  w.alive.add(5001); w.starts.set(5001, 'F5001');
  fs.writeFileSync(path.join(w.dir, 'owner.json'), JSON.stringify({ pid: 5001, start: 'F5001', since: w.now(), beat: w.now() }));
  w.alive.delete(5001);
  const b = w.make(1002);
  b.setLevel('panel');
  await b.start();
  assert.strictEqual(w.ownerPid(), 1002);
  await w.advance(1500);                   // 1001's sample has ended (t=11000); 1002's has not (ends at 21001)
  assert.strictEqual(fs.existsSync(path.join(w.dir, 'sample.json')), false, 'nothing was published: 1001 is deposed and 1002 is still sampling');
}));

test('an owner.json that cannot be read is doubt, not "no owner": a live owner with a fresh beat is not taken from, a stale one is (BACKLOG #126)', () => withWorld(async (w) => {
  const a = w.make(1001);
  a.setLevel('chip');
  await a.start();
  assert.strictEqual(a.role(), 'owner');
  const file = path.join(w.dir, 'owner.json');
  fs.writeFileSync(file, '{ unreadable');                      // what two failed reads look like to a reader: no record it can parse
  const stamp = (ms) => { const s = ms / 1000; fs.utimesSync(file, s, s); };
  stamp(w.now());
  const b = w.make(1002);
  b.setLevel('chip');
  await b.start();
  await w.advance(SP.CONTROL_MS * 3);
  assert.strictEqual(b.role(), 'follower', 'B does not claim over a live A on a record it cannot read');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ unreadable', 'and does not write over it');
  assert.strictEqual(a.role(), 'owner', 'A does not drop its own ownership on a read that failed');
  stamp(w.now() - policy.STALE_BEAT_MS - 1000);               // left unreadable past the stale age: nobody is renewing it
  await w.advance(SP.CONTROL_MS * 2);
  assert.ok([1001, 1002].includes(w.ownerPid()), 'a record that stays unreadable past the stale age is claimed again');
  assert.strictEqual([a, b].filter(p => p.role() === 'owner').length, 1, 'by exactly one of them');
}));

test('property: any sequence of starts, stops, crashes and time leaves at most one owner, and exactly one once settled', async () => {
  const ops = fc.array(fc.oneof(
    fc.record({ op: fc.constant('start'), who: fc.integer({ min: 0, max: 3 }), level: fc.constantFrom('hidden', 'chip', 'panel') }),
    fc.record({ op: fc.constant('stop'), who: fc.integer({ min: 0, max: 3 }) }),
    fc.record({ op: fc.constant('crash'), who: fc.integer({ min: 0, max: 3 }) }),
    fc.record({ op: fc.constant('level'), who: fc.integer({ min: 0, max: 3 }), level: fc.constantFrom('hidden', 'chip', 'panel') }),
    fc.record({ op: fc.constant('wait'), ms: fc.integer({ min: 100, max: 40000 }) }),
    fc.record({ op: fc.constant('slow'), ms: fc.constantFrom(0, 1500, 7000, 15000) }),   // a sample that spans control ticks
    fc.record({ op: fc.constant('depose') }),                                            // a foreign process takes the folder
    fc.record({ op: fc.constant('undepose') }),                                          // and it dies
  ), { minLength: 1, maxLength: 14 });

  await fc.assert(fc.asyncProperty(ops, async (script) => {
    const w = makeWorld();
    try {
      const running = new Set();
      let pidSeed = 1000;
      const slot = new Map();     // who -> pid of its CURRENT incarnation
      const owners = () => [...running].filter(pid => w.alive.has(pid) && w.pollers.get(pid).role() === 'owner');
      const lastSeq = { v: 0 };
      let lastKey = null;
      let crashedAtLastCheck = new Set();
      let callsChecked = 0;
      let foreign = 5000;
      let foreignPid = null;               // a live process that is not one of ours and holds owner.json: it is respected
      const checkWriter = () => {
        let head;
        try { head = JSON.parse(fs.readFileSync(path.join(w.dir, 'sample.json'), 'utf8').split(String.fromCharCode(10))[0]); } catch { return; }
        const key = `${head.ownerPid}:${head.seq}:${head.at}`;
        if (key === lastKey) return;
        lastKey = key;
        // Whoever wrote the new record ran the script (so it owned the sampling) and was not already dead at the last check.
        assert.ok(w.calls.some(c => c.pid === head.ownerPid), `a record by ${head.ownerPid}, which never sampled`);
        assert.ok(!crashedAtLastCheck.has(head.ownerPid), `a dead process ${head.ownerPid} published`);
      };
      const checkSeq = () => {
        try {
          const head = JSON.parse(fs.readFileSync(path.join(w.dir, 'sample.json'), 'utf8').split('\n')[0]);
          assert.ok(head.seq >= lastSeq.v, `seq went backwards: ${head.seq} < ${lastSeq.v}`);
          lastSeq.v = head.seq;
        } catch (e) { if (e instanceof assert.AssertionError) throw e; }
      };
      for (const s of script) {
        if (s.op === 'start') {
          if (slot.has(s.who) && running.has(slot.get(s.who)) && w.alive.has(slot.get(s.who))) continue;
          const pid = ++pidSeed;
          slot.set(s.who, pid);
          const p = w.make(pid);
          p.setLevel(s.level);
          running.add(pid);
          await p.start();
        } else if (s.op === 'stop') {
          const pid = slot.get(s.who);
          if (pid && running.has(pid) && w.alive.has(pid)) { w.pollers.get(pid).stop(); running.delete(pid); w.alive.delete(pid); }
        } else if (s.op === 'crash') {
          const pid = slot.get(s.who);
          if (pid && running.has(pid)) w.crash(pid);
        } else if (s.op === 'level') {
          const pid = slot.get(s.who);
          if (pid && running.has(pid) && w.alive.has(pid)) w.pollers.get(pid).setLevel(s.level);
        } else if (s.op === 'slow') {
          w.execDelay = s.ms;
        } else if (s.op === 'depose') {
          const pid = ++foreign;
          foreignPid = pid;
          w.alive.add(pid); w.starts.set(pid, 'F' + pid);
          fs.writeFileSync(path.join(w.dir, 'owner.json'), JSON.stringify({ pid, start: 'F' + pid, since: w.now(), beat: w.now() }));
        } else if (s.op === 'undepose') {
          if (foreignPid !== null) w.alive.delete(foreignPid);
        } else {
          await w.advance(s.ms);
        }
        // What the processes DO, not what role() believes between ticks: a sample may only START while owner.json names its
        // own process (a deposed owner's one in-flight sample may still finish, but it starts no other), and seq never goes back.
        for (const c of w.calls.slice(callsChecked)) assert.strictEqual(c.ownerPid, c.pid, `${c.pid} started a sample while owner.json named ${c.ownerPid}`);
        callsChecked = w.calls.length;
        checkSeq();
        checkWriter();
        crashedAtLastCheck = new Set(w.crashed);
      }
      // Settle: everything that is still alive has had two control ticks.
      await w.advance(SP.CONTROL_MS * 3);
      const live = [...running].filter(pid => w.alive.has(pid));
      const foreignHolds = foreignPid !== null && w.alive.has(foreignPid);
      if (foreignHolds) assert.strictEqual(owners().length, 0, `a live foreign owner is kept, got ${owners()}`);
      else if (live.length > 0) assert.strictEqual(owners().length, 1, `live ${live} owners ${owners()}`);
      checkSeq();
    } finally {
      for (const p of w.pollers.values()) { try { p.stop(); } catch { /* ignore */ } }
      w.cleanup();
    }
  }), {
    numRuns: 100,
    examples: [[[   // fast-check's 2026-10-28 counterexamples, kept as fixed cases
      { op: 'start', who: 0, level: 'hidden' }, { op: 'depose' }, { op: 'undepose' }, { op: 'start', who: 1, level: 'hidden' },
    ]], [[
      { op: 'start', who: 0, level: 'panel' }, { op: 'slow', ms: 15000 }, { op: 'wait', ms: 10000 }, { op: 'depose' }, { op: 'undepose' },
      { op: 'start', who: 1, level: 'panel' }, { op: 'wait', ms: 100 },
    ]]],
  });
});

test('defaultDir: a probe\'s UI-state folder wins; otherwise a versioned folder under the user\'s local app data', () => {
  assert.strictEqual(SP.defaultDir({ uiStateDir: 'C:\\p\\ui', env: {} }), path.join('C:\\p\\ui', 'resource-poller-v1'));
  assert.strictEqual(SP.defaultDir({ uiStateDir: null, env: { LOCALAPPDATA: 'C:\\L' } }), path.join('C:\\L', 'claude-custom', 'resource-poller-v1'));
  assert.match(SP.defaultDir({ uiStateDir: null, env: {} }), /claude-custom[\\/]resource-poller-v1$/);
});

test('a folder that cannot be made degrades to solo: this instance samples for itself, nothing is shared, nothing throws', () => withWorld(async (w) => {
  const blocker = path.join(w.dir, 'file-in-the-way');
  fs.writeFileSync(blocker, 'x');
  const a = w.make(100, { poller: { dir: path.join(blocker, 'sub') } });
  a.setLevel('chip');
  await a.start();
  await w.advance(0);
  assert.strictEqual(a.role(), 'owner');
  assert.strictEqual(callsOf(w, 100).length, 1);
  const r = await a.next({ after: null, maxAgeMs: 60000, timeoutMs: 1000 });
  assert.strictEqual(r.ok, true);
}));

test('hiding and showing again soon after a sample still samples at once (a second reading is what makes a CPU figure)', () => withWorld(async (w) => {
  const a = w.make(100);
  a.setLevel('chip');
  await a.start();
  await w.advance(1000);
  assert.strictEqual(callsOf(w, 100).length, 1);
  a.setLevel('hidden');
  await w.advance(100);
  a.setLevel('chip');
  await w.advance(100);
  assert.strictEqual(callsOf(w, 100).length, 2, 'not 30 s later');
}));

test('a sample that ends after stop() is dropped, solo or shared: nothing is published by a poller that has left', () => withWorld(async (w) => {
  let release;
  const a = w.make(100, { poller: { dir: path.join(path.join(w.dir, 'file-in-the-way'), 'sub'), makeExec: () => () => new Promise((r) => { release = () => r('late\nEND'); }) } });
  fs.writeFileSync(path.join(w.dir, 'file-in-the-way'), 'x');
  a.setLevel('chip');
  await a.start();
  await w.advance(0);
  a.stop();
  release();
  await w.advance(100);
  assert.strictEqual(a.latest(), null);
}));

test('property: a record written to the file reads back the same, whatever the sample text holds', () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 1, max: 4e12 }), fc.integer({ min: 1, max: 99999 }),
    fc.string({ minLength: 1, maxLength: 200 }).filter(t => t.trim() !== ''), fc.boolean(), fc.string({ maxLength: 40 }),
    (seq, at, ownerPid, text, ok, error) => {
      const rec = SP.decodeRecord(SP.encodeRecord({ seq, at, mode: 'full', ownerPid, ok, error }, text));
      assert.ok(rec);
      assert.strictEqual(rec.seq, seq);
      assert.strictEqual(rec.at, at);
      assert.strictEqual(rec.ok, ok);
      assert.strictEqual(rec.text, ok ? text : null, 'newlines and END inside the text survive');
      assert.strictEqual(rec.key, `${ownerPid}:${seq}:${at}`);
    }));
});

test('decodeRecord refuses what is not ours: no header line, another version, junk fields, an ok record with no text', () => {
  assert.strictEqual(SP.decodeRecord(null), null);
  assert.strictEqual(SP.decodeRecord('no newline'), null);
  assert.strictEqual(SP.decodeRecord('{not json}\ntext'), null);
  assert.strictEqual(SP.decodeRecord(JSON.stringify({ v: 2, seq: 1, at: 1, mode: 'full', ok: true }) + '\ntext'), null);
  assert.strictEqual(SP.decodeRecord(JSON.stringify({ v: 1, seq: 1.5, at: 1, mode: 'full', ok: true }) + '\ntext'), null);
  assert.strictEqual(SP.decodeRecord(JSON.stringify({ v: 1, seq: 1, at: 1, mode: 'full', ok: true }) + '\n'), null);
});
