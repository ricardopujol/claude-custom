'use strict';
/**
 * host/occupancy-service.js: what every window knows about worktree occupancy (backlog #44 + #47). It reads
 * the claim folder, keeps only the claims whose launching host is PROVEN alive, and says when that set
 * changed. A killed host writes no file event, so a timer re-checks.
 */
const test = require('node:test');
const assert = require('node:assert');
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
