'use strict';
/**
 * host/occupancy-service.js: what every window knows about worktree occupancy (backlog #44 + #47). It reads
 * the claim folder, keeps only the claims whose launching host is PROVEN alive, and says when that set
 * changed. A killed host writes no file event, so a timer re-checks.
 */
const test = require('node:test');
const assert = require('node:assert');

// A diagnostic is pinned by what a kill needs (logged once, under the [occupancy] prefix, about this topic,
// ending in the reason), not by its prose: rewording the sentence between them breaks nothing.
function loggedOnce(logs, topic, reason) {
  assert.strictEqual(logs.length, 1, JSON.stringify(logs));
  assert.ok(logs[0].startsWith('[occupancy] '), logs[0]);
  assert.ok(logs[0].includes(topic), `${logs[0]} should be about ${topic}`);
  assert.ok(logs[0].endsWith(reason), `${logs[0]} should end with its reason ${JSON.stringify(reason)}`);
  if (reason === '') assert.ok(!/undefined|null|\[object|NaN/.test(logs[0]), `no reason must not print a placeholder: ${logs[0]}`);
}
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createOccupancyService } = require('../host/occupancy-service');
const S = require('../host/occupancy-store');

const DEV = path.resolve('/occ-svc/dev');
const FEAT = path.resolve('/occ-svc/feat-x');

const record = (over = {}) => ({
  agentId: 'ag1', agent: 'electron-pro', worktree: FEAT, also: [], fromBranch: 'develop', fromRoot: DEV,
  hostPid: 4242, hostStartedAt: '1000', firstAt: 100, lastAt: 200, count: 1, ...over,
});

function rig(over = {}) {
  const state = tmpDir('occ-svc-');
  const dir = S.occupancyDir(state);
  const writer = S.createClaimWriter({ stateRoot: state, now: () => Date.now(), log: () => {} });
  const r = { state, dir, writer, running: new Map([[4242, '1000']]), calls: 0, changes: 0, logs: [], watchers: [], timers: [], clock: 1_000_000, ensured: 0 };
  r.service = createOccupancyService({
    dir,
    ensureDir: () => { r.ensured += 1; fs.mkdirSync(dir, { recursive: true }); },
    startTimes: async (pids) => {
      r.calls += 1;
      if (r.running === null) return null;
      return new Map(pids.filter(p => r.running.has(p)).map(p => [p, r.running.get(p)]));
    },
    onChange: () => { r.changes += 1; },
    watch: (d, cb, opts) => { const w = { d, cb, opts, closed: false, close() { this.closed = true; } }; r.watchers.push(w); return w; },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; r.timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
    now: () => r.clock,
    log: (...a) => r.logs.push(a.join(' ')),
    ...over,
  });
  r.fire = async (t) => { if (t.live) { t.live = false; await t.fn(); } };
  r.pending = () => r.timers.filter(t => t.live);
  return r;
}

test('nothing claimed: no claims, the folder is "missing", and nobody is told of a change', async () => {
  const r = rig();
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), []);
  assert.strictEqual(r.service.state(), 'missing');
  assert.strictEqual(r.changes, 0);
  assert.strictEqual(r.calls, 0, 'no claim, no OS query');
});

test('a claim whose host is proven alive is current, and the change is announced once', async () => {
  const r = rig();
  r.writer.write(record());
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current().map(c => c.agentId), ['ag1']);
  assert.strictEqual(r.changes, 1);
  await r.service.refresh();
  assert.strictEqual(r.changes, 1, 'nothing changed: nothing announced');
});

test('a rewritten lastAt / count is not a change (it only feeds a label)', async () => {
  const r = rig();
  r.writer.write(record({ lastAt: 1, count: 1 }));
  await r.service.refresh();
  fs.writeFileSync(path.join(r.dir, 'ag1.json'), require('../host/agent-occupancy').serializeClaim(record({ lastAt: 99999, count: 40 })));
  await r.service.refresh();
  assert.strictEqual(r.changes, 1);
  assert.strictEqual(r.service.current()[0].count, 40, 'but the current claim is the fresh one');
});

test('a dead host\'s claim is never current, and a reader never deletes it', async () => {
  const r = rig();
  r.running = new Map();
  r.writer.write(record());
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), []);
  assert.ok(fs.existsSync(path.join(r.dir, 'ag1.json')), 'the file is still there');
});

test('a reused pid (same pid, other start time) is not current', async () => {
  const r = rig();
  r.running = new Map([[4242, '5555']]);
  r.writer.write(record());
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), []);
});

test('a claim with no hostStartedAt is not current', async () => {
  const r = rig();
  r.writer.write(record({ hostStartedAt: null }));
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), []);
});

test('the host dies: the next refresh clears the claim and announces it', async () => {
  const r = rig();
  r.writer.write(record());
  await r.service.refresh();
  r.running = new Map();
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), []);
  assert.strictEqual(r.changes, 2);
});

test('the file is deleted (SubagentStop): the next refresh clears it', async () => {
  const r = rig();
  r.writer.write(record());
  await r.service.refresh();
  r.writer.remove('ag1');
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), []);
  assert.strictEqual(r.changes, 2);
});

test('when the OS can\'t be asked, a claim already proven live stays, and one never proven never appears', async () => {
  const r = rig();
  r.writer.write(record({ agentId: 'proven' }));
  await r.service.refresh();
  r.writer.write(record({ agentId: 'newcomer' }));
  r.running = null;
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current().map(c => c.agentId), ['proven']);
});

test('...and once the OS answers again a dead one goes', async () => {
  const r = rig();
  r.writer.write(record());
  await r.service.refresh();
  r.running = null;
  await r.service.refresh();
  r.running = new Map();
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), []);
});

test('a claim proven for one host start time is not kept alive by a DIFFERENT claim for the same agent id', async () => {
  const r = rig();
  r.writer.write(record());
  await r.service.refresh();
  fs.writeFileSync(path.join(r.dir, 'ag1.json'), require('../host/agent-occupancy').serializeClaim(record({ hostStartedAt: '7777' })));
  r.running = null;
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), [], 'the new file was never proven');
});

test('an unlistable folder is "unreadable", logged once, and shows nothing -- never a fake free', async () => {
  const r = rig({ fsImpl: { readdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } });
  await r.service.refresh();
  await r.service.refresh();
  assert.strictEqual(r.service.state(), 'unreadable');
  assert.deepStrictEqual(r.service.current(), []);
  assert.strictEqual(r.logs.filter(l => /denied/.test(l)).length, 1);
});

test('a malformed file is skipped and logged once per file, never shown', async () => {
  const r = rig();
  r.writer.write(record());
  fs.writeFileSync(path.join(r.dir, 'bad.json'), 'nope');
  await r.service.refresh();
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current().map(c => c.agentId), ['ag1']);
  assert.strictEqual(r.logs.filter(l => /bad\.json/.test(l)).length, 1);
});

test('concurrent refreshes coalesce into one run plus at most one follow-up', async () => {
  const r = rig();
  r.writer.write(record());
  await Promise.all([r.service.refresh(), r.service.refresh(), r.service.refresh(), r.service.refresh()]);
  assert.ok(r.calls <= 2, `${r.calls} OS queries`);
  assert.deepStrictEqual(r.service.current().map(c => c.agentId), ['ag1']);
});

test('a throwing startTimes or onChange never rejects a refresh', async () => {
  const r = rig({ startTimes: async () => { throw new Error('ps died'); }, onChange: () => { throw new Error('ui'); } });
  r.writer.write(record());
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), []);
});

// --- watching and the timer ---------------------------------------------------------------------

test('start arms a watcher on the folder (creating it first, safely), and a file event refreshes', async () => {
  const r = rig();
  r.service.start();
  assert.strictEqual(r.watchers.length, 1);
  assert.strictEqual(r.watchers[0].d, r.dir);
  assert.strictEqual(r.watchers[0].opts.mkdirSync, r.service._ensureDir, 'the watcher creates the folder through ensureDir only');
  r.writer.write(record());
  r.watchers[0].cb();
  await new Promise(resolve => setImmediate(resolve));
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current().map(c => c.agentId), ['ag1']);
});

test('a timer re-checks liveness (a killed host writes no file event) and re-arms itself', async () => {
  const r = rig();
  r.writer.write(record());
  r.service.start();
  await r.service.refresh();
  assert.strictEqual(r.changes, 1);
  r.running = new Map();
  const tick = r.pending().find(t => t.ms === r.service._tickMs);
  assert.ok(tick, 'a tick is scheduled');
  await r.fire(tick);
  assert.deepStrictEqual(r.service.current(), []);
  assert.ok(r.pending().some(t => t.ms === r.service._tickMs), 'and the next tick is already set');
});

test('while claims are live the label is refreshed every 30 s even with no change', async () => {
  const r = rig();
  r.writer.write(record());
  await r.service.refresh();
  assert.strictEqual(r.changes, 1);
  r.clock += 29_000;
  await r.service.refresh();
  assert.strictEqual(r.changes, 1);
  r.clock += 1_000;
  await r.service.refresh();
  assert.strictEqual(r.changes, 2, 'the minutes shown are fresh again');
});

test('close stops the watcher and the timer, and a refresh after close announces nothing', async () => {
  const r = rig();
  r.service.start();
  r.service.close();
  assert.strictEqual(r.watchers[0].closed, true);
  assert.strictEqual(r.pending().length, 0);
  r.writer.write(record());
  await r.service.refresh();
  assert.strictEqual(r.changes, 0);
});

test('a platform that can\'t watch leaves the timer working', async () => {
  const r = rig({ watch: () => { throw new Error('no watch'); } });
  r.writer.write(record());
  r.service.start();
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current().map(c => c.agentId), ['ag1']);
  assert.ok(r.pending().length >= 1);
});

// --- Mortimer, release PR #101 gate (backlog #58): what the first suite never pinned. ------------------

const { signatureOf } = require('../host/occupancy-service');
const settle = async () => { for (let i = 0; i < 25; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const fields = c => [c.agentId, c.agent, c.worktree, c.also, c.fromBranch, c.fromRoot, c.hostPid, c.hostStartedAt, c.firstAt];
const { serializeClaim } = require('../host/agent-occupancy');

test('signatureOf: the same claims in any order give the same signature; equal ids keep their input order', () => {
  const mk = (agentId, hostPid) => record({ agentId, hostPid });
  const claims = [mk('a', 1), mk('a', 2), mk('b', 3), mk('b', 4), mk('c', 5)];
  const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p])));
  for (const p of permutations(claims)) {
    // The expected order is derived independently: ids ascending, and within one id the INPUT order.
    const expected = ['a', 'b', 'c'].flatMap(id => p.filter(c => c.agentId === id));
    assert.strictEqual(signatureOf(p), JSON.stringify(expected.map(fields)), p.map(c => `${c.agentId}${c.hostPid}`).join(','));
  }
});

test('signatureOf: ids sort ascending (a before b), and it never reorders the caller\'s array', () => {
  const input = [record({ agentId: 'b' }), record({ agentId: 'a' })];
  const snapshot = input.map(c => c.agentId);
  const sig = signatureOf(input);
  assert.deepStrictEqual(input.map(c => c.agentId), snapshot, 'the input array is untouched');
  assert.deepStrictEqual(JSON.parse(sig).map(row => row[0]), ['a', 'b']);
});

test('signatureOf: every field the signature names changes it, and lastAt / count do not', () => {
  const base = record({ also: ['x'] });
  const before = signatureOf([base]);
  const variants = {
    agentId: 'other', agent: 'someone-else', worktree: path.resolve('/occ-svc/elsewhere'), also: ['y'],
    fromBranch: 'main', fromRoot: path.resolve('/occ-svc/other-root'), hostPid: 9999, hostStartedAt: '2000', firstAt: 555,
  };
  for (const [field, value] of Object.entries(variants)) {
    assert.notStrictEqual(signatureOf([{ ...base, [field]: value }]), before, `${field} must change the signature`);
  }
  assert.strictEqual(signatureOf([{ ...base, lastAt: 1e9, count: 77 }]), before, 'lastAt and count only feed a label');
  assert.strictEqual(signatureOf([]), '[]');
});

test('a claim that differs in exactly one field, count held constant, announces a change', async () => {
  for (const [field, value] of Object.entries({
    agent: 'other-agent', worktree: path.resolve('/occ-svc/feat-y'), also: [path.resolve('/occ-svc/also-z')], fromBranch: 'main',
    fromRoot: path.resolve('/occ-svc/root-2'), firstAt: 777,
  })) {
    const r = rig();
    r.writer.write(record());
    await r.service.refresh();
    assert.strictEqual(r.changes, 1);
    fs.writeFileSync(path.join(r.dir, 'ag1.json'), serializeClaim(record({ [field]: value })));
    await r.service.refresh();
    assert.strictEqual(r.changes, 2, `${field} changed, so the owner must be told`);
  }
});

test('the same two claims read again are not a change', async () => {
  const r = rig({ startTimes: async (pids) => new Map(pids.map(p => [p, '1000'])) });
  r.writer.write(record({ agentId: 'ag1', hostPid: 1 }));
  r.writer.write(record({ agentId: 'ag2', hostPid: 2 }));
  await r.service.refresh();
  assert.strictEqual(r.changes, 1);
  r.clock += 1;
  await r.service.refresh();
  assert.strictEqual(r.changes, 1);
});

test('before any read: no claims and the folder is "missing"', () => {
  const r = rig();
  assert.deepStrictEqual(r.service.current(), []);
  assert.strictEqual(r.service.state(), 'missing');
});

test('current() hands out a copy: changing it never changes what the service knows', async () => {
  const r = rig();
  r.writer.write(record());
  await r.service.refresh();
  const got = r.service.current();
  got.length = 0;
  got.push({ agentId: 'forged' });
  assert.deepStrictEqual(r.service.current().map(c => c.agentId), ['ag1']);
});

test('a readable folder logs nothing at all', async () => {
  const r = rig();
  r.writer.write(record());
  await r.service.refresh();
  assert.deepStrictEqual(r.logs, []);
});

test('an unreadable folder is logged with the reason, and a DIFFERENT reason is logged again', async () => {
  let reason = 'denied';
  const r = rig({ fsImpl: { readdirSync: () => { throw Object.assign(new Error(reason), { code: 'EACCES' }); } } });
  await r.service.refresh();
  await r.service.refresh();
  reason = 'busy';
  await r.service.refresh();
  assert.strictEqual(r.logs.length, 2, 'once per distinct reason');
  assert.ok(/^\[occupancy\] the claim folder can't be read; showing none: .*denied/.test(r.logs[0]), r.logs[0]);
  assert.ok(/^\[occupancy\] the claim folder can't be read; showing none: .*busy/.test(r.logs[1]), r.logs[1]);
});

test('two different malformed files are each logged once, with their file name', async () => {
  const r = rig();
  fs.mkdirSync(r.dir, { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'bad1.json'), 'nope');
  fs.writeFileSync(path.join(r.dir, 'bad2.json'), '{also nope');
  await r.service.refresh();
  await r.service.refresh();
  assert.strictEqual(r.logs.length, 2);
  assert.ok(r.logs.some(l => /^\[occupancy\] skipped bad1\.json: /.test(l)), r.logs.join('|'));
  assert.ok(r.logs.some(l => /^\[occupancy\] skipped bad2\.json: /.test(l)), r.logs.join('|'));
});

test('a claim proven live, then judged dead, does not come back when the OS can no longer be asked', async () => {
  const r = rig();
  r.writer.write(record());
  await r.service.refresh();
  assert.strictEqual(r.service.current().length, 1);
  r.running = new Map();
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), []);
  r.running = null;
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), [], 'a dead verdict forgets the proof');
});

test('a claim whose file vanished forgets its proof: the same claim written again is not proven by the old one', async () => {
  const r = rig();
  r.writer.write(record());
  await r.service.refresh();
  assert.strictEqual(r.service.current().length, 1);
  r.writer.remove('ag1');
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), []);
  r.writer.write(record());
  r.running = null;
  await r.service.refresh();
  assert.deepStrictEqual(r.service.current(), [], 'the same claim again was never re-proven');
});

test('a throwing onChange is logged with its message, and the next refresh still runs and announces', async () => {
  let n = 0;
  const r = rig({ onChange: () => { n += 1; throw new Error('ui exploded'); } });
  r.writer.write(record());
  await r.service.refresh();
  loggedOnce(r.logs, 'onChange', 'ui exploded');
  r.running = new Map();
  await r.service.refresh();
  assert.strictEqual(n, 2, 'the second change is still announced');
});

test('an onChange that throws something with no message is logged without crashing the refresh', async () => {
  const r = rig({ onChange: () => { throw null; } }); // eslint-disable-line no-throw-literal
  r.writer.write(record());
  await r.service.refresh();
  loggedOnce(r.logs, 'onChange', '');
  assert.strictEqual(r.service.current().length, 1);
});

test('a pass that throws is logged and the refresh still resolves; a non-Error throw is tolerated too', async () => {
  const r = rig({ now: () => { throw new Error('clock gone'); } });
  r.writer.write(record());
  await r.service.refresh();
  loggedOnce(r.logs, 'refresh', 'clock gone');
  const r2 = rig({ now: () => { throw null; } }); // eslint-disable-line no-throw-literal
  r2.writer.write(record());
  await r2.service.refresh();
  loggedOnce(r2.logs, 'refresh', '');
});

test('a refresh asked for while one runs schedules exactly one more pass, however many were asked', async () => {
  let queries = 0;
  const gates = [];
  const r = rig({
    startTimes: (pids) => {
      queries += 1;
      return new Promise(resolve => gates.push(() => resolve(new Map(pids.map(p => [p, '1000'])))));
    },
  });
  r.writer.write(record());
  const first = r.service.refresh();
  await settle();
  assert.strictEqual(queries, 1);
  const second = r.service.refresh();
  const third = r.service.refresh();
  assert.strictEqual(second, first, 'the running refresh is what a late caller gets back');
  assert.strictEqual(third, first);
  gates[0]();
  await settle();
  assert.strictEqual(queries, 2, 'one follow-up pass for the whole burst');
  gates[1]();
  await first;
  await settle();
  assert.strictEqual(queries, 2, 'and no third');
  const next = r.service.refresh();
  await settle();
  assert.strictEqual(queries, 3, 'once idle, a new request starts a fresh run');
  gates[2]();
  await next;
});

test('a closed service never starts, never arms a timer, and an armed timer firing late arms nothing', async () => {
  const r = rig();
  r.writer.write(record());
  r.service.close();
  r.service.start();
  await settle();
  assert.strictEqual(r.watchers.length, 0, 'no watcher after close');
  assert.strictEqual(r.timers.length, 0, 'no timer after close');
  assert.strictEqual(r.calls, 0, 'no read after close');

  const r2 = rig();
  r2.service.start();
  const tick = r2.pending()[0];
  r2.service.close();
  await tick.fn();
  assert.strictEqual(r2.pending().length, 0, 'a tick that fires after close does not re-arm');
});

test('start reads once straight away, with no event and no tick needed, and arms one tick of tickMs', async () => {
  const r = rig();
  r.writer.write(record());
  r.service.start();
  await settle();
  assert.deepStrictEqual(r.service.current().map(c => c.agentId), ['ag1'], 'the initial read ran');
  assert.strictEqual(r.pending().length, 1);
  assert.strictEqual(r.pending()[0].ms, r.service._tickMs);
});

test('a file event refreshes by itself (nothing else asks), and the watcher is handed the log and its label', async () => {
  const r = rig();
  r.service.start();
  await settle();
  assert.deepStrictEqual(r.service.current(), []);
  r.writer.write(record());
  r.watchers[0].cb();
  await settle();
  assert.deepStrictEqual(r.service.current().map(c => c.agentId), ['ag1']);
  assert.strictEqual(r.watchers[0].opts.what, 'worktree occupancy');
  r.watchers[0].opts.log('probe');
  assert.deepStrictEqual(r.logs.slice(-1), ['probe'], 'the watcher logs through the service\'s log');
});

test('a watch that throws is logged with its reason (an Error or not), and the timer still runs', async () => {
  const r = rig({ watch: () => { throw new Error('no watch'); } });
  r.service.start();
  await settle();
  loggedOnce(r.logs, 'watch', 'no watch');
  assert.strictEqual(r.pending().length, 1);
  const r2 = rig({ watch: () => { throw null; } }); // eslint-disable-line no-throw-literal
  r2.service.start();
  await settle();
  loggedOnce(r2.logs, 'watch', '');
});

test('close clears the armed timer through clearTimer exactly once, and closes the watcher', async () => {
  const cleared = [];
  const r = rig({ clearTimer: (t) => { cleared.push(t); t.live = false; } });
  r.service.start();
  const armed = r.pending()[0];
  r.service.close();
  r.service.close();
  assert.deepStrictEqual(cleared, [armed]);
  assert.strictEqual(r.watchers[0].closed, true);
});

test('close with nothing armed does not call clearTimer', () => {
  const cleared = [];
  const r = rig({ clearTimer: (t) => cleared.push(t) });
  r.service.close();
  assert.deepStrictEqual(cleared, []);
});

test('close survives a watcher that throws on close, or has no close at all', () => {
  const r = rig({ watch: () => ({ close() { throw new Error('already closed'); } }) });
  r.service.start();
  assert.doesNotThrow(() => r.service.close());
  const r2 = rig({ watch: () => ({}) });
  r2.service.start();
  assert.doesNotThrow(() => r2.service.close());
});

test('the default timer is a real setTimeout of tickMs that is unref\'d so it never holds the process open', () => {
  const realSet = global.setTimeout;
  const made = [];
  global.setTimeout = (fn, ms) => { const t = { fn, ms, unrefs: 0, unref() { this.unrefs += 1; } }; made.push(t); return t; };
  const cleared = [];
  try {
    const service = createOccupancyService({
      dir: S.occupancyDir(tmpDir('occ-svc-default-')), startTimes: async () => new Map(), watch: () => ({ close() {} }),
      clearTimer: (t) => cleared.push(t), tickMs: 1234, log: () => {},
    });
    service.start();
    assert.strictEqual(made.length, 1);
    assert.strictEqual(made[0].ms, 1234);
    assert.strictEqual(made[0].unrefs, 1, 'unref\'d exactly once');
    service.close();
    assert.deepStrictEqual(cleared, [made[0]], 'the very timer the default made is what close clears');
  } finally {
    global.setTimeout = realSet;
  }
});

test('the default timer copes with a timer handle that has no unref, or no handle at all', () => {
  const realSet = global.setTimeout;
  try {
    for (const handle of [{}, null, undefined]) {
      global.setTimeout = () => handle;
      const service = createOccupancyService({
        dir: S.occupancyDir(tmpDir('occ-svc-default-')), startTimes: async () => new Map(), watch: () => ({ close() {} }),
        clearTimer: () => {}, log: () => {},
      });
      assert.doesNotThrow(() => service.start(), String(handle));
      service.close();
    }
  } finally {
    global.setTimeout = realSet;
  }
});
