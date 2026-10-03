'use strict';
/**
 * The tab shell's decisions, with every effect faked (app/tab-shell.js).
 *
 * The properties that cost something get a PROPERTY test: spawns are
 * serialised, `listening` is false only for a started tab whose port REFUSED
 * (never a timeout, never a starting or unstarted tab), and a poll that lists
 * no dev keeps every tab.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fc = require('fast-check');

const {
  createShell, createQueue, captureListening, observeWorktrees, sanitizeStatus,
  handleProbeCommand, noWindowText, shortcutFor, shortcutWillAct, focusStep, probeLineReader, menuText,
} = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');
const tabModel = require('../app/tab-model');

// For the createShell calls that don't exercise PR 3: no scripts, no markers.
const NO_OPS = {
  available: () => ({ create: false, setup: false, remove: false }),
  create: async () => ({ ok: false, error: 'no' }), setup: async () => ({ ok: false, error: 'no' }),
  remove: async () => ({ ok: false, error: 'no' }),
};
const noMarker = () => null;

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-proj');
const wt = (name) => path.join(ROOT, name);
const key = (name) => normPath(wt(name));

const porcelain = (entries) => entries.map(([name, branch]) =>
  `worktree ${wt(name).replace(/\\/g, '/')}\nHEAD 0123456789012345678901234567890123456789\n` +
  (branch ? `branch refs/heads/${branch}\n` : 'detached\n')).join('\n') + '\n';

const THREE = [['dev', 'develop'], ['feat-a', 'feat/a'], ['feat-b', 'feat/b']];

/** A shell whose every effect is a recording fake. */
function harness({ mode = 'tabs', list = porcelain(THREE), running = {}, launchedFrom = null, focused = true, spawnFails = false, marks } = {}) {
  const h = {
    listText: list, listFails: false, running: { ...running },   // port -> cwd of a live host
    spawns: [], controls: [], viewsMade: [], viewsGone: [], sent: [], changes: [], focusCalls: 0,
    confirm: true, resolveCalls: [], tokens: 0, failWait: false, spawnRegisters: true, gitInFlight: 0, gitMax: 0,
    // port -> the token file the host that BOUND that port wrote (host.js writes
    // it only on 'listening', PR #75 F2). Unset: a pre-existing host, `tok-<port>`.
    tokenFiles: {},
    onSpawn: null,      // (spawn) => void, runs before a registering spawn binds
    hold: null,         // a promise every choosePort waits on while set
    // PR 3: normPath -> the branch /merged marked; the contract scripts' fakes.
    markers: {}, markerReads: [], opsCalls: [], probeOverride: null,
    available: { create: true, setup: true, remove: true },
    createResult: null, setupHold: null, setupResult: { ok: true, result: null }, onLine: null,
    removeResult: { ok: true, already: false },
    focused,            // the window's OS focus; a test flips it
    slept: [],          // the spaced waits runMerged asked for
  };
  // A worktree appears in git's list (what new-worktree.ps1 does).
  h.addWorktree = (name, branch) => { h.listText += '\n' + porcelain([[name, branch]]); };
  const base = 7700;
  const fileToken = (port) => (h.running[port] === undefined ? null
    : (h.tokenFiles[port] !== undefined ? h.tokenFiles[port] : `tok-${port}`));
  const deps = {
    mode, container: ROOT, cwd: wt('dev'), launchedFrom,
    log: () => {},
    git: {
      list: async () => {
        h.gitInFlight++; h.gitMax = Math.max(h.gitMax, h.gitInFlight);
        await settle();
        h.gitInFlight--;
        if (h.listFails) throw new Error('git broke');
        return h.listText;
      },
      marker: (p, branch) => {
        h.markerReads.push([normPath(p), branch]);
        return h.markers[normPath(p)] === branch ? { branch, pr: 1, mergedAt: '2026-09-30T00:00:00Z' } : null;
      },
    },
    ops: {
      available: () => ({ ...h.available }),
      create: async ({ branch }) => {
        h.opsCalls.push(['create', branch]);
        await settle();
        if (h.createResult) return h.createResult(branch);
        const dir = branch.replace(/\//g, '-');
        h.addWorktree(dir, branch);
        return { ok: true, path: wt(dir), branch, warning: null };
      },
      setup: async ({ path: p, onLine }) => {
        h.opsCalls.push(['setup', normPath(p)]);
        h.onLine = onLine;
        if (h.setupHold) await h.setupHold;
        return h.setupResult;
      },
      remove: async ({ path: p }) => {
        h.opsCalls.push(['remove', normPath(p)]);
        await settle();
        return typeof h.removeResult === 'function' ? h.removeResult(p) : h.removeResult;
      },
    },
    hosts: {
      choosePort: async (tab) => {
        h.resolveCalls.push(tab.key);
        if (h.hold) await h.hold;
        // resolvePort's walk since PR #75 F1: a host of ours ANYWHERE in the
        // range beats the first free port.
        let free = null;
        for (let p = base; p < base + 50; p++) {
          const occ = h.running[p];
          if (occ === undefined) { if (free === null) free = p; continue; }
          if (normPath(occ) === tab.key) return { port: p, action: 'attach' };
        }
        return free === null ? null : { port: free, action: 'spawn' };
      },
      probe: async (port) => (h.probeOverride ? h.probeOverride(port)
        : (h.running[port] !== undefined ? 'listening' : 'refused')),
      spawn: ({ tab, port, token }) => {
        if (spawnFails) throw new Error('spawn exploded');
        h.spawns.push({ key: tab.key, port, token });
        if (h.onSpawn) h.onSpawn({ key: tab.key, port, token });
        // A registering spawn binds -- unless something else bound the port first.
        if (h.spawnRegisters && h.running[port] === undefined) {
          h.running[port] = tab.cwd;
          h.tokenFiles[port] = token;
        }
      },
      wait: async () => !h.failWait,
      tokenFor: fileToken,
      tokenFile: fileToken,
      newToken: () => `fresh-${++h.tokens}`,
      control: async (c) => { h.controls.push(c); return h.controlReply ? h.controlReply(c) : { ok: true, reply: null }; },
      identity: () => null,
      readToken: () => null,
    },
    views: {
      create: (tab) => { const v = { tab: tab.key, id: h.viewsMade.length }; h.viewsMade.push(v); return v; },
      destroy: (tab) => h.viewsGone.push(tab.key),
      send: (tab, channel, payload) => h.sent.push([tab.key, channel, payload]),
      owns: (tab, sender) => tab.view === sender,
    },
    ui: {
      confirmClose: async () => h.confirm,
      changed: (snap) => h.changes.push(snap),
      focusWindow: () => { h.focusCalls++; },
      isFocused: () => h.focused,
    },
  };
  deps.sleep = async (ms) => { h.slept.push(ms); };
  if (marks !== undefined) deps.marks = marks;
  h.shell = createShell(deps);
  return h;
}

const labels = (h) => h.shell.model().map(e => e.label);
const settle = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await settle(); };

// --- pure helpers ------------------------------------------------------------

test('createQueue runs in order, one at a time, and survives a failure', async () => {
  const q = createQueue();
  const order = [];
  let running = 0;
  let maxRunning = 0;
  const job = (name, ms, fail) => q.run(async () => {
    running++; maxRunning = Math.max(maxRunning, running);
    await new Promise(r => setTimeout(r, ms));
    order.push(name); running--;
    if (fail) throw new Error(name);
  });
  const results = await Promise.allSettled([job('a', 15), job('b', 1, true), job('c', 5)]);
  assert.deepStrictEqual(order, ['a', 'b', 'c']);
  assert.strictEqual(maxRunning, 1);
  assert.deepStrictEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('captureListening: true when it answers, false ONLY when a started tab port refused; else left OUT', async () => {
  const tabs = [
    { key: 'a', started: true, starting: false, port: 1 },        // answers
    { key: 'b', started: true, starting: false, port: 2 },        // refused: its session ended
    { key: 'c', started: false, starting: true, port: null },     // starting
    { key: 'd', started: false, starting: false, port: null },    // never started
    { key: 'e', started: true, starting: true, port: 5 },         // mid-restart: unknown
    { key: 'f', started: true, starting: false, port: 6 },        // probe throws
    { key: 'g', started: true, starting: false, port: 7 },        // timed out: busy, NOT gone
    { key: 'h', started: false, starting: false, port: 8 },       // refused, but this window never started it
  ];
  const answer = { 1: 'listening', 2: 'refused', 5: 'refused', 7: 'unknown', 8: 'refused' };
  const out = await captureListening(tabs, async (p) => {
    if (p === 6) throw new Error('boom');
    return answer[p];
  });
  assert.deepStrictEqual(out, { a: true, b: false });
});

test('observeWorktrees: no text is NO observation; markers are read with the branch of THIS poll, never for dev', () => {
  assert.strictEqual(observeWorktrees(null, ROOT, noMarker), null);
  assert.strictEqual(observeWorktrees(undefined, ROOT, noMarker), null);
  const reads = [];
  const o = observeWorktrees(porcelain(THREE), ROOT, (p, b) => {
    reads.push([normPath(p), b]);
    if (b === 'feat/b') throw new Error('unreadable');      // a throw is "not merged"
    return b === 'feat/a' ? { branch: b } : null;
  });
  assert.deepStrictEqual(o.merged, { [key('feat-a')]: true });
  assert.deepStrictEqual(reads, [[key('feat-a'), 'feat/a'], [key('feat-b'), 'feat/b']]);
  assert.deepStrictEqual(o.worktrees.map(w => [w.isDev, w.branch]), [[true, 'develop'], [false, 'feat/a'], [false, 'feat/b']]);
  assert.deepStrictEqual(observeWorktrees(porcelain([...THREE, ['feat-c', null]]), ROOT, () => ({})).merged,
    { [key('feat-a')]: true, [key('feat-b')]: true }, 'a detached worktree has no branch to read a marker for');
  assert.deepStrictEqual(observeWorktrees('', ROOT, noMarker).merged, {});
});

test('sanitizeStatus keeps five fields and never invents a value', () => {
  assert.deepStrictEqual(sanitizeStatus(null), { working: false, needsInput: false, finished: false, lock: null, health: null });
  assert.deepStrictEqual(
    sanitizeStatus({ working: 'yes', needsInput: 1, finished: 'true', lock: '', health: '', extra: 1 }),
    { working: false, needsInput: false, finished: false, lock: null, health: null });
  assert.deepStrictEqual(
    sanitizeStatus({ working: true, needsInput: true, finished: true, lock: 'blocked', health: '↓3' }),
    { working: true, needsInput: true, finished: true, lock: 'blocked', health: '↓3' });
});

// --- open: criterion 1, X5, criterion 8 --------------------------------------

test('open lists three tabs, dev first, and starts ONLY dev (criterion 1, X5)', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  const m = h.shell.model();
  assert.deepStrictEqual(m.map(e => e.started), [true, false, false]);
  assert.deepStrictEqual(m.map(e => e.selected), [true, false, false]);
  assert.strictEqual(h.spawns.length, 1);
  assert.strictEqual(h.spawns[0].key, key('dev'));
  assert.strictEqual(h.viewsMade.length, 1);
});

test('a session that is already running is attached at open, with a view and no spawn (criterion 8)', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  assert.strictEqual(h.spawns.length, 0);
  assert.deepStrictEqual(h.shell.model().map(e => e.started), [true, true, false]);
  assert.deepStrictEqual(h.viewsMade.map(v => v.tab).sort(), [key('dev'), key('feat-a')].sort());
});

test('the token of an attached host is the RUNNING host\'s, not a fresh one', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  assert.strictEqual(h.shell.tabByKey(key('dev')).token, 'tok-7700');
  assert.strictEqual(h.tokens, 0);
});

test('selecting an unstarted tab starts it, and the port is chosen AT THAT MOMENT', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  const before = h.resolveCalls.filter(k => k === key('feat-a')).length;
  assert.strictEqual(before, 1, 'one probe at open, to see whether a session is running');
  await h.shell.select(key('feat-a'));
  assert.strictEqual(h.resolveCalls.filter(k => k === key('feat-a')).length, 2, 'asked again when it started');
  assert.strictEqual(h.spawns.length, 2);
  assert.ok(h.shell.model().find(e => e.label === 'feat/a').started);
  assert.ok(h.sent.some(([k, ch]) => k === key('feat-a') && ch === 'tab-selected') === false,
    'a view that did not exist yet is not messaged');
});

test('a start that fails shows the reason, leaves the other tabs alone, and Retry (select) starts it', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  h.failWait = true;
  await h.shell.select(key('feat-b'));
  const tab = h.shell.tabByKey(key('feat-b'));
  assert.strictEqual(tab.started, false);
  assert.match(tab.error, /did not come up on port \d+ in time/);
  assert.strictEqual(h.shell.model().find(e => e.label === 'feat/b').startError, tab.error);
  assert.strictEqual(h.shell.model().find(e => e.label === 'develop').started, true, 'dev unaffected');
  h.failWait = false;
  await h.shell.select(key('feat-b'));
  assert.strictEqual(tab.started, true);
  assert.strictEqual(tab.error, null);
});

test('no free port for a folder is a tab error too', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  for (let p = 7700; p < 7750; p++) if (h.running[p] === undefined) h.running[p] = path.join(os.tmpdir(), 'stranger' + p);
  await h.shell.select(key('feat-b'));
  assert.match(h.shell.tabByKey(key('feat-b')).error, /no usable port/);
});

test('a spawn that throws is a tab error, not a crashed shell', async () => {
  const h = harness({ spawnFails: true });
  await h.shell.open();
  await flush();
  const dev = h.shell.tabByKey(key('dev'));
  assert.strictEqual(dev.started, false);
  assert.match(dev.error, /spawn exploded/);
  assert.strictEqual(dev.starting, false);
});

test('single mode reports a host that never comes up on the tab it returns', async () => {
  const h = harness({ mode: 'single' });
  h.failWait = true;
  const tab = await h.shell.open();
  assert.strictEqual(tab.started, false);
  assert.match(tab.error, /did not come up on port 7700/);
});

test('single mode: one tab on the given folder, started at once, never closable, never polled', async () => {
  const h = harness({ mode: 'single' });
  const tab = await h.shell.open();
  assert.strictEqual(tab.cwd, wt('dev'));
  assert.strictEqual(tab.started, true);
  const m = h.shell.model();
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].closable, false);
  assert.strictEqual(h.shell.tabmodeOf(tab), 'single');
  h.listText = porcelain(THREE);
  await h.shell.poll();
  assert.strictEqual(h.shell.model().length, 1, 'a single-tab window ignores worktrees');
  assert.strictEqual((await h.shell.closeTab(tab.key)).ok, false);
});

test('tabmodeOf: dev is dev, a worktree is a tab', async () => {
  const h = harness();
  await h.shell.open();
  assert.strictEqual(h.shell.tabmodeOf(h.shell.tabByKey(key('dev'))), 'dev');
  assert.strictEqual(h.shell.tabmodeOf(h.shell.tabByKey(key('feat-a'))), 'tab');
});

test('launching from a sibling selects THAT tab (criterion 8 / launcher)', async () => {
  const h = harness({ launchedFrom: path.join(wt('feat-b'), 'src') });
  await h.shell.open();
  await flush();
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-b'));
  assert.ok(h.shell.tabByKey(key('feat-b')).started, 'the selected tab starts');
  assert.ok(!h.shell.tabByKey(key('dev')).started, 'dev does not, when it is not selected');
});

// --- the poller: W3 ----------------------------------------------------------

test('a worktree added while open becomes a tab on the next poll, not started (W3)', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  h.listText = porcelain([...THREE, ['feat-c', 'feat/c']]);
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b', 'feat/c']);
  assert.strictEqual(h.shell.tabByKey(key('feat-c')).started, false);
});

test('a worktree git no longer lists: its host is stopped and its tab closed', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  h.listText = porcelain([THREE[0], THREE[2]]);
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/b']);
  assert.deepStrictEqual(h.controls, [{ port: 7701, token: 'tok-7701', msg: { type: 'stop' } }]);
  assert.deepStrictEqual(h.viewsGone, [key('feat-a')]);
});

test('the selected tab going away moves the selection to a neighbour, never to nothing', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  await h.shell.select(key('feat-a'));
  h.listText = porcelain([THREE[0], THREE[2]]);
  await h.shell.poll();
  await flush();
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-b'));
  assert.ok(h.shell.tabByKey(key('feat-b')).started, 'and the neighbour starts');
});

test('a git failure is NO observation: every tab stays, and the notice says why', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  h.listFails = true;
  await h.shell.poll();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  assert.match(h.shell.snapshot().notice, /can't list worktrees: git broke/);
  h.listFails = false;
  await h.shell.poll();
  assert.strictEqual(h.shell.snapshot().notice, null);
});

test('a poll whose list has no dev keeps every tab', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  h.listText = porcelain([['feat-a', 'feat/a']]);
  await h.shell.poll();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  assert.deepStrictEqual(h.controls, []);
});

test('only one poll runs at a time: a tick that finds one running does nothing', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  h.gitMax = 0;
  await Promise.all([h.shell.poll(), h.shell.poll(), h.shell.poll()]);
  assert.strictEqual(h.gitMax, 1);
});

// --- hand close: criterion 5 -------------------------------------------------

test('hand close: confirm, then stop + close; the tab stays closed while git lists it, and dev cannot', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  assert.strictEqual((await h.shell.closeTab(key('dev'))).ok, false, 'dev has no close (criterion 6)');
  h.confirm = false;
  assert.strictEqual((await h.shell.closeTab(key('feat-a'))).cancelled, true);
  assert.deepStrictEqual(h.controls, []);
  assert.strictEqual(h.shell.model().length, 3);
  h.confirm = true;
  assert.strictEqual((await h.shell.closeTab(key('feat-a'))).ok, true);
  assert.deepStrictEqual(labels(h), ['develop', 'feat/b']);
  assert.deepStrictEqual(h.controls, [{ port: 7701, token: 'tok-7701', msg: { type: 'stop' } }]);
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/b'], 'git still lists it, so it stays closed');
});

test('closing the selected tab selects a neighbour', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  await h.shell.select(key('feat-a'));
  await h.shell.closeTab(key('feat-a'));
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-b'));
});

test('a tab closed while it is still starting does not leave its host behind', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  const pending = h.shell.select(key('feat-a'));
  const closing = h.shell.closeTab(key('feat-a'));
  await Promise.all([pending, closing]);
  await flush();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  const spawnedForA = h.spawns.filter(s => s.key === key('feat-a'));
  const stops = h.controls.filter(c => c.msg.type === 'stop');
  assert.strictEqual(stops.length, spawnedForA.length, 'every host spawned for the closed tab was stopped');
});

// --- Dexter, PR #75 F2: Retry after a timed-out spawn ---------------------------

test('F2: Retry after a timed-out start ATTACHES to the first host with its ORIGINAL token; one spawn total', async () => {
  const h = harness();
  h.spawnRegisters = false;            // the real host is not listening yet
  await h.shell.open();
  await flush();
  h.failWait = true;
  const before = h.spawns.length;
  await h.shell.select(key('feat-a'));
  const tab = h.shell.tabByKey(key('feat-a'));
  assert.match(tab.error, /did not come up/);
  assert.strictEqual(h.spawns.length - before, 1);
  const first = h.spawns[h.spawns.length - 1];
  // The slow host finally binds, and writes ITS token file on 'listening'.
  h.failWait = false;
  h.running[first.port] = tab.cwd;
  h.tokenFiles[first.port] = first.token;
  await h.shell.select(key('feat-a'));
  assert.strictEqual(tab.started, true);
  assert.strictEqual(tab.token, first.token, 'the first host bound, so its token');
  assert.strictEqual(h.spawns.length - before, 1, 'Retry spawned nothing');
});

// --- Dexter, PR #75 R2-2: present the BOUND host's token -------------------------
// Since F2 only the host that wins the bind writes `hosts/<port>.token`, so that
// file names the token of whoever is actually listening. A token the shell kept
// is only a guess about who that is.

test('R2-2: Retry attaches with the token file of the host that bound, not the token it kept', async () => {
  const h = harness();
  h.spawnRegisters = false;
  await h.shell.open();
  await flush();
  h.failWait = true;
  await h.shell.select(key('feat-a'));
  const first = h.spawns[h.spawns.length - 1];
  // Another window's spawn for the same worktree won the port, with its own token.
  h.failWait = false;
  h.running[first.port] = wt('feat-a');
  h.tokenFiles[first.port] = 'T2-other-window';
  await h.shell.select(key('feat-a'));
  const tab = h.shell.tabByKey(key('feat-a'));
  assert.strictEqual(tab.started, true);
  assert.strictEqual(tab.token, 'T2-other-window');
});

test('R2-2: third Retry -- the FIRST host wins the bind while a new one is spawned: present the winner\'s token', async () => {
  const h = harness();
  h.spawnRegisters = false;
  await h.shell.open();
  await flush();
  h.failWait = true;
  await h.shell.select(key('feat-a'));      // spawn H1, wait fails
  await h.shell.select(key('feat-a'));      // waits again, fails, H1 forgotten
  const first = h.spawns[h.spawns.length - 1];
  h.failWait = false;
  h.spawnRegisters = true;
  // H2 is spawned, but H1 binds first; H2 loses and writes nothing.
  h.onSpawn = (s) => {
    if (s.token !== first.token) { h.running[s.port] = wt('feat-a'); h.tokenFiles[s.port] = first.token; }
  };
  await h.shell.select(key('feat-a'));
  const tab = h.shell.tabByKey(key('feat-a'));
  assert.strictEqual(tab.started, true);
  assert.notStrictEqual(h.spawns[h.spawns.length - 1].token, first.token, 'a second host was spawned');
  assert.strictEqual(tab.token, first.token, 'the tab speaks to H1, so it presents H1\'s token');
});

test('R2-2: our own spawn answers before its token file is written: present the token it was given', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  // It binds, but 'listening' hasn't written the file yet (`null` = unreadable).
  h.spawnRegisters = false;
  h.onSpawn = (s) => { h.running[s.port] = wt('feat-a'); h.tokenFiles[s.port] = null; };
  await h.shell.select(key('feat-a'));
  const tab = h.shell.tabByKey(key('feat-a'));
  assert.strictEqual(tab.started, true);
  assert.strictEqual(tab.token, h.spawns[h.spawns.length - 1].token);
});

test('F2: Retry while the first host is STILL not listening waits for it instead of spawning a second', async () => {
  const h = harness();
  h.spawnRegisters = false;
  await h.shell.open();
  await flush();
  h.failWait = true;
  const before = h.spawns.length;
  await h.shell.select(key('feat-a'));
  const first = h.spawns[h.spawns.length - 1];
  h.failWait = false;                  // it comes up during the second wait
  await h.shell.select(key('feat-a'));
  const tab = h.shell.tabByKey(key('feat-a'));
  assert.strictEqual(h.spawns.length - before, 1);
  assert.strictEqual(tab.started, true);
  assert.strictEqual(tab.token, first.token);
});

test('F2: a host that never comes up is forgotten after one more wait, so the next Retry can spawn', async () => {
  const h = harness();
  h.spawnRegisters = false;
  await h.shell.open();
  await flush();
  h.failWait = true;
  const before = h.spawns.length;
  await h.shell.select(key('feat-a'));
  await h.shell.select(key('feat-a'));     // waits again, still nothing
  assert.strictEqual(h.spawns.length - before, 1);
  h.failWait = false;
  await h.shell.select(key('feat-a'));     // gives up on it and spawns afresh
  assert.strictEqual(h.spawns.length - before, 2);
  assert.strictEqual(h.shell.tabByKey(key('feat-a')).started, true);
});

// --- Dexter, PR #75 F3: hand close must stop, and a failed stop is visible ----

test('F3: closing a tab that is still attaching stops the session it ends up presenting', async () => {
  const h = harness({ running: { 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  // A tab whose host is running but which has not been presented yet.
  const tab = h.shell.tabByKey(key('feat-b'));
  h.running[7702] = wt('feat-b');
  const pending = h.shell.select(key('feat-b'));      // choosePort resolves `attach` AFTER the close starts
  assert.strictEqual(tab.starting, true);
  const closing = h.shell.closeTab(key('feat-b'));
  await Promise.all([pending, closing]);
  await flush();
  assert.strictEqual(h.shell.tabByKey(key('feat-b')), null);
  assert.deepStrictEqual(h.controls.filter(c => c.port === 7702),
    [{ port: 7702, token: 'tok-7702', msg: { type: 'stop' } }], 'the attached session was stopped');
});

test('F3: a stop that is refused still closes the tab, and the strip notice names the branch and the error', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  h.controlReply = () => ({ ok: false, error: 'handshake refused (HTTP 403)' });
  const r = await h.shell.closeTab(key('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null, 'the tab is closed either way');
  const notice = h.shell.snapshot().closeNotice;
  assert.strictEqual(notice, "Couldn't end the session in feat/a: handshake refused (HTTP 403). It may still be running.");
  // ...and it is cleared by the next selection rather than sitting there forever.
  await h.shell.select(key('dev'));
  assert.strictEqual(h.shell.snapshot().closeNotice, null);
});

test('F3: a stop that throws is reported the same way', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  h.controlReply = () => { throw new Error('socket gone'); };
  await h.shell.closeTab(key('feat-a'));
  assert.match(h.shell.snapshot().closeNotice, /feat\/a: socket gone\. It may still be running\./);
});

test('F3: a clean stop leaves no notice', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  await h.shell.closeTab(key('feat-a'));
  assert.strictEqual(h.shell.snapshot().closeNotice, null);
});

// --- Dexter, PR #75 R2-3: a close is never silent about a session it left ---------

test('R2-3: closing a tab whose open-time attach is still QUEUED stops the running session', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7702: wt('feat-b') } });
  let release;
  h.hold = new Promise((r) => { release = r; });
  await h.shell.open();                              // every attach is queued behind the hold
  const tab = h.shell.tabByKey(key('feat-b'));
  assert.strictEqual(tab.started, false);
  assert.strictEqual(tab.starting, false, 'an attach never sets starting -- the case F3 missed');
  const closing = h.shell.closeTab(key('feat-b'));
  await settle();
  h.hold = null;
  release();
  const r = await closing;
  await flush();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.shell.tabByKey(key('feat-b')), null);
  assert.deepStrictEqual(h.controls.filter(c => c.port === 7702),
    [{ port: 7702, token: 'tok-7702', msg: { type: 'stop' } }], 'the session found by the attach was stopped');
});

test('R2-3: closing a tab whose spawned host never answered twice says it may still be running', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  h.spawnRegisters = false;
  await h.shell.open();
  await flush();
  h.failWait = true;
  await h.shell.select(key('feat-a'));
  await h.shell.select(key('feat-a'));               // second wait fails: no pending host any more
  const r = await h.shell.closeTab(key('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  assert.match(h.shell.snapshot().closeNotice, /feat\/a/);
  assert.match(h.shell.snapshot().closeNotice, /may still be running/);
});

test('R2-3: closing a never-started tab with no host anywhere is quiet and sends nothing', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  const r = await h.shell.closeTab(key('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.shell.snapshot().closeNotice, null);
  assert.deepStrictEqual(h.controls, []);
});

// --- Dexter, PR #75 R2-4: back to a tab that already had the keyboard ---------------

test('R2-4: A (view) -> B (no view) -> A gives the keyboard back to A', async () => {
  const h = harness({ running: { 7700: wt('dev') }, spawnFails: true });
  await h.shell.open();
  await flush();
  await h.shell.select(key('feat-a'));               // its start fails: no view, the strip has the keys
  assert.strictEqual(h.shell.tabByKey(key('feat-a')).view, null);
  await h.shell.select(key('dev'));
  await flush();
  assert.deepStrictEqual(focusTrace(h), [key('dev'), key('dev')]);
});

// --- Dexter F4 / Miguel M1, PR #75: a lazily created view gets the keyboard ------

test('F4: focusStep -- focus a selected view that lacks the keyboard, only while the window is focused', () => {
  const v = {};
  const w = {};
  assert.deepStrictEqual(focusStep(null, { windowFocused: true, selectedView: v }), { focus: true, lastFocused: v });
  assert.deepStrictEqual(focusStep(v, { windowFocused: true, selectedView: v }), { focus: false, lastFocused: v }, 'already has it');
  assert.deepStrictEqual(focusStep(w, { windowFocused: true, selectedView: v }), { focus: true, lastFocused: v }, 'a different view');
  assert.deepStrictEqual(focusStep(w, { windowFocused: false, selectedView: v }), { focus: false, lastFocused: w }, 'window not focused');
});

test('R2-4: focusStep -- a selection with no view leaves nothing holding the keyboard', () => {
  const v = {};
  assert.deepStrictEqual(focusStep(v, { windowFocused: true, selectedView: null }), { focus: false, lastFocused: null });
  assert.deepStrictEqual(focusStep(v, { windowFocused: false, selectedView: null }), { focus: false, lastFocused: null });
  assert.deepStrictEqual(focusStep(undefined, { windowFocused: false, selectedView: v }), { focus: false, lastFocused: null });
});

test('R2-4: PROPERTY -- after any trace, the view last focused is the selected one whenever the window is focused', () => {
  const views = [{}, {}, {}];
  fc.assert(fc.property(
    fc.array(fc.record({ sel: fc.integer({ min: -1, max: 2 }), focused: fc.boolean() }), { maxLength: 30 }),
    (trace) => {
      let last = null;
      for (const s of trace) {
        const selectedView = s.sel < 0 ? null : views[s.sel];
        const r = focusStep(last, { windowFocused: s.focused, selectedView });
        last = r.lastFocused;
        if (s.focused && selectedView && last !== selectedView) return false;
        if (!selectedView && last !== null) return false;
      }
      return true;
    }));
});

// Drives focusStep over the shell's own snapshots the way main's applySelection does.
function focusTrace(h) {
  const focusedKeys = [];
  let last = null;
  for (const snap of h.changes) {
    const t = snap.tabs.find(x => x.key === snap.selectedKey);
    const view = t && t.view ? t.view : null;
    const r = focusStep(last, { windowFocused: true, selectedView: view });
    if (r.focus) focusedKeys.push(t.key);
    last = r.lastFocused;
  }
  return focusedKeys;
}

test('F4: the view created for the ALREADY-selected tab is focused when it appears (first launch, Ctrl+Tab onto an unstarted tab)', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(focusTrace(h), [key('dev')], 'dev was selected before it had a view, and is focused once it has one');
  await h.shell.select(key('feat-b'));      // unstarted: its view is created AFTER the selection changed
  await flush();
  assert.deepStrictEqual(focusTrace(h), [key('dev'), key('feat-b')]);
});

test('F4: presenting a NON-selected tab (reattach at open) does not steal focus', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(h.viewsMade.map(v => v.tab).sort(), [key('dev'), key('feat-a')].sort());
  assert.deepStrictEqual(focusTrace(h), [key('dev')], 'only the selected tab is ever focused');
});

// --- what a tab reports ------------------------------------------------------

test('report maps the sender to its tab, sanitises, and dedupes', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  const aView = h.shell.tabByKey(key('feat-a')).view;
  assert.strictEqual(h.shell.report({}, { working: true }), false, 'a stranger is nobody');
  const n = h.changes.length;
  assert.strictEqual(h.shell.report(aView, { working: true, lock: 'blocked', health: '↓2', junk: 1 }), true);
  const e = h.shell.model().find(x => x.label === 'feat/a');
  assert.deepStrictEqual([e.working, e.lockGlyph, e.health], [true, 'blocked', '↓2']);
  const n2 = h.changes.length;
  assert.ok(n2 > n);
  h.shell.report(aView, { working: true, lock: 'blocked', health: '↓2' });
  assert.strictEqual(h.changes.length, n2, 'an unchanged status is not re-published');
  assert.strictEqual(h.shell.isTabView(devView), true);
  assert.strictEqual(h.shell.isTabView({}), false);
});

test('needsInput shows on a tab you are not looking at, and clears on selection', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const aView = h.shell.tabByKey(key('feat-a')).view;
  h.shell.report(aView, { needsInput: true });
  assert.strictEqual(h.shell.model().find(x => x.label === 'feat/a').needsInput, true);
  await h.shell.select(key('feat-a'));
  assert.strictEqual(h.shell.model().find(x => x.label === 'feat/a').needsInput, false);
  assert.ok(h.sent.some(([k, ch]) => k === key('feat-a') && ch === 'tab-selected'), 'the page is told, so it clears its own flag');
});

test('needsInput from the tab you are looking at (window focused) does not light the strip', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  h.shell.report(devView, { needsInput: true });
  assert.strictEqual(h.shell.model().find(x => x.isDev).needsInput, false);
  const h2 = harness({ running: { 7700: wt('dev') }, focused: false });
  await h2.shell.open();
  await flush();
  h2.shell.report(h2.shell.tabByKey(key('dev')).view, { needsInput: true });
  assert.strictEqual(h2.shell.model().find(x => x.isDev).needsInput, true, 'window in the background: the strip shows it');
});

test('#31: a tab that finished pulses while unselected, and the pulse ends when it is selected', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const aView = h.shell.tabByKey(key('feat-a')).view;
  const pulseOf = () => h.shell.model().find(x => x.label === 'feat/a').pulse;
  assert.strictEqual(pulseOf(), null);
  h.shell.report(aView, { finished: true });
  assert.strictEqual(pulseOf(), 'done');
  h.shell.report(aView, { finished: true, needsInput: true });
  assert.strictEqual(pulseOf(), 'needs', 'the urgent look outranks the calm one');
  await h.shell.select(key('feat-a'));
  assert.strictEqual(pulseOf(), null);
  const status = h.shell.tabByKey(key('feat-a')).status;
  assert.strictEqual(status.finished, false, 'the shell also forgets it, so deselecting does not bring it back');
  await h.shell.select(key('dev'));
  assert.strictEqual(pulseOf(), null);
});

test('#31: finished from the tab you are looking at (window focused) never pulses', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  h.shell.report(h.shell.tabByKey(key('dev')).view, { finished: true });
  assert.strictEqual(h.shell.model().find(x => x.isDev).pulse, null);
  assert.strictEqual(h.shell.tabByKey(key('dev')).status.finished, false);
  assert.ok(h.sent.some(([k, ch]) => k === key('dev') && ch === 'tab-selected'), 'the page is told, so it clears its own flag');
  // Window in the background: still selected, so still no pulse (it is the tab on screen).
  const h2 = harness({ running: { 7700: wt('dev') }, focused: false });
  await h2.shell.open();
  await flush();
  h2.shell.report(h2.shell.tabByKey(key('dev')).view, { finished: true });
  assert.strictEqual(h2.shell.model().find(x => x.isDev).pulse, null);
});

test('#31 (Dexter F1): a tab you watched finish does not pulse once you leave it -- a look is selected + focused, whichever comes last', async () => {
  for (const flag of ['finished', 'needsInput']) {
    const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') }, focused: false });
    await h.shell.open();
    await flush();
    await h.shell.select(key('feat-a'));
    h.shell.report(h.shell.tabByKey(key('feat-a')).view, { [flag]: true });
    const sentBefore = h.sent.filter(([, ch]) => ch === 'tab-selected').length;
    h.focused = true;             // the window comes back; Ricardo reads the tab
    assert.strictEqual(h.shell.looked(), true, flag);
    assert.ok(h.sent.filter(([, ch]) => ch === 'tab-selected').length > sentBefore, 'the page is told, so it clears its own flag');
    await h.shell.select(key('dev'));
    const a = h.shell.model().find(x => x.label === 'feat/a');
    assert.strictEqual(a.pulse, null, flag);
    assert.strictEqual(a.needsInput, false, flag);
    assert.strictEqual(h.shell.tabByKey(key('feat-a')).status[flag], false, flag);
  }
});

test('#31: looked() touches only the selected tab, and says false when there was nothing to clear', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  assert.strictEqual(h.shell.looked(), false, 'no status yet');
  h.shell.report(h.shell.tabByKey(key('feat-a')).view, { finished: true });
  assert.strictEqual(h.shell.looked(), false, 'dev is the selected one and has nothing pending');
  assert.strictEqual(h.shell.model().find(x => x.label === 'feat/a').pulse, 'done', 'the unselected tab keeps its pulse');
});

test('a raise and an attention click select the sender\'s tab and bring the window forward', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const aView = h.shell.tabByKey(key('feat-a')).view;
  assert.strictEqual(h.shell.raise({}), false);
  assert.strictEqual(h.focusCalls, 0);
  assert.strictEqual(h.shell.raise(aView), true);
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-a'));
  assert.strictEqual(h.focusCalls, 1);
  await h.shell.select(key('dev'));
  assert.strictEqual(h.shell.attentionClick(aView), true);
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-a'));
  assert.strictEqual(h.focusCalls, 2);
});

// --- Jump to its tab (the Git panel, documentation/PLAN_GIT_TREE.md Task 10) ---

test('selectFolder: the tab whose worktree is that folder is selected, however the path is spelled', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  const spelled = path.join(ROOT, 'feat-a').replace(/\\/g, '/').toUpperCase() + '/';
  assert.deepStrictEqual(await h.shell.selectFolder(devView, spelled), { kind: 'select-tab' });
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-a'));
});

test('selectFolder: no tab for that folder, a bad path, or a sender that is no tab view is explained, nothing moves', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  const before = h.shell.snapshot().selectedKey;
  for (const [sender, p] of [[devView, path.join(ROOT, 'feat-zzz')], [devView, ''], [devView, 42], [{}, path.join(ROOT, 'feat-a')]]) {
    const r = await h.shell.selectFolder(sender, p);
    assert.strictEqual(r.kind, 'explain', String(p));
    assert.strictEqual(typeof r.text, 'string');
  }
  assert.strictEqual(h.shell.snapshot().selectedKey, before);
});

// --- the Git drawer (Enhancement #46): what a branch's tab is doing, and *Run /merged* ---

const idleStatus = { working: false, needsInput: false, finished: false, lock: null, health: null };

test('tabStates: per folder, whether a tab is open, started, and what its session reported -- unknown stays unknown', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  const aView = h.shell.tabByKey(key('feat-a')).view;
  const folders = [wt('feat-a'), wt('feat-b'), wt('feat-zzz'), ''];
  let got = h.shell.tabStates(devView, folders);
  assert.deepStrictEqual(got[0], { folder: wt('feat-a'), open: true, started: true, known: false, working: null, needsInput: null });
  assert.deepStrictEqual(got[1], { folder: wt('feat-b'), open: true, started: false, known: false, working: null, needsInput: null });
  assert.deepStrictEqual(got[2], { folder: wt('feat-zzz'), open: false, started: false, known: false, working: null, needsInput: null });
  assert.strictEqual(got.length, 3, 'a blank folder is dropped, not answered');
  h.shell.report(aView, { working: true });
  got = h.shell.tabStates(devView, [wt('feat-a')]);
  assert.deepStrictEqual(got[0], { folder: wt('feat-a'), open: true, started: true, known: true, working: true, needsInput: false });
});

test('tabStates: spelled however, answered with the folder as it was asked; a stranger gets nothing; junk is ignored', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  const spelled = wt('feat-a').replace(/\\/g, '/').toUpperCase();
  assert.strictEqual(h.shell.tabStates(devView, [spelled])[0].open, true);
  assert.strictEqual(h.shell.tabStates(devView, [spelled])[0].folder, spelled);
  assert.deepStrictEqual(h.shell.tabStates({}, [wt('feat-a')]), []);
  assert.deepStrictEqual(h.shell.tabStates(devView, 'nope'), []);
  assert.deepStrictEqual(h.shell.tabStates(devView, [42, null, {}]), []);
  assert.strictEqual(h.shell.tabStates(devView, Array(500).fill(wt('feat-a'))).length, 200, 'a bounded answer');
});

test('runMerged: selects the tab, then types /merged and, a step later, Enter -- two frames, never one chunk', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  h.shell.report(h.shell.tabByKey(key('feat-a')).view, idleStatus);
  const r = await h.shell.runMerged(devView, wt('feat-a'));
  assert.deepStrictEqual(r, { kind: 'sent', branch: 'feat/a' });
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-a'), "switched to that branch's tab");
  assert.deepStrictEqual(h.controls.map(c => [c.port, c.token, c.msg]), [
    [7701, 'tok-7701', { type: 'input', data: '/merged' }],
    [7701, 'tok-7701', { type: 'input', data: '\r' }],
  ]);
  assert.deepStrictEqual(h.slept, [120], 'the Enter comes a step after the text, or a line typed in one chunk is taken for a paste');
});

test('runMerged: a session that is working, needs you, has not reported or has not started is told, nothing is sent, nothing moves', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  const aView = h.shell.tabByKey(key('feat-a')).view;
  const before = h.shell.snapshot().selectedKey;
  const cases = [
    [null, /hasn't reported/, wt('feat-a')],
    [{ working: true }, /working/, wt('feat-a')],
    [{ needsInput: true }, /waiting for you/, wt('feat-a')],
    [idleStatus, /hasn't started/, wt('feat-b')],       // feat-b has a tab but no session yet
    [idleStatus, /no tab open/, wt('feat-zzz')],
  ];
  for (const [status, re, folder] of cases) {
    if (status) h.shell.report(aView, status);
    const r = await h.shell.runMerged(devView, folder);
    assert.strictEqual(r.kind, 'explain');
    assert.match(r.text, re);
  }
  assert.deepStrictEqual(h.controls, []);
  assert.strictEqual(h.shell.snapshot().selectedKey, before);
});

test('runMerged: a stranger sender, a bad folder or a host that will not take it are explained; Enter is never sent after a failed text', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  h.shell.report(h.shell.tabByKey(key('feat-a')).view, idleStatus);
  for (const [sender, p] of [[{}, wt('feat-a')], [devView, ''], [devView, 42]]) {
    assert.strictEqual((await h.shell.runMerged(sender, p)).kind, 'explain', String(p));
  }
  assert.deepStrictEqual(h.controls, []);
  h.controlReply = () => ({ ok: false, error: 'connection refused' });
  const r = await h.shell.runMerged(devView, wt('feat-a'));
  assert.strictEqual(r.kind, 'explain');
  assert.match(r.text, /connection refused/);
  assert.strictEqual(h.controls.length, 1, 'no Enter after text that never went in');
});

test("runMerged: text typed but Enter refused says so, because a half-typed command is left in that session's box", async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  h.shell.report(h.shell.tabByKey(key('feat-a')).view, idleStatus);
  h.controlReply = (c) => (c.msg.data === '\r' ? { ok: false, error: 'timed out after 3000ms' } : { ok: true, reply: null });
  const r = await h.shell.runMerged(devView, wt('feat-a'));
  assert.strictEqual(r.kind, 'explain');
  assert.match(r.text, /typed \/merged/);
  assert.match(r.text, /timed out/);
});

// --- Go to that session ------------------------------------------------------

test('goTo: a tab in THIS window is selected', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  const devView = h.shell.tabByKey(key('dev')).view;
  const r = await h.shell.goTo(devView, { pid: 5, port: 7701, install: 'C:/x' });
  assert.deepStrictEqual(r, { kind: 'select-tab' });
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-a'));
});

test('goTo: another install raises its window; windows 0 is explained, a refusal is explained', async () => {
  const holder = { pid: 4242, port: 7999, install: 'C:/other' };
  const calls = [];
  let reply = { ok: true, reply: { type: 'raised', windows: 2 } };
  const s = createShell({
    mode: 'tabs', container: ROOT, log: () => {},
    git: { list: async () => porcelain([THREE[0]]), marker: noMarker }, ops: NO_OPS,
    hosts: {
      choosePort: async () => ({ port: 7700, action: 'attach' }), probe: async () => 'listening',
      spawn: () => {}, wait: async () => true, tokenFor: () => 'tok', tokenFile: () => 'tok', newToken: () => 't',
      control: async (c) => { calls.push(c); return reply; },
      identity: ({ install, port }) => (install === 'C:/other' && port === 7999 ? { pid: 4242 } : null),
      readToken: (install, port) => (install === 'C:/other' ? 'secret' : null),
    },
    views: { create: () => ({ v: 1 }), destroy: () => {}, send: () => {}, owns: (t, s2) => t.view === s2 },
    ui: { confirmClose: async () => true, changed: () => {}, focusWindow: () => {}, isFocused: () => true },
  });
  await s.open();
  await flush();
  const view = s.tabByKey(key('dev')).view;
  assert.deepStrictEqual(await s.goTo(view, holder), { kind: 'raised' });
  assert.deepStrictEqual(calls, [{ port: 7999, token: 'secret', msg: { type: 'raise' } }]);
  reply = { ok: true, reply: { type: 'raised', windows: 0 } };
  assert.deepStrictEqual(await s.goTo(view, holder), { kind: 'explain', text: noWindowText(holder) });
  reply = { ok: false, error: 'connection refused' };
  const bad = await s.goTo(view, holder);
  assert.strictEqual(bad.kind, 'explain');
  assert.match(bad.text, /connection refused/);
  // A stale lock: the identity's pid is not the holder's -> no token, nothing sent.
  calls.length = 0;
  const stale = await s.goTo(view, { ...holder, pid: 1 });
  assert.strictEqual(stale.kind, 'explain');
  assert.deepStrictEqual(calls, []);
});

test('goTo from something that is not a tab view is refused with words', async () => {
  const h = harness();
  const r = await h.shell.goTo({}, { pid: 1, port: 7700 });
  assert.strictEqual(r.kind, 'explain');
  assert.deepStrictEqual(h.controls, []);
});

// --- PR 3: merged markers -> session ends -> remove (Contracts B, C) -------------

const phaseOf = (h, name) => (h.shell._state().tabs.find(t => normPath(t.path) === key(name)) || {}).phase;
const removes = (h) => h.opsCalls.filter(([op]) => op === 'remove');

// dev and feat-a running and started (feat-a selected once), feat-b never started.
async function startedA() {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  await h.shell.select(key('feat-a'));
  await flush();
  return h;
}

test('a marker for the branch of this poll marks the tab merged; a stale one never counts', async () => {
  const h = await startedA();
  h.markers[key('feat-b')] = 'feat/old-name';
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();
  assert.strictEqual(phaseOf(h, 'feat-a'), 'finishing');
  assert.strictEqual(phaseOf(h, 'feat-b'), 'live');
  assert.ok(!h.markerReads.some(([k]) => k === key('dev')), 'dev is never read');
  const e = h.shell.model().find(x => x.key === key('feat-a'));
  assert.strictEqual(tabModel.badgeFor(e), 'merged');
  // What the strip paints, computed here: the strip decides nothing.
  assert.strictEqual(e.badge, 'merged');
  assert.strictEqual(e.phaseText, 'Merged. When its session ends, this worktree is removed.');
  const plain = h.shell.model().find(x => x.key === key('feat-b'));
  assert.strictEqual(plain.badge, null);
  assert.strictEqual(plain.phaseText, null);
});

test('criterion 3: merged, then its session ends (port refused) -> ONE remove, then the tab closes', async () => {
  const h = await startedA();
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(removes(h), [], 'still listening: nothing removed');
  delete h.running[7701];                  // the host exits with its claude
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(removes(h), [['remove', key('feat-a')]]);
  assert.ok(!h.shell.tabByKey(key('feat-a')), 'tab closed after a successful remove');
  assert.notStrictEqual(h.shell.snapshot().selectedKey, key('feat-a'));
  await h.shell.poll();
  await flush();
  assert.strictEqual(removes(h).length, 1, 'never removed twice');
});

test('criterion 9: no remove while the port answers or the probe can\u2019t tell (a timeout is not "gone")', async () => {
  const h = await startedA();
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();
  delete h.running[7701];
  h.probeOverride = () => 'unknown';
  for (let i = 0; i < 3; i++) { await h.shell.poll(); await flush(); }
  assert.deepStrictEqual(removes(h), []);
  assert.strictEqual(phaseOf(h, 'feat-a'), 'finishing');
  h.probeOverride = null;
  await h.shell.poll();
  await flush();
  assert.strictEqual(removes(h).length, 1);
});

test('a merged tab this window never started is not removed by its poll (left to the reaper)', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  h.markers[key('feat-b')] = 'feat/b';
  for (let i = 0; i < 3; i++) { await h.shell.poll(); await flush(); }
  assert.strictEqual(phaseOf(h, 'feat-b'), 'finishing');
  assert.deepStrictEqual(removes(h), []);
});

test('criterion 4: a failed remove keeps the tab and says why; exit 2 keeps it as kept, not an error', async () => {
  const h = await startedA();
  h.removeResult = { ok: false, error: 'C:\\x\\feat-a has uncommitted changes. Nothing was removed.' };
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();
  delete h.running[7701];
  await h.shell.poll();
  await flush();
  assert.strictEqual(phaseOf(h, 'feat-a'), 'remove-failed');
  const e = h.shell.model().find(x => x.key === key('feat-a'));
  assert.match(tabModel.phaseText(e), /uncommitted changes/);
  assert.strictEqual(tabModel.badgeFor(e), 'warn');

  const k = await startedA();
  k.removeResult = { ok: false, kept: true, reason: 'feat/a still has a handoff brief' };
  k.markers[key('feat-a')] = 'feat/a';
  await k.shell.poll();
  delete k.running[7701];
  await k.shell.poll();
  await flush();
  assert.strictEqual(phaseOf(k, 'feat-a'), 'kept');
  const ke = k.shell.model().find(x => x.key === key('feat-a'));
  assert.strictEqual(tabModel.phaseText(ke), 'Merged, and kept: feat/a still has a handoff brief');
  assert.strictEqual(tabModel.badgeFor(ke), 'merged');
});

test('a remover that throws is a failed remove, never an unhandled rejection', async () => {
  const h = await startedA();
  h.removeResult = () => { throw new Error('spawn exploded'); };
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();
  delete h.running[7701];
  await h.shell.poll();
  await flush();
  assert.strictEqual(phaseOf(h, 'feat-a'), 'remove-failed');
});

test('a remove that finishes after the window closed changes nothing and publishes nothing', async () => {
  const h = await startedA();
  let release;
  h.removeResult = () => new Promise(r => { release = r; });
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();
  delete h.running[7701];
  await h.shell.poll();
  await flush();
  h.shell.destroy();
  const published = h.changes.length;
  release({ ok: true, already: false });
  await flush();
  assert.strictEqual(phaseOf(h, 'feat-a'), 'removing');
  assert.strictEqual(h.changes.length, published);
});

// --- PR 3: + -> New branch (Contract A), then setup (Contract E) ---------------------

test('createWorktree: a local refusal never runs the script', async () => {
  const h = harness();
  await h.shell.open();
  const r = await h.shell.createWorktree('-Base');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(h.opsCalls, []);
  assert.strictEqual(h.shell.snapshot().create.phase, 'failed');
});

test('criterion 2: the script refusing shows its words and makes no tab', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  h.createResult = () => ({ ok: false, error: 'demo: a branch needs a prefix (feat/, fix/, ...)' });
  const r = await h.shell.createWorktree('demo');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(h.shell.snapshot().create, { phase: 'failed', branch: 'demo', error: 'demo: a branch needs a prefix (feat/, fix/, ...)' });
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
});

test('criterion 2 + 10: a new branch gets a tab, selected, and its host starts only after setup', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  let release;
  h.setupHold = new Promise(r => { release = r; });
  const done = h.shell.createWorktree('feat/demo');
  for (let i = 0; i < 4; i++) await flush();
  assert.ok(labels(h).includes('feat/demo'));
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-demo'));
  assert.ok(!h.spawns.some(s => s.key === key('feat-demo')), 'no session while setup runs');
  h.onLine('added 512 packages');
  const during = h.shell.model().find(e => e.key === key('feat-demo'));
  assert.deepStrictEqual(during.setup, { running: true, line: 'added 512 packages', error: null, log: null });
  assert.strictEqual(h.shell.snapshot().create, null);
  release();
  await done;
  await flush();
  assert.ok(h.spawns.some(s => s.key === key('feat-demo')), 'started once setup finished');
  assert.ok(h.shell.tabByKey(key('feat-demo')).started);
  assert.strictEqual(h.shell.model().find(e => e.key === key('feat-demo')).setup, null);
  assert.deepStrictEqual(h.opsCalls.map(([op]) => op), ['create', 'setup']);
});

test('criterion 10: a failing setup still starts the session, and the error stays on the tab', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  h.setupResult = { ok: false, error: "run: 'npm ci' exited with 1 (output in L).", log: 'L' };
  await h.shell.createWorktree('feat/demo');
  await flush();
  assert.ok(h.shell.tabByKey(key('feat-demo')).started);
  const e = h.shell.model().find(x => x.key === key('feat-demo'));
  assert.strictEqual(tabModel.phaseText(e), "Setup failed: run: 'npm ci' exited with 1 (output in L).");
});

test('a tab closed by hand while its setup runs leaves no setup error behind for a reopen', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  let release;
  h.setupHold = new Promise(r => { release = r; });
  h.setupResult = { ok: false, error: 'late failure', log: null };
  const done = h.shell.createWorktree('feat/demo');
  for (let i = 0; i < 4; i++) await flush();
  await h.shell.closeTab(key('feat-demo'));
  release();
  await done;
  await h.shell.reopen(key('feat-demo'));
  await flush();
  const e = h.shell.model().find(x => x.key === key('feat-demo'));
  assert.strictEqual(e.setup, null);
  assert.strictEqual(tabModel.phaseText(e), null);
});

test('no setup script: the new tab starts at once, and Contract A\u2019s warning is shown', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  h.available = { create: true, setup: false, remove: true };
  await h.shell.open();
  await flush();
  h.createResult = (branch) => {
    h.addWorktree('feat-demo', branch);
    return { ok: true, path: wt('feat-demo'), branch, warning: 'Active Lanes row not added' };
  };
  await h.shell.createWorktree('feat/demo');
  await flush();
  assert.ok(h.shell.tabByKey(key('feat-demo')).started);
  assert.ok(!h.opsCalls.some(([op]) => op === 'setup'));
  const e = h.shell.model().find(x => x.key === key('feat-demo'));
  assert.strictEqual(tabModel.phaseText(e), 'Created, but: Active Lanes row not added');
});

test('one creation at a time; while it runs, a tab for that branch selected by hand does not start', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  let release;
  h.createResult = (branch) => new Promise((r) => {
    release = () => r({ ok: true, path: wt('feat-demo'), branch, warning: null });
    h.addWorktree('feat-demo', branch);    // git lists it before the script returns
  });
  h.available = { create: true, setup: false, remove: true };
  const first = h.shell.createWorktree('feat/demo');
  await flush();
  assert.strictEqual((await h.shell.createWorktree('feat/other')).error, 'already creating one');
  await h.shell.poll();
  await flush();
  await h.shell.select(key('feat-demo'));
  await flush();
  assert.ok(!h.spawns.some(s => s.key === key('feat-demo')), 'not started while its creation is pending');
  assert.strictEqual(h.shell.plusMenu().create.enabled, false);
  release();
  await first;
  await flush();
  assert.ok(h.shell.tabByKey(key('feat-demo')).started);
});

// --- PR #80 Dexter --------------------------------------------------------------

test('Dexter F1: closed and reopened while its setup runs, the tab still waits for setup', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  let release;
  h.setupHold = new Promise(r => { release = r; });
  const done = h.shell.createWorktree('feat/demo');
  for (let i = 0; i < 4; i++) await flush();
  await h.shell.closeTab(key('feat-demo'));
  await h.shell.reopen();
  for (let i = 0; i < 4; i++) await flush();
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-demo'));
  assert.ok(!h.spawns.some(s => s.key === key('feat-demo')), 'no session while npm ci still runs');
  release();
  await done;
  await flush();
  assert.ok(h.shell.tabByKey(key('feat-demo')).started, 'and it starts once setup ends');
});

test('Dexter F2: a host that later takes a dead tab’s port never vouches for that tab', async () => {
  const h = await startedA();                       // feat-a on 7701
  delete h.running[7701];                           // A /exits, NOT merged
  await h.shell.poll();
  await flush();
  // B starts and takes the freed 7701.
  await h.shell.select(key('feat-b'));
  await flush();
  assert.strictEqual(h.shell.tabByKey(key('feat-b')).port, 7701, 'the sequence needs B on A’s old port');
  h.markers[key('feat-a')] = 'feat/a';              // /merged lands for A
  await h.shell.poll();                             // 7701 answers -- for B
  await flush();
  delete h.running[7701];                           // B exits
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(removes(h), [], 'A ended before its merge: never removed automatically');
  assert.strictEqual(phaseOf(h, 'feat-a'), 'finishing');
});

test('Dexter F2: a tab started again after its session ended is watched again', async () => {
  const h = await startedA();
  delete h.running[7701];
  await h.shell.poll();
  await flush();
  h.shell.tabByKey(key('feat-a')).started = false;  // what a restart path resets...
  await h.shell.select(key('feat-a'));              // ...and starts again
  await flush();
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();
  await flush();
  delete h.running[h.shell.tabByKey(key('feat-a')).port];
  await h.shell.poll();
  await flush();
  assert.strictEqual(removes(h).length, 1);
});

test('Dexter F3: a setup that fails before git lists the worktree keeps its error for the tab', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  h.createResult = (branch) => ({ ok: true, path: wt('feat-late'), branch, warning: null });   // not listed yet
  h.setupResult = { ok: false, error: "copy: '.env' failed: missing in dev", log: null };
  await h.shell.createWorktree('feat/late');
  h.addWorktree('feat-late', 'feat/late');
  await h.shell.poll();
  await flush();
  const e = h.shell.model().find(x => x.key === key('feat-late'));
  assert.ok(e, 'listed');
  assert.strictEqual(e.phaseText, "Setup failed: copy: '.env' failed: missing in dev");
});

test('Dexter F4: a tab whose folder is being removed cannot be closed (or reopened into it)', async () => {
  const h = await startedA();
  let release;
  h.removeResult = () => new Promise(r => { release = r; });
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();
  delete h.running[7701];
  await h.shell.poll();
  await flush();
  assert.strictEqual(phaseOf(h, 'feat-a'), 'removing');
  assert.strictEqual(h.shell.model().find(e => e.key === key('feat-a')).closable, false);
  const r = await h.shell.closeTab(key('feat-a'));
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(h.shell.plusMenu().reopen, []);
  release({ ok: true, already: false });
  await flush();
});

test('Miguel G1: a new tab git lists late does not steal the selection from one picked meanwhile', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  h.available = { create: true, setup: false, remove: true };
  await h.shell.open();
  await flush();
  // The script answers, but git doesn't list the worktree until a later poll.
  h.createResult = (branch) => ({ ok: true, path: wt('feat-late'), branch, warning: null });
  await h.shell.createWorktree('feat/late');
  await h.shell.select(key('feat-b'));
  h.addWorktree('feat-late', 'feat/late');
  await h.shell.poll();
  await flush();
  assert.ok(labels(h).includes('feat/late'));
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-b'), 'the person chose feat-b; the late tab does not take it');
});

test('Miguel G3: menuText doubles & so a branch name is never read as a menu mnemonic', () => {
  assert.strictEqual(menuText('feat/r&d'), 'feat/r&&d');
  assert.strictEqual(menuText('feat/a&&b'), 'feat/a&&&&b');
  assert.strictEqual(menuText('feat/plain'), 'feat/plain');
  assert.strictEqual(menuText(null), '');
});

test('plusMenu: New branch is offered only with the scripts installed and nothing being created', async () => {
  const h = harness();
  await h.shell.open();
  assert.deepStrictEqual(h.shell.plusMenu().create, { enabled: true, why: null });
  h.available = { create: false, setup: false, remove: false };
  assert.deepStrictEqual(h.shell.plusMenu().create, { enabled: false, why: 'worktree scripts not installed' });
  const single = harness({ mode: 'single' });
  await single.shell.open();
  assert.strictEqual(single.shell.plusMenu().create.enabled, false);
});

test('openCreate / cancelCreate drive the strip form; a failure can be dismissed, a run cannot', async () => {
  const h = harness();
  await h.shell.open();
  assert.strictEqual(h.shell.openCreate(), true);
  assert.deepStrictEqual(h.shell.snapshot().create, { phase: 'input' });
  assert.strictEqual(h.shell.cancelCreate(), true);
  assert.strictEqual(h.shell.snapshot().create, null);
  await h.shell.createWorktree('');
  assert.strictEqual(h.shell.snapshot().create.phase, 'failed');
  assert.strictEqual(h.shell.cancelCreate(), true);
  assert.strictEqual(h.shell.cancelCreate(), false, 'nothing open');
});

// --- PR 3: reopen a tab closed by hand -------------------------------------------

test('a hand-closed tab is offered for reopening, and comes back selected', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  await h.shell.closeTab(key('feat-a'));
  await flush();
  assert.deepStrictEqual(h.shell.plusMenu().reopen, [{ key: key('feat-a'), label: 'feat/a' }]);
  await h.shell.poll();
  assert.ok(!labels(h).includes('feat/a'), 'still closed: a poll does not bring it back');
  const r = await h.shell.reopen();
  await flush();
  assert.strictEqual(r.ok, true);
  assert.ok(labels(h).includes('feat/a'));
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-a'));
  assert.deepStrictEqual(h.shell.plusMenu().reopen, []);
});

test('reopen lists the most recent first, and drops a worktree git no longer lists', async () => {
  const h = harness({ running: { 7700: wt('dev') } });
  await h.shell.open();
  await flush();
  await h.shell.closeTab(key('feat-a'));
  await h.shell.closeTab(key('feat-b'));
  assert.deepStrictEqual(h.shell.plusMenu().reopen.map(x => x.label), ['feat/b', 'feat/a']);
  h.listText = porcelain([['dev', 'develop'], ['feat-a', 'feat/a']]);
  await h.shell.poll();
  assert.deepStrictEqual(h.shell.plusMenu().reopen.map(x => x.label), ['feat/a']);
  assert.strictEqual((await h.shell.reopen(key('feat-b'))).ok, false);
  assert.strictEqual((await h.shell.reopen(key('feat-a'))).ok, true);
});

// --- menus, override, Ctrl+Tab -----------------------------------------------

test('the override is offered only for a blocked tab, and reaches only that view', async () => {
  const h = harness({ running: { 7700: wt('dev'), 7701: wt('feat-a') } });
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(h.shell.menuState(key('feat-a')), { key: key('feat-a'), override: false, close: true });
  assert.strictEqual(h.shell.override(key('feat-a')), false, 'not blocked: nothing is sent');
  h.shell.report(h.shell.tabByKey(key('feat-a')).view, { lock: 'blocked' });
  assert.strictEqual(h.shell.menuState(key('feat-a')).override, true);
  assert.strictEqual(h.shell.override(key('feat-a')), true);
  assert.deepStrictEqual(h.sent.filter(([, ch]) => ch === 'lock-override'), [[key('feat-a'), 'lock-override', undefined]]);
  assert.deepStrictEqual(h.shell.menuState(key('dev')), { key: key('dev'), override: false, close: false }, 'dev has no close');
  assert.deepStrictEqual(h.shell.menuState('nope'), { key: 'nope', override: false, close: false });
});

test('next/previous cycle through every tab and wrap, starting what they land on', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  const seen = [];
  for (let i = 0; i < 3; i++) { await h.shell.next(); seen.push(h.shell.snapshot().selectedKey); }
  assert.deepStrictEqual(seen, [key('feat-a'), key('feat-b'), key('dev')]);
  await h.shell.previous();
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-b'));
  assert.ok(h.shell.tabByKey(key('feat-b')).started);
});

test('createShell refuses deps missing a host function, by name, instead of failing inside a start', () => {
  const base = {
    mode: 'tabs', container: ROOT, git: { list: async () => '', marker: noMarker }, ops: NO_OPS,
    views: { create: () => ({}), destroy: () => {}, send: () => {}, owns: () => false },
    ui: { confirmClose: async () => true, changed: () => {}, focusWindow: () => {}, isFocused: () => true },
  };
  const hosts = {
    choosePort: async () => null, probe: async () => 'unknown', spawn: () => {}, wait: async () => false,
    tokenFor: () => null, tokenFile: () => null, newToken: () => 't', control: async () => ({ ok: true }),
    identity: () => null, readToken: () => null,
  };
  assert.doesNotThrow(() => createShell({ ...base, hosts }));
  for (const k of Object.keys(hosts)) {
    const partial = { ...hosts };
    delete partial[k];
    assert.throws(() => createShell({ ...base, hosts: partial }), new RegExp(`hosts\\.${k}`), k);
  }
});

// --- the probe driver ----------------------------------------------------------

// The probe's shared secret: every line carries it (Miguel, PR #75 M4).
const PT = 'probe-token-0123456789abcdef';
const line = (o) => JSON.stringify({ ...o, token: PT });
const probeCmd = (l, api) => handleProbeCommand(l, api, PT);

test('handleProbeCommand dispatches known commands and refuses the rest by name, never throwing', async () => {
  const log = [];
  const api = {
    state: async () => ({ tabs: [1] }),
    select: async (l) => { log.push(['select', l]); return { ok: true }; },
    close: async (l) => { log.push(['close', l]); return { ok: true }; },
    screenshot: async (f) => { log.push(['shot', f]); return { ok: true, file: f }; },
    quit: async () => ({ ok: true }),
  };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'state' }), api), { ok: true, tabs: [1] });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'select', label: 'feat/a' }), api), { ok: true });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'close', label: 'feat/a' }), api), { ok: true });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'screenshot', file: 'x.png' }), api), { ok: true, file: 'x.png' });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'quit' }), api), { ok: true });
  assert.deepStrictEqual(log, [['select', 'feat/a'], ['close', 'feat/a'], ['shot', 'x.png']]);
  assert.deepStrictEqual(await probeCmd('nope', api), { ok: false, error: 'not JSON' });
  assert.deepStrictEqual(await probeCmd(line({ x: 1 }), api), { ok: false, error: 'no cmd' });
  assert.deepStrictEqual(await probeCmd('null', api), { ok: false, error: 'no cmd' });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'rm' }), api), { ok: false, error: 'unknown command: rm' });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'screenshot' }), api), { ok: false, error: 'screenshot needs a .png file' });
  const boom = await probeCmd(line({ cmd: 'state' }), { state: async () => { throw new Error('kaput'); } });
  assert.deepStrictEqual(boom, { ok: false, error: 'kaput' });
});

test('handleProbeCommand: the ▾ list, and a stop by port (a real port only)', async () => {
  const seen = [];
  const api = {
    background: async () => ({ ok: true, items: [] }),
    backgroundStop: async (p) => { seen.push(p); return { ok: true, outcome: 'stopped' }; },
  };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'background' }), api), { ok: true, items: [] });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'background-stop', port: 7718 }), api), { ok: true, outcome: 'stopped' });
  for (const port of [undefined, 0, 65536, 1.5, '7718']) {
    assert.deepStrictEqual(await probeCmd(line({ cmd: 'background-stop', port }), api),
      { ok: false, error: 'background-stop needs a port' }, String(port));
  }
  assert.deepStrictEqual(seen, [7718]);
});

test('handleProbeCommand: Open from the ▾ list, by port (a real port only)', async () => {
  const seen = [];
  const api = { backgroundOpen: async (p) => { seen.push(p); return { ok: true, pid: 5 }; } };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'background-open', port: 7718 }), api), { ok: true, pid: 5 });
  for (const port of [undefined, 0, 65536, 1.5, '7718']) {
    assert.deepStrictEqual(await probeCmd(line({ cmd: 'background-open', port }), api),
      { ok: false, error: 'background-open needs a port' }, String(port));
  }
  assert.deepStrictEqual(seen, [7718]);
});

test('handleProbeCommand: Stop all in this project, from the ▾ list (Windowless PR 3)', async () => {
  let asked = 0;
  const api = { backgroundStopAll: async () => { asked += 1; return { ok: true, ports: [7718] }; } };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'background-stop-all' }), api), { ok: true, ports: [7718] });
  assert.strictEqual(asked, 1);
});

test('handleProbeCommand: key is dispatched with its name, and needs one', async () => {
  const seen = [];
  const api = { key: async (k, m) => { seen.push([k, m]); return { ok: true }; } };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'key', key: 'Tab', modifiers: ['control'] }), api), { ok: true });
  assert.deepStrictEqual(seen, [['Tab', ['control']]]);
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'key' }), api), { ok: false, error: 'key needs a key' });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'key', key: 'Tab', modifiers: 'control' }), api),
    { ok: false, error: 'key modifiers must be a list' });
});

// --- Miguel, PR #75 M4: the probe driver answers only the probe -------------------

test('M4: a line without the token, or with another one, is refused and runs nothing', async () => {
  const calls = [];
  const api = { state: async () => { calls.push('state'); return {}; }, quit: async () => { calls.push('quit'); return { ok: true }; } };
  assert.deepStrictEqual(await probeCmd('{"cmd":"quit"}', api), { ok: false, error: 'bad token' });
  assert.deepStrictEqual(await probeCmd(JSON.stringify({ cmd: 'quit', token: 'guess' }), api), { ok: false, error: 'bad token' });
  assert.deepStrictEqual(await probeCmd(JSON.stringify({ cmd: 'quit', token: PT + 'x' }), api), { ok: false, error: 'bad token' });
  assert.deepStrictEqual(await probeCmd(JSON.stringify({ cmd: 'quit', token: 7 }), api), { ok: false, error: 'bad token' });
  assert.deepStrictEqual(calls, []);
});

test('M4: a driver started without a real token refuses everything, even a line that carries one', async () => {
  const api = { quit: async () => ({ ok: true }) };
  for (const expected of [undefined, null, '', 'short']) {
    assert.deepStrictEqual(await handleProbeCommand(JSON.stringify({ cmd: 'quit', token: expected }), api, expected),
      { ok: false, error: 'probe driver has no token' }, String(expected));
  }
});

test('M4: screenshot writes only a .png', async () => {
  const api = { screenshot: async (f) => ({ ok: true, file: f }) };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'screenshot', file: 'C:\\Windows\\win.ini' }), api),
    { ok: false, error: 'screenshot needs a .png file' });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'screenshot', file: 'shot.PNG' }), api), { ok: true, file: 'shot.PNG' });
});

test('M4: the line reader splits on newlines and gives up on a line longer than its cap', () => {
  const r = probeLineReader(16);
  assert.deepStrictEqual(r.push('ab\ncd'), { lines: ['ab'], overflow: false });
  assert.deepStrictEqual(r.push('e\n\n'), { lines: ['cde'], overflow: false }, 'blank lines are dropped');
  assert.deepStrictEqual(r.push('x'.repeat(17)), { lines: [], overflow: true });
  const r2 = probeLineReader(16);
  assert.deepStrictEqual(r2.push('0123456789'), { lines: [], overflow: false });
  assert.deepStrictEqual(r2.push('0123456789'), { lines: [], overflow: true }, 'the cap counts what is buffered across chunks');
});

// --- keyboard shortcuts (no menu bar, so main owns them) -------------------------

const kd = (key, mods = {}) => ({ type: 'keyDown', key, control: false, shift: false, alt: false, meta: false, ...mods });

test('shortcutFor: Ctrl+Tab and Ctrl+Shift+Tab cycle tabs', () => {
  assert.strictEqual(shortcutFor(kd('Tab', { control: true })), 'next-tab');
  assert.strictEqual(shortcutFor(kd('Tab', { control: true, shift: true })), 'prev-tab');
});

test('shortcutFor: F12 and Ctrl+Shift+I (either case) toggle DevTools', () => {
  assert.strictEqual(shortcutFor(kd('F12')), 'devtools');
  assert.strictEqual(shortcutFor(kd('I', { control: true, shift: true })), 'devtools');
  assert.strictEqual(shortcutFor(kd('i', { control: true, shift: true })), 'devtools');
});

test('shortcutFor: everything the terminal owns is left alone', () => {
  for (const [key, mods] of [
    ['c', { control: true }], ['v', { control: true }], ['Enter', { shift: true }],
    ['Tab', {}], ['Tab', { shift: true }], ['r', { control: true }], ['R', { control: true, shift: true }],
    ['i', { control: true }], ['i', { shift: true }], ['Tab', { control: true, alt: true }],
  ]) assert.strictEqual(shortcutFor(kd(key, mods)), null, `${key} ${JSON.stringify(mods)}`);
});

test('shortcutFor: only a keyDown counts, so a key cannot fire twice', () => {
  assert.strictEqual(shortcutFor({ ...kd('Tab', { control: true }), type: 'keyUp' }), null);
  assert.strictEqual(shortcutFor({ ...kd('F12'), type: 'keyUp' }), null);
  assert.strictEqual(shortcutFor({ ...kd('F12'), type: 'char' }), null);
});

test('shortcutFor: garbage in is null, never a throw', () => {
  for (const bad of [null, undefined, 5, 'x', {}, { type: 'keyDown' }, { type: 'keyDown', key: 7 }]) {
    assert.strictEqual(shortcutFor(bad), null);
  }
});

test('shortcutFor: Ctrl+Shift+T (either case) reopens the last closed tab, like a browser; nothing near it does', () => {
  assert.strictEqual(shortcutFor(kd('T', { control: true, shift: true })), 'reopen-tab');
  assert.strictEqual(shortcutFor(kd('t', { control: true, shift: true })), 'reopen-tab');
  assert.strictEqual(shortcutFor(kd('T', { control: true, shift: true, alt: true })), null);
  assert.strictEqual(shortcutFor(kd('T', { shift: true })), null);
  assert.strictEqual(shortcutFor({ ...kd('T', { control: true, shift: true }), type: 'keyUp' }), null);
});

// --- PR 3: the branch form keeps the keyboard ------------------------------------

test('focusStep: while the branch form is open, the keyboard stays with the strip', () => {
  const v = { id: 'v' };
  assert.deepStrictEqual(focusStep(null, { windowFocused: true, selectedView: v, stripBusy: true }),
    { focus: false, lastFocused: null });
  assert.deepStrictEqual(focusStep(v, { windowFocused: true, selectedView: v, stripBusy: true }),
    { focus: false, lastFocused: null }, 'so the view is focused again once the form closes');
  assert.deepStrictEqual(focusStep(null, { windowFocused: true, selectedView: v, stripBusy: false }),
    { focus: true, lastFocused: v });
});

test('handleProbeCommand: create, reopen and cancelCreate reach the driver; create needs a branch', async () => {
  const seen = [];
  const api = {
    create: async (b) => { seen.push(['create', b]); return { ok: true }; },
    reopen: async () => { seen.push(['reopen']); return { ok: true }; },
    cancelCreate: async () => { seen.push(['cancel']); return { ok: true }; },
  };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'create', branch: 'feat/demo' }), api), { ok: true });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'reopen' }), api), { ok: true });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'cancelCreate' }), api), { ok: true });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'create' }), api), { ok: false, error: 'create needs a branch' });
  assert.deepStrictEqual(seen, [['create', 'feat/demo'], ['reopen'], ['cancel']]);
});

test('handleProbeCommand: mark reaches the driver with a branch and an id (null clears)', async () => {
  const seen = [];
  const api = { mark: async (b, id) => { seen.push([b, id]); return { ok: true }; } };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'mark', branch: 'develop', id: 'star' }), api), { ok: true });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'mark', branch: 'develop', id: null }), api), { ok: true });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'mark', id: 'star' }), api), { ok: false, error: 'mark needs a branch' });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'mark', branch: 'develop' }), api),
    { ok: false, error: 'mark needs an id (or null)' });
  assert.deepStrictEqual(seen, [['develop', 'star'], ['develop', null]]);
});

test('handleProbeCommand: windowFocus is the window coming back to the front (#31 probe)', async () => {
  const api = { windowFocus: async () => ({ ok: true, looked: true }) };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'windowFocus' }), api), { ok: true, looked: true });
});

test('handleProbeCommand: markMenu builds the real menu for a branch (Dexter #87 F2)', async () => {
  const api = { markMenu: async (b) => ({ ok: true, branch: b }) };
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'markMenu', branch: 'develop' }), api), { ok: true, branch: 'develop' });
  assert.deepStrictEqual(await probeCmd(line({ cmd: 'markMenu' }), api), { ok: false, error: 'markMenu needs a branch' });
});

// --- properties ----------------------------------------------------------------

test('PROPERTY: an input with no control/meta and a key other than F12 is never intercepted', () => {
  fc.assert(fc.property(
    fc.string(), fc.boolean(), fc.boolean(), fc.constantFrom('keyDown', 'keyUp', 'char'), fc.boolean(),
    (key, shift, alt, type, isAutoRepeat) => {
      fc.pre(key.toLowerCase() !== 'f12');
      assert.strictEqual(shortcutFor({ type, key, shift, alt, control: false, meta: false, isAutoRepeat }), null);
    }));
});

test('PROPERTY: spawns are serialised -- tabs that hash to one port never both get it', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 2, max: 6 }),
    fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 6, maxLength: 6 }),
    async (n, delays) => {
      const occupied = new Map();          // port -> cwd
      const granted = [];
      const names = Array.from({ length: n }, (_, i) => `t${i}`);
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const shell = createShell({
        mode: 'tabs', container: ROOT, log: () => {},
        git: { list: async () => porcelain([['dev', 'develop'], ...names.map(x => [x, `feat/${x}`])]), marker: noMarker },
        ops: NO_OPS,
        hosts: {
          // Every tab "hashes" to 7700; the walk is resolvePort's.
          choosePort: async (tab) => {
            await sleep(delays[0]);
            for (let p = 7700; p < 7800; p++) {
              const occ = occupied.get(p);
              if (occ === undefined) return { port: p, action: 'spawn' };
              if (normPath(occ) === tab.key) return { port: p, action: 'attach' };
            }
            return null;
          },
          probe: async (p) => (occupied.has(p) ? 'listening' : 'refused'),
          spawn: ({ tab, port }) => { granted.push(port); setTimeout(() => occupied.set(port, tab.cwd), delays[1]); },
          wait: async (port) => { await sleep(delays[2] + 3); return occupied.has(port); },
          tokenFor: () => 't', tokenFile: () => 't', newToken: () => 't',
          control: async () => ({ ok: true }), identity: () => null, readToken: () => null,
        },
        views: { create: () => ({}), destroy: () => {}, send: () => {}, owns: () => false },
        ui: { confirmClose: async () => true, changed: () => {}, focusWindow: () => {}, isFocused: () => true },
      });
      await shell.open();
      await sleep(40);
      // Start every tab at once.
      await Promise.all(names.map(x => shell.select(normPath(wt(x)))));
      const ports = [...shell._tabs.values()].filter(t => t.started).map(t => t.port);
      return new Set(ports).size === ports.length && new Set(granted).size === granted.length;
    }), { numRuns: 25 });
});

test('PROPERTY: listening is false only for a started, not-starting tab whose port refused', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({
      started: fc.boolean(), starting: fc.boolean(), port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: null }),
      answer: fc.constantFrom('listening', 'refused', 'unknown', undefined, 'throw'),
    }), { maxLength: 8 }),
    async (specs) => {
      const tabs = specs.map((s, i) => ({ key: `k${i}`, ...s }));
      const answers = new Map(tabs.map(t => [t.port, t.answer]));
      const out = await captureListening(tabs, async (p) => {
        const a = answers.get(p);
        if (a === 'throw') throw new Error('boom');
        return a;
      });
      for (const [k, v] of Object.entries(out)) {
        const t = tabs.find(x => x.key === k);
        if (!t.started || t.starting || t.port === null) return false;
        if (v === false && answers.get(t.port) !== 'refused') return false;
        if (v === true && answers.get(t.port) !== 'listening') return false;
      }
      return true;
    }), { numRuns: 200 });
});

test('PROPERTY: a poll with no dev keeps every tab, whatever git lists', async () => {
  await fc.assert(fc.asyncProperty(
    fc.subarray(['feat-a', 'feat-b', 'feat-c', 'other'], { maxLength: 4 }),
    async (names) => {
      const h = harness();
      await h.shell.open();
      await flush();
      const before = labels(h);
      h.listText = porcelain(names.map(x => [x, `feat/${x}`]));
      await h.shell.poll();
      const noStop = h.controls.length === 0;
      return noStop && JSON.stringify(labels(h)) === JSON.stringify(before);
    }), { numRuns: 20 });
});

test('shortcutFor: Ctrl+Alt+T opens New branch…; plain Ctrl+T stays the CLI task-list key (#35)', () => {
  assert.strictEqual(shortcutFor(kd('t', { control: true, alt: true })), 'new-branch');
  assert.strictEqual(shortcutFor(kd('T', { control: true, alt: true })), 'new-branch');
  assert.strictEqual(shortcutFor(kd('t', { control: true })), null, 'Ctrl+T toggles the task list of the CLI');
  assert.strictEqual(shortcutFor(kd('t', { control: true, shift: true, alt: true })), null);
  assert.strictEqual(shortcutFor(kd('t', { alt: true })), null);
  assert.strictEqual(shortcutFor(kd('t', {})), null, 'a plain t is typed');
  assert.strictEqual(shortcutFor({ ...kd('t', { control: true, alt: true }), type: 'keyUp' }), null);
});

test('shortcutWillAct: New branch… claims its key only when the form will open (#35)', async () => {
  const tabs = harness();
  await tabs.shell.open();
  assert.strictEqual(shortcutWillAct('new-branch', tabs.shell), true);
  tabs.available = { create: false, setup: false, remove: false };
  assert.strictEqual(shortcutWillAct('new-branch', tabs.shell), false, 'scripts missing: the key reaches the terminal');
  tabs.available = { create: true, setup: true, remove: true };
  const gate = new Promise(() => {});
  tabs.createResult = () => gate;
  tabs.shell.createWorktree('feat/x');
  await flush();
  assert.strictEqual(shortcutWillAct('new-branch', tabs.shell), false, 'a creation is running');
  const single = harness({ mode: 'single' });
  await single.shell.open();
  assert.strictEqual(shortcutWillAct('new-branch', single.shell), false, 'single mode');
  for (const a of ['next-tab', 'prev-tab', 'reopen-tab', 'focus-mode', 'devtools']) {
    assert.strictEqual(shortcutWillAct(a, single.shell), true, `${a} is always the app's`);
  }
});

test('openCreate follows the + menu\'s greyed-out rule: no scripts, no form (#35)', async () => {
  const h = harness();
  await h.shell.open();
  h.available = { create: false, setup: false, remove: false };
  assert.strictEqual(h.shell.openCreate(), false);
  assert.strictEqual(h.shell.snapshot().create, null);
  h.available = { create: true, setup: true, remove: true };
  assert.strictEqual(h.shell.openCreate(), true);
  const single = harness({ mode: 'single' });
  await single.shell.open();
  assert.strictEqual(single.shell.openCreate(), false);
  assert.strictEqual(single.shell.snapshot().create, null);
});

test('shortcutFor: Ctrl+Shift+F (either case) is focus mode; plain Ctrl+F and Alt stay the terminal\'s', () => {
  // Layout pass L1, #1. Main's, so it works from any tab view and never reaches the pty.
  assert.strictEqual(shortcutFor(kd('F', { control: true, shift: true })), 'focus-mode');
  assert.strictEqual(shortcutFor(kd('f', { control: true, shift: true })), 'focus-mode');
  assert.strictEqual(shortcutFor(kd('f', { control: true })), null);
  assert.strictEqual(shortcutFor(kd('f', { control: true, shift: true, alt: true })), null);
  assert.strictEqual(shortcutFor({ ...kd('f', { control: true, shift: true }), type: 'keyUp' }), null);
});

// --- #40 tab marks ---------------------------------------------------------------

test('each strip entry carries its branch\'s mark, null when it has none', async () => {
  const M = { id: 'waiting', emoji: 'W', meaning: 'Waiting on a merge' };
  const h = harness({ marks: { markFor: b => (b === 'feat/a' ? M : null) } });
  await h.shell.open();
  const byLabel = Object.fromEntries(h.shell.snapshot().model.map(e => [e.label, e.mark]));
  assert.deepStrictEqual(byLabel, { develop: null, 'feat/a': M, 'feat/b': null });
});

test('no marks reader: every mark is null', async () => {
  const h = harness();
  await h.shell.open();
  assert.ok(h.shell.model().every(e => e.mark === null));
});

test('a marks reader that throws draws no mark and never breaks the strip', async () => {
  const h = harness({ marks: { markFor: () => { throw new Error('boom'); } } });
  await h.shell.open();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  assert.ok(h.shell.model().every(e => e.mark === null));
});

test('a tab whose worktree switched branch shows, and offers, the NEW branch\'s mark (Dexter #87 F1)', async () => {
  const M = { id: 'urgent', emoji: 'U', meaning: 'Urgent / do next' };
  const h = harness({ marks: { markFor: b => (b === 'feat/a' ? M : null) } });
  await h.shell.open();
  assert.deepStrictEqual(h.shell.model().find(e => e.key === key('feat-a')).mark, M);
  assert.strictEqual(h.shell.branchOf(key('feat-a')), 'feat/a');
  // `git switch feat/c` in that worktree.
  h.listText = porcelain([['dev', 'develop'], ['feat-a', 'feat/c'], ['feat-b', 'feat/b']]);
  await h.shell.poll();
  const e = h.shell.model().find(x => x.key === key('feat-a'));
  assert.strictEqual(e.label, 'feat/c');
  assert.strictEqual(e.mark, null, 'feat/c has no mark; feat/a\'s must not follow the folder');
  assert.strictEqual(h.shell.branchOf(key('feat-a')), 'feat/c', 'the Mark menu writes to the branch on the label');
  assert.strictEqual(h.shell.branchOf('nope'), null);
});

test('refresh publishes a new snapshot (a mark was set)', async () => {
  let M = null;
  const h = harness({ marks: { markFor: b => (b === 'develop' ? M : null) } });
  await h.shell.open();
  const before = h.changes.length;
  M = { id: 'star', emoji: 'S', meaning: 'Favourite / keep an eye on' };
  h.shell.refresh();
  assert.strictEqual(h.changes.length, before + 1);
  assert.deepStrictEqual(h.changes.at(-1).model.find(e => e.label === 'develop').mark, M);
});
