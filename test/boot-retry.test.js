'use strict';
// BACKLOG #217: a spawn that fails because claude.exe is mid-update is retried, with a bound; any other failure is left alone.
const test = require('node:test');
const assert = require('node:assert');
const {
  isRetryableSpawnError, nextStep, RETRY_EVERY_MS, GIVE_UP_AFTER_MS, RETRY_LINE, giveUpLine, createBootRetry, settleVersion,
} = require('../host/boot-retry');

test('the measured failure (node-pty, Windows error 216) is retryable', () => {
  assert.strictEqual(isRetryableSpawnError(new Error('Cannot create process, error code: 216')), true);
});

test('the other "binary not usable right now" errors are retryable', () => {
  for (const m of ['Cannot create process, error code: 193', 'Cannot create process, error code: 32', 'File not found: C:\\x\\claude.exe']) {
    assert.strictEqual(isRetryableSpawnError(new Error(m)), true, m);
  }
  for (const code of ['EBUSY', 'EACCES', 'ENOENT', 'EPERM']) {
    assert.strictEqual(isRetryableSpawnError(Object.assign(new Error('x'), { code })), true, code);
  }
});

test('a code is matched whole: 2160 or 1932 is not 216 or 193', () => {
  assert.strictEqual(isRetryableSpawnError(new Error('Cannot create process, error code: 2160')), false);
  assert.strictEqual(isRetryableSpawnError(new Error('Cannot create process, error code: 1932')), false);
  assert.strictEqual(isRetryableSpawnError(new Error('Cannot create process, error code: 5')), false);
});

test('anything else, and anything that is not an error, is not retryable', () => {
  for (const v of [new Error('boom'), new Error(''), null, undefined, 216, {}, 'error code: 216x']) {
    assert.strictEqual(isRetryableSpawnError(v), false, String(v));
  }
  assert.strictEqual(isRetryableSpawnError('Cannot create process, error code: 216'), true, 'a thrown string reads the same');
});

test('the schedule is 5 s for 2 minutes', () => {
  assert.strictEqual(RETRY_EVERY_MS, 5000);
  assert.strictEqual(GIVE_UP_AFTER_MS, 120000);
});

test('a non-retryable failure is not ours', () => {
  assert.deepStrictEqual(nextStep({ err: new Error('boom'), firstFailedAt: null, now: 1000 }), { action: 'fail' });
});

test('the first retryable failure starts the clock and retries after 5 s', () => {
  assert.deepStrictEqual(
    nextStep({ err: new Error('Cannot create process, error code: 216'), firstFailedAt: null, now: 1000 }),
    { action: 'retry', delayMs: 5000, firstFailedAt: 1000, first: true },
  );
});

test('a later failure inside the bound retries again, keeping the clock', () => {
  const r = nextStep({ err: new Error('Cannot create process, error code: 216'), firstFailedAt: 1000, now: 1000 + 60000 });
  assert.deepStrictEqual(r, { action: 'retry', delayMs: 5000, firstFailedAt: 1000, first: false });
});

test('the bound: the failure that cannot be followed by a retry inside 2 minutes gives up', () => {
  const err = new Error('Cannot create process, error code: 216');
  // 115 s in: the next try at 120 s is still inside the bound
  assert.strictEqual(nextStep({ err, firstFailedAt: 0, now: 115000 }).action, 'retry');
  // 116 s in: the next try would land past 120 s
  assert.strictEqual(nextStep({ err, firstFailedAt: 0, now: 116000 }).action, 'give-up');
  assert.strictEqual(nextStep({ err, firstFailedAt: 0, now: 500000 }).action, 'give-up');
});

test('a fake spawn failing N times then succeeding is retried N times; one that never succeeds hits the bound', () => {
  const err = new Error('Cannot create process, error code: 216');
  const run = (failures) => {
    let t = 0, first = null, tries = 0;
    for (;;) {
      tries++;
      if (tries > failures) return { tries, outcome: 'started' };
      const s = nextStep({ err, firstFailedAt: first, now: t });
      if (s.action === 'give-up') return { tries, outcome: 'gave up' };
      first = s.firstFailedAt; t += s.delayMs;
    }
  };
  assert.deepStrictEqual(run(3), { tries: 4, outcome: 'started' });
  const never = run(Infinity);
  assert.strictEqual(never.outcome, 'gave up');
  assert.strictEqual(never.tries, 25, 'tries at 0, 5, ... 120 s, exactly');
});

test('the lines say what is happening, once, on one line (the retry wording is Ricardo\'s pending pick: one constant)', () => {
  assert.strictEqual(RETRY_LINE, "Claude Code isn't ready (it may be updating), retrying for up to 2 minutes…");
  const g = giveUpLine(new Error('Cannot create process, error code: 216'));
  assert.match(g, /error code: 216/);
  assert.ok(!/[\r\n\x1b]/.test(giveUpLine(new Error('a\r\n\x1b[31mb'))));
  assert.strictEqual(giveUpLine(new Error('x'.repeat(5000))), 'Claude Code could not be started: ' + 'x'.repeat(200), 'the reason is capped at exactly 200');
  assert.ok(giveUpLine(null).length > 0);
});

// --- Miguel Y2 / Dexter 2: a binary that never existed is not "updating" -----------------------------------------------------------
test('not-found, ENOENT, EACCES and EPERM are retried only when the exe existed; 216/193/32 and EBUSY always are', () => {
  const never = { binExisted: false };
  for (const m of ['File not found: C:\\x\\claude.exe']) {
    assert.strictEqual(isRetryableSpawnError(new Error(m), never), false, m);
    assert.strictEqual(isRetryableSpawnError(new Error(m), { binExisted: true }), true, m);
  }
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    assert.strictEqual(isRetryableSpawnError(Object.assign(new Error('x'), { code }), never), false, code);
    assert.strictEqual(isRetryableSpawnError(Object.assign(new Error('x'), { code }), { binExisted: true }), true, code);
  }
  for (const m of ['Cannot create process, error code: 216', 'Cannot create process, error code: 193', 'Cannot create process, error code: 32']) {
    assert.strictEqual(isRetryableSpawnError(new Error(m), never), true, m);
  }
  assert.strictEqual(isRetryableSpawnError(Object.assign(new Error('x'), { code: 'EBUSY' }), never), true);
  assert.deepStrictEqual(nextStep({ err: new Error('File not found: x'), firstFailedAt: null, now: 0, binExisted: false }), { action: 'fail' });
});

// --- the retry chain, behaviourally, with a fake clock and fake timers (Dexter 3/5, Miguel Y3) --------------------------------------
const E216 = () => new Error('Cannot create process, error code: 216');

function harness({ binExisted = true, unreadable = () => false, prepare = async () => {}, failN = 0, startImpl = null } = {}) {
  const h = { t: 0, timers: [], log: [], said: [], ended: [], prepared: 0, calls: 0, started: 0, unreadableNow: unreadable };
  const deps = {
    now: () => h.t,
    setTimer: (fn, ms) => { const timer = { fn, at: h.t + ms }; h.timers.push(timer); return timer; },
    say: (s) => h.said.push(s),
    end: (e) => h.ended.push(e),
    log: (l) => h.log.push(l),
    prepare: async () => { h.prepared++; await prepare(h); },
    unreadable: () => h.unreadableNow(),
    binExisted: () => binExisted,
    startSession: () => {
      h.calls++;
      if (startImpl) return startImpl(h);
      if (h.calls <= failN) { if (!h.retry.failed(E216())) throw E216(); return; }
      h.started++;
      h.retry.started();
    },
  };
  h.retry = createBootRetry(deps);
  h.start = () => deps.startSession();
  h.fire = async () => { const timer = h.timers.shift(); h.t = Math.max(h.t, timer.at); await timer.fn(); };
  return h;
}

test('a spawn that fails 3 times then works: the line is said once, the host logs each try and the success, nothing ends', async () => {
  const h = harness({ failN: 3 });
  h.start();
  while (h.timers.length) await h.fire();
  assert.strictEqual(h.calls, 4);
  assert.strictEqual(h.started, 1);
  assert.deepStrictEqual(h.said, [RETRY_LINE], 'said once, on the first failure only');
  assert.deepStrictEqual(h.ended, []);
  assert.strictEqual(h.t, 15000);
  assert.ok(h.log.some(l => /attempt 1\b/.test(l) && /retrying/.test(l)), h.log.join('\n'));
  assert.ok(h.log.some(l => /attempt 3\b/.test(l)));
  assert.ok(h.log.some(l => /started after 3 retries/.test(l)), h.log.join('\n'));
});

test('a spawn that never works: exactly 25 tries over 2 minutes, then the host ends once with the reason and says why in the tab', async () => {
  const h = harness({ failN: Infinity });
  h.start();
  while (h.timers.length) await h.fire();
  assert.strictEqual(h.calls, 25);
  assert.strictEqual(h.t, 120000);
  assert.strictEqual(h.ended.length, 1);
  assert.match(h.ended[0], /Claude Code could not be started: .*error code: 216/);
  assert.strictEqual(h.said.length, 2, 'the retry line, then the give-up line');
  assert.strictEqual(h.said[0], RETRY_LINE);
  assert.match(h.said[1], /could not be started/);
  assert.ok(h.log.some(l => /gave up after 25 tries/.test(l)), h.log.join('\n'));
  assert.ok(!h.log.some(l => /started after/.test(l)));
});

test('an error that is not ours is not taken: false, no timer, no line', () => {
  const h = harness();
  assert.strictEqual(h.retry.failed(new Error('boom')), false);
  assert.strictEqual(h.timers.length, 0);
  assert.deepStrictEqual(h.said, []);
});

test('a binary that never existed fails at once (not ours), where one that did is retried', () => {
  const never = harness({ binExisted: false });
  assert.strictEqual(never.retry.failed(new Error('File not found: C:\\x\\claude.exe')), false);
  assert.strictEqual(never.timers.length, 0);
  const did = harness({ binExisted: true });
  assert.strictEqual(did.retry.failed(new Error('File not found: C:\\x\\claude.exe')), true);
  assert.strictEqual(did.timers.length, 1);
});

test('single flight (Dexter 3B): a second start failing while a retry is pending arms no second chain', async () => {
  const h = harness({ failN: 2 });
  h.start();                                   // fails at t=0: one timer
  assert.strictEqual(h.timers.length, 1);
  h.t = 2000;
  h.start();                                   // the kill switch cleared: restartAfterRefusal starts again; fails while the timer is pending
  assert.strictEqual(h.timers.length, 1, 'still one pending retry');
  assert.deepStrictEqual(h.said, [RETRY_LINE], 'and the line is not said twice');
  await h.fire();                              // the one timer: third call works
  assert.strictEqual(h.timers.length, 0);
  assert.strictEqual(h.started, 1);
});

test('a chain that ends without a spawn (kill switch refused, host stopped) frees the clock: an outage at t=600 s gets a fresh 2 minutes (Dexter 3A)', async () => {
  let refuse = true;
  const h = harness({
    startImpl: (x) => {
      if (refuse) return;                       // startSession returned with no spawn: the kill switch, a stop
      if (!x.retry.failed(E216())) throw E216();
    },
  });
  assert.strictEqual(h.retry.failed(E216()), true);   // first failure at t=0
  await h.fire();                                     // the timer: refused, nothing re-armed
  assert.strictEqual(h.timers.length, 0);
  h.t = 600000;                                       // the switch is cleared much later
  refuse = false;
  assert.strictEqual(h.retry.failed(E216()), true, 'a fresh outage retries, it does not inherit the old clock');
  assert.strictEqual(h.timers.length, 1);
  assert.deepStrictEqual(h.said, [RETRY_LINE, RETRY_LINE], 'the new outage says so again');
  assert.deepStrictEqual(h.ended, []);
});

test('a give-up frees the clock too', async () => {
  const h = harness({ failN: Infinity });
  h.start();
  while (h.timers.length) await h.fire();
  assert.strictEqual(h.ended.length, 1);
  h.t = 900000;
  assert.strictEqual(h.retry.failed(E216()), true);
  assert.strictEqual(h.ended.length, 1, 'a later outage retried instead of giving up on its first failure');
  assert.strictEqual(h.timers.length, 1);
});

test('a good spawn frees the clock: the next outage starts a fresh 2 minutes', async () => {
  const h = harness({ failN: 1 });
  h.start();
  await h.fire();                               // works
  assert.strictEqual(h.started, 1);
  h.t = 500000;
  assert.strictEqual(h.retry.failed(E216()), true);
  assert.strictEqual(h.ended.length, 0);
  assert.strictEqual(h.said.length, 2);
  assert.strictEqual(h.timers.length, 1);
});

test('the timer\'s own failure (startSession throws what is not ours) ends the host with it and frees the clock', async () => {
  const h = harness({ startImpl: () => { throw new Error('boom'); } });
  h.retry.failed(E216());
  await h.fire();
  assert.strictEqual(h.ended.length, 1);
  assert.match(h.ended[0], /boom/);
  assert.match(h.said[h.said.length - 1], /boom/);
  assert.ok(h.log.some(l => /boom/.test(l)));
});

test('the time prepare() takes counts against the bound (Dexter 4): a last try that would land past 2 minutes is not made', async () => {
  const h = harness({
    failN: Infinity,
    unreadable: () => true,
    prepare: async (x) => { if (x.t >= 120000) x.t += 3000; },
  });
  h.start();
  while (h.timers.length) await h.fire();
  assert.strictEqual(h.calls, 24, 'tries at 0..115 s; the 120 s one waited 3 s for the version read and was dropped');
  assert.strictEqual(h.ended.length, 1);
  assert.match(h.ended[0], /error code: 216/, 'with the spawn error, the last real one');
});

test('the version is re-read before each retry only while it was unreadable (Miguel Y5)', async () => {
  const off = harness({ failN: 2 });
  off.start();
  while (off.timers.length) await off.fire();
  assert.strictEqual(off.prepared, 0, 'a mod off on purpose is not re-decided');
  const bad = harness({ failN: 2, unreadable: () => true });
  bad.start();
  while (bad.timers.length) await bad.fire();
  assert.strictEqual(bad.prepared, 2, 'once per retry');
});

// --- Dexter 1: a null --version at boot with a spawn that then works --------------------------------------------------------------
test('settleVersion: an unreadable version is read again, briefly, before the session starts (so the mod loads)', async () => {
  let unreadable = true, prepared = 0; const slept = [];
  await settleVersion({
    prepare: async () => { prepared++; unreadable = false; },
    unreadable: () => unreadable,
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.strictEqual(prepared, 1, 'stops as soon as it reads');
  assert.deepStrictEqual(slept, [1500]);
});

test('settleVersion: a version that never reads is tried twice more, no more; a readable one is not touched', async () => {
  let prepared = 0, slept = 0;
  await settleVersion({ prepare: async () => { prepared++; }, unreadable: () => true, sleep: async () => { slept++; } });
  assert.strictEqual(prepared, 2);
  assert.strictEqual(slept, 2);
  prepared = 0; slept = 0;
  await settleVersion({ prepare: async () => { prepared++; }, unreadable: () => false, sleep: async () => { slept++; } });
  assert.strictEqual(prepared, 0);
  assert.strictEqual(slept, 0);
});

// --- the exe is missing at BOOT (an update has it deleted for a moment): that is an install mid-update, not "never installed" ------
const path = require('node:path');
const { claudeLooksInstalled, createLiveBin } = require('../host/boot-retry');
const HOME = path.join('C:', 'Users', 'u');
const DATA = path.join(HOME, '.local/share/claude');
const looks = (existing, over = {}) => claudeLooksInstalled({
  bin: 'claude.exe', explicit: false, home: HOME,
  exists: (p) => existing.includes(p), ...over,
});

test('claudeLooksInstalled: the exe itself being there is enough', () => {
  assert.strictEqual(looks(['claude.exe']), true);
});

test("claudeLooksInstalled: the exe missing but the CLI's own data folder there is an update in progress (measured 2026-11-11)", () => {
  assert.strictEqual(looks([DATA]), true);
});

test('claudeLooksInstalled: the npm package folder is not a marker (npm moves it aside in the same update that removes the exe)', () => {
  const seen = [];
  claudeLooksInstalled({ bin: 'claude.exe', explicit: false, home: HOME, exists: (p) => { seen.push(p); return false; } });
  assert.deepStrictEqual(seen, ['claude.exe', DATA]);
});

test('claudeLooksInstalled: nothing of an install anywhere is not installed, so a missing claude still fails at once', () => {
  assert.strictEqual(looks([]), false);
});

test('claudeLooksInstalled: a CLAUDE_CUSTOM_BIN that is not there stays a typo, whatever else is installed', () => {
  const typo = path.join('C:', 'typo', 'claude.exe');
  const ok = path.join('C:', 'ok', 'claude.exe');
  assert.strictEqual(looks([DATA], { explicit: true, bin: typo }), false);
  assert.strictEqual(looks([ok], { explicit: true, bin: ok }), true);
});

// --- Dexter 1 / Miguel Y1, Y2: every reader of the path (the pty, the version read, Ask) gets the same, live one ----------------------
const FULL = path.join('C:', 'Users', 'u', '.local', 'bin', 'claude.exe');
function liveBin({ present = [], resolved = FULL, initial = 'claude.exe' } = {}) {
  const logs = []; let resolves = 0;
  const f = createLiveBin({ initial, exists: (p) => present.includes(p), resolve: () => { resolves++; return resolved; }, log: (l) => logs.push(l) });
  return { f, logs, resolves: () => resolves, present };
}

test('createLiveBin: a bare boot name that is not there resolves to the real path, once, and says so', () => {
  const b = liveBin();
  assert.strictEqual(b.f(), FULL);
  assert.strictEqual(b.f(), FULL);
  assert.strictEqual(b.logs.length, 1, 'said once');
  assert.match(b.logs[0], /claude\.exe/);
  assert.ok(b.logs[0].includes(FULL));
});

test('createLiveBin: a path that is there is returned as it is, with no resolving and no line', () => {
  const b = liveBin({ initial: FULL, present: [FULL] });
  assert.strictEqual(b.f(), FULL);
  assert.strictEqual(b.resolves(), 0);
  assert.deepStrictEqual(b.logs, []);
});

test('createLiveBin: still nothing to find keeps the name and says nothing', () => {
  const b = liveBin({ resolved: 'claude.exe' });
  assert.strictEqual(b.f(), 'claude.exe');
  assert.deepStrictEqual(b.logs, []);
});

test('createLiveBin: the version read and Ask share it: one function, one answer (the wiring is pinned in boot-retry-wiring.test.js)', () => {
  const b = liveBin();
  assert.strictEqual(b.f(), b.f());
});
