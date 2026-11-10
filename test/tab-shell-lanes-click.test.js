'use strict';
/**
 * BACKLOG #140 (2026-11-07 sighting): "clicked lane to open a working tree and it doesn't open any terminal nor claude
 * session" from the Lanes menu. A click on a Lanes row is `select(key)` (what main.js's menu click calls); whatever its row
 * says (Not started, Ended), it must leave the lane with a presented page and a running host. Each case below is one way
 * a lane gets into the menu.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createShell } = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-lanes-click');
const wt = (name) => path.join(ROOT, name);
const key = (name) => normPath(wt(name));
const porcelain = (entries) => entries.map(([name, branch]) =>
  `worktree ${wt(name).replace(/\\/g, '/')}\nHEAD 0123456789012345678901234567890123456789\nbranch refs/heads/${branch}\n`).join('\n') + '\n';
const settle = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 8; i++) await settle(); };

function harness({ safety } = {}) {
  const h = { running: {}, spawns: [], created: [], destroyed: [], removed: [], markers: {}, holds: [], hold: false, holdRemove: false, clock: 1_000_000_000 };
  const tokenOf = (port) => (h.running[port] === undefined ? null : `tok-${port}`);
  const deps = {
    mode: 'tabs', container: ROOT, cwd: wt('dev'), launchedFrom: null, log: () => {},
    git: { list: async () => { await settle(); return porcelain([['dev', 'develop'], ['feat-a', 'feat/a'], ['feat-b', 'feat/b']]); }, marker: (p, branch) => (h.markers[normPath(p)] === branch ? { branch, pr: 1, mergedAt: '2026-10-29T00:00:00Z' } : null) },
    ops: { available: () => ({ create: false, setup: false, remove: true }), create: async () => ({ ok: false, error: 'no' }), setup: async () => ({ ok: false, error: 'no' }),
      remove: async (a) => { h.removed.push(normPath(a.path)); if (h.holdRemove) await new Promise(() => {}); return { ok: true }; } },
    hosts: {
      choosePort: async (tab) => {
        for (let p = 7800; p < 7850; p++) { if (h.running[p] !== undefined && normPath(h.running[p]) === tab.key) return { port: p, action: 'attach' }; }
        for (let p = 7800; p < 7850; p++) if (h.running[p] === undefined) return { port: p, action: 'spawn' };
        return null;
      },
      // The answer is fixed when the port is asked; with h.hold on it is handed back only when the test releases it (h.holds[i].release()).
      probe: async (port) => {
        const answer = h.probeThrows ? null : (h.probeAnswer || (h.running[port] !== undefined ? 'listening' : 'refused'));
        if (answer === null) throw new Error('probe broke');
        if (!h.hold) return answer;
        return new Promise((resolve) => { h.holds.push({ port, answer, release: (a) => resolve(a === undefined ? answer : a) }); });
      },
      spawn: ({ tab, port }) => { h.spawns.push(tab.key); h.running[port] = tab.cwd; },
      wait: async () => true, tokenFor: tokenOf, tokenFile: tokenOf, newToken: () => 'fresh',
      control: async () => ({ ok: true, reply: null }), identity: () => null, readToken: () => null,
    },
    views: { create: (tab) => { h.created.push(tab.key); return { tab: tab.key }; }, destroy: (t) => { h.destroyed.push(t.key); }, send: () => {}, owns: (tab, s) => tab.view === s },
    ui: { confirmClose: async () => true, changed: () => {}, focusWindow: () => {}, isFocused: () => true },
    now: () => h.clock,
  };
  if (safety) deps.safety = safety;
  h.shell = createShell(deps);
  h.endSession = (name) => { for (const [p, cwd] of Object.entries(h.running)) if (normPath(cwd) === key(name)) delete h.running[p]; };
  h.live = (name) => Object.values(h.running).some(cwd => normPath(cwd) === key(name));
  h.record = (name) => h.shell.snapshot().model.find(e => e.key === key(name));
  return h;
}

async function opened(opts) { const h = harness(opts); await h.shell.open(); await flush(); return h; }

// A lane that "has a session" is: its tab started, not ended, a view presented, and a host answering for its folder.
const hasSession = (h, name) => { const e = h.record(name); return !!e && e.started === true && e.ended !== true && h.created.includes(key(name)) && h.live(name); };

test('#140: a click on a Not started row gives the lane a page and a running host', async () => {
  const h = await opened();
  await h.shell.select(key('feat-a'));
  await flush();
  assert.ok(hasSession(h, 'feat-a'));
});

test('#140: a click on an Ended row (the session ended, a poll saw it, the person looked away) starts a new session', async () => {
  const h = await opened();
  await h.shell.select(key('feat-a')); await flush();
  h.endSession('feat-a'); await h.shell.poll();
  await h.shell.select(key('dev')); await flush();
  assert.strictEqual(h.shell.snapshot().lanes.notStarted.find(r => r.key === key('feat-a')).state, 'ended');
  const spawnsBefore = h.spawns.length;
  await h.shell.select(key('feat-a')); await flush();
  assert.ok(h.spawns.length > spawnsBefore, 'a new host was spawned');
  assert.ok(hasSession(h, 'feat-a'));
});

test('#140: the same click, when the session ended and no poll has seen it yet', async () => {
  const h = await opened();
  await h.shell.select(key('feat-a')); await flush();
  await h.shell.select(key('dev')); await flush();
  h.endSession('feat-a');                      // claude exited; the 3 s poll has not run
  const spawnsBefore = h.spawns.length;
  await h.shell.select(key('feat-a')); await flush();
  assert.ok(h.spawns.length > spawnsBefore, 'a new host was spawned, not the dead page shown');
  assert.ok(hasSession(h, 'feat-a'));
});

test('#140: the same click on the selected tab itself, ended and not yet polled', async () => {
  const h = await opened();
  await h.shell.select(key('feat-a')); await flush();
  h.endSession('feat-a');
  const spawnsBefore = h.spawns.length;
  await h.shell.select(key('feat-a')); await flush();
  assert.ok(h.spawns.length > spawnsBefore);
  assert.ok(hasSession(h, 'feat-a'));
});

// --- what the click must NOT do (PR #251 Miguel Y2) ---------------------------------------------------------------------

const quiet = (h) => ({ spawns: h.spawns.length, created: h.created.length, destroyed: h.destroyed.length });

test('#140: a click on a tab whose host is listening starts nothing and destroys nothing', async () => {
  const h = await opened();
  await h.shell.select(key('feat-a')); await flush();
  const before = quiet(h);
  await h.shell.select(key('feat-a')); await flush();
  assert.deepStrictEqual(quiet(h), before);
  assert.ok(hasSession(h, 'feat-a'));
});

test('#140: an unknown answer from the probe is not proof: the click starts nothing', async () => {
  const h = await opened();
  await h.shell.select(key('feat-a')); await flush();
  h.endSession('feat-a'); h.probeAnswer = 'unknown';
  const before = quiet(h);
  await h.shell.select(key('feat-a')); await flush();
  assert.deepStrictEqual(quiet(h), before);
  assert.notStrictEqual(h.record('feat-a').ended, true);
});

test('#140: a probe that throws is not proof either', async () => {
  const h = await opened();
  await h.shell.select(key('feat-a')); await flush();
  h.endSession('feat-a'); h.probeThrows = true;
  const before = quiet(h);
  await h.shell.select(key('feat-a')); await flush();
  assert.deepStrictEqual(quiet(h), before);
});

test('#140: the person looked at another tab while the port was asked: nothing is restarted behind them', async () => {
  const h = await opened();
  await h.shell.select(key('feat-a')); await flush();
  h.endSession('feat-a'); h.hold = true;
  const click = h.shell.select(key('feat-a')); await flush();
  h.hold = false;
  await h.shell.select(key('dev')); await flush();
  const before = quiet(h);
  for (const x of h.holds) x.release();
  await click; await flush();
  assert.deepStrictEqual(quiet(h), before);
});

// --- a lane the merged close or the remover owns is the poll's (PR #251 Dexter 1) ----------------------------------------

async function mergedAndSeen(opts) {
  const h = await opened(opts);
  await h.shell.select(key('feat-a')); await flush();
  await h.shell.select(key('dev')); await flush();
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll(); await flush();                  // the poll reads the marker with the host listening: finishing, hostSeen
  return h;
}

test('#140 (Dexter 1): a merged lane whose host just stopped, clicked before the next poll, still goes to removal', async () => {
  const h = await mergedAndSeen();
  assert.strictEqual(h.record('feat-a').phase, 'finishing', 'set-up: the lane is finishing');
  h.endSession('feat-a');                               // its host stopped (the merged close's stop, or /exit)
  const before = quiet(h);
  await h.shell.select(key('feat-a')); await flush();   // the click, before the next poll
  assert.deepStrictEqual(quiet(h), before, 'the click restarted nothing');
  await h.shell.poll(); await flush();                  // the poll sees the refusal
  assert.ok(h.removed.includes(key('feat-a')), "the folder's removal started");
});

test('#140 (Dexter 1): a lane being removed is not restarted by a click', async () => {
  const h = await mergedAndSeen();
  h.holdRemove = true;
  h.endSession('feat-a');
  await h.shell.poll(); await flush();                  // finishing -> removing, the remover hangs
  assert.strictEqual(h.record('feat-a').phase, 'removing', 'set-up: the lane is removing');
  const before = quiet(h);
  await h.shell.select(key('feat-a')); await flush();
  assert.deepStrictEqual(quiet(h), before);
});

test('#140 (Dexter 1): a tab whose reader holds unsaved edits is left to the poll, not restarted by a click', async () => {
  const h = await opened({ safety: { readerUnsaved: () => 'notes.md' } });
  await h.shell.select(key('feat-a')); await flush();
  h.endSession('feat-a');
  const before = quiet(h);
  await h.shell.select(key('feat-a')); await flush();
  assert.deepStrictEqual(quiet(h), before);
  assert.notStrictEqual(h.record('feat-a').ended, true, 'the click did not consume the refusal');
});

// --- the click and an in-flight poll (PR #251 Dexter 2) ----------------------------------------------------------------

test("#140 (Dexter 2 A): the poll marks the tab ended while the click's probe is out: the click still restarts it", async () => {
  const h = await opened();
  await h.shell.select(key('feat-a')); await flush();
  h.endSession('feat-a'); h.hold = true;
  const polled = h.shell.poll();
  for (let i = 0; i < 30 && h.holds.length === 0; i++) await settle();
  await flush();
  const pollHolds = h.holds.splice(0);
  const click = h.shell.select(key('feat-a')); await flush();
  const clickHolds = h.holds.splice(0);
  assert.ok(pollHolds.length > 0 && clickHolds.length === 1, 'set-up: both probes are out');
  h.hold = false;
  for (const x of pollHolds) x.release();               // the poll's answers land first: ended
  await polled; await flush();
  const spawnsBefore = h.spawns.length;
  for (const x of clickHolds) x.release();
  await click; await flush();
  assert.ok(h.spawns.length > spawnsBefore, 'a new host was spawned for the click');
  assert.ok(hasSession(h, 'feat-a'));
});

test("#140 (Dexter 2 B): a poll's stale refusal does not mark the restarted session ended", async () => {
  const h = await opened();
  await h.shell.select(key('feat-a')); await flush();
  h.endSession('feat-a'); h.hold = true;
  const polled = h.shell.poll();
  for (let i = 0; i < 30 && h.holds.length === 0; i++) await settle();
  await flush();
  const pollHolds = h.holds.splice(0);
  const click = h.shell.select(key('feat-a')); await flush();
  const clickHolds = h.holds.splice(0);
  h.hold = false;
  for (const x of clickHolds) x.release();              // the click's answer lands first: restarted
  await click; await flush();
  assert.ok(hasSession(h, 'feat-a'), 'set-up: the new session runs');
  for (const x of pollHolds) x.release();               // now the poll's old answer about the previous host
  await polled; await flush();
  assert.notStrictEqual(h.record('feat-a').ended, true, 'the new session is not marked ended');
  assert.ok(hasSession(h, 'feat-a'));
});
