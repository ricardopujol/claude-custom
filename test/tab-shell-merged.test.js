'use strict';
/**
 * BACKLOG #139: a merged tab closes by itself (Ricardo, 2026-11-05: "they should close when merge automatically").
 *
 * A branch tab whose PR is merged and that is safe to close (#77's rule: merged, nothing uncommitted or unpushed, no agent,
 * no unsaved reader edit; plus an idle host and an empty CLI box) closes by itself, with "Closed <lane> (merged)" on the
 * strip's notice line and the lane in the Lanes menu's closed rows, whose click is the Undo. An unsafe one is looked at again
 * on the next poll. Every effect is a recording fake (test/tab-shell.test.js has the long form of this harness).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fc = require('fast-check');

const { createShell } = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');
const { alertFor } = require('../app/tab-strip');
const chatViewState = require('../app/chat-view-state');
const { sideKeyOf } = require('../host/side-session');
const { shellKeyOf } = require('../host/shell-tab');

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-merged');
const wt = (name) => path.join(ROOT, name);
const key = (name) => normPath(wt(name));
const porcelain = (entries) => entries.map(([name, branch]) =>
  `worktree ${wt(name).replace(/\\/g, '/')}\nHEAD 0123456789012345678901234567890123456789\n` +
  (branch ? `branch refs/heads/${branch}\n` : 'detached\n')).join('\n') + '\n';

const THREE = [['dev', 'develop'], ['feat-a', 'feat/a'], ['feat-b', 'feat/b']];
const settle = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 8; i++) await settle(); };

const GIT_OK = { branch: 'feat/a', dirtyCount: 0, unpushedCount: 0, headInDevelop: true };
const AT_REST = { working: false, needsInput: false, lock: 'held', turn: 'idle' };

function harness({ running = { 7700: wt('dev'), 7701: wt('feat-a') }, markers = {}, launchedFrom = null, layout = null } = {}) {
  const h = {
    running: { ...running }, markers: { ...markers }, spawns: [], controls: [], confirms: [], removes: [], logs: [],
    listText: porcelain(THREE), facts: { ...GIT_OK }, unsaved: null, agents: 0, boxClear: true, boxAsks: 0,
    controlReply: null, pidReply: null, keepListening: false,
  };
  const base = 7700;
  const tokenOf = (port) => (h.running[port] === undefined ? null : `tok-${port}`);
  const deps = {
    mode: 'tabs', container: ROOT, cwd: wt('dev'), launchedFrom, log: (...a) => h.logs.push(a.join(' ')),
    git: {
      list: async () => { await settle(); return h.listText; },
      marker: (p, branch) => (h.markers[normPath(p)] === branch ? { branch, pr: 1, mergedAt: '2026-11-05T00:00:00Z' } : null),
    },
    ops: {
      available: () => ({ create: false, setup: false, remove: true }),
      create: async () => ({ ok: false, error: 'no' }), setup: async () => ({ ok: false, error: 'no' }),
      // `removeWait`: a promise that holds Contract C open, as a real `git worktree remove` takes seconds
      remove: async ({ path: p }) => { h.removes.push(normPath(p)); if (h.removeWait) await h.removeWait; return { ok: true }; },
    },
    hosts: {
      choosePort: async (tab) => {
        let free = null;
        for (let p = base; p < base + 50; p++) {
          const occ = h.running[p];
          if (occ === undefined) { if (free === null) free = p; continue; }
          if (normPath(occ) === tab.key) return { port: p, action: 'attach' };
        }
        return free === null ? null : { port: free, action: 'spawn' };
      },
      // `onProbe(port)`: a test's hook into a probe (a poll fired during a stop's wait); an answer it gives wins
      probe: async (port) => {
        const hooked = typeof h.onProbe === 'function' ? await h.onProbe(port) : undefined;
        if (hooked !== undefined) return hooked;
        return h.running[port] !== undefined ? 'listening' : 'refused';
      },
      spawn: ({ tab, port }) => { h.spawns.push(tab.key); h.running[port] = tab.cwd; },
      wait: async () => true,
      tokenFor: tokenOf, tokenFile: tokenOf, newToken: () => 'fresh',
      control: async (c) => {
        h.controls.push(c);
        if (h.controlReply) return h.controlReply(c);
        if (c.msg.type === 'stop') delete h.running[c.port];
        return { ok: true, reply: null };
      },
      stopByPid: async () => (h.pidReply ? h.pidReply() : 'killed'),
      identity: () => null, readToken: () => null,
    },
    views: {
      create: (tab) => ({ tab: tab.key }), destroy: () => {}, owns: (tab, sender) => tab.view === sender,
      // The page's own answer to "is your CLI box at rest?": true / false, or (undefined) no answer at all.
      send: (tab, channel, payload) => {
        if (channel !== 'box-state') return;
        h.boxAsks++;
        // `boxFor(view)`: a page-by-page answer (a side page's box apart from its branch page's); else every page says `boxClear`
        const clear = typeof h.boxFor === 'function' ? h.boxFor(tab.view) : h.boxClear;
        if (clear !== undefined) h.shell.boxAnswered(tab.view, { id: payload.id, clear });
      },
    },
    ui: {
      confirmClose: async (tab, opts) => { h.confirms.push([tab.key, opts || null]); return true; },
      changed: () => {}, focusWindow: () => {}, isFocused: () => true,
    },
    safety: {
      facts: async () => { h.factReads = (h.factReads || 0) + 1; if (h.onFacts) h.onFacts(h.factReads); return { ...h.facts }; },
      readerUnsaved: () => h.unsaved,
    },
    occupancy: { claims: () => (h.agents > 0 ? [{ agentId: 'a1', agent: 'builder', worktree: wt('feat-a'), lastAt: 0 }] : []), known: () => true },
    sleep: async () => {},
  };
  if (layout) deps.layout = layout;
  h.shell = createShell(deps);
  h.report = (name, status) => { const t = h.shell.tabByKey(key(name)); if (t && t.view) h.shell.report(t.view, status); };
  // `_mergedPass` is the closes the poll started; a build without it (develop before #139) just has none to wait for.
  h.pass = () => (typeof h.shell._mergedPass === 'function' ? h.shell._mergedPass() : undefined);
  h.poll = async () => { await h.shell.poll(); await h.pass(); await flush(); };
  h.stops = () => h.controls.filter(c => c.msg.type === 'stop');
  return h;
}

/** feat-a running (attached), at rest; the window has polled once and seen it live. Then its PR merges. */
async function liveThenMerged(opts) {
  const h = harness(opts);
  await h.shell.open();
  await flush();
  h.report('feat-a', AT_REST);
  h.markers[key('feat-a')] = 'feat/a';
  return h;
}

const strip = (h) => h.shell.snapshot().strip.map(e => e.key);
const mergedRows = (h) => h.shell.snapshot().lanes.merged;

// --- the rows the brief names --------------------------------------------------------------------

test('#139: merged and safe -> closed by itself: its host stopped, the notice, an Undo row; nothing asked, nothing removed', async () => {
  const h = await liveThenMerged();
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null, 'closed');
  assert.deepStrictEqual(h.stops(), [{ port: 7701, token: 'tok-7701', msg: { type: 'stop' } }], 'its host ended through the hand-close path');
  assert.deepStrictEqual(h.confirms, [], 'nothing asked');
  assert.deepStrictEqual(h.removes, [], "the folder isn't removed by this path (the reaper's, or /merged --sweep)");
  const snap = h.shell.snapshot();
  assert.strictEqual(snap.mergedNotice, 'Closed feat/a (merged)');
  assert.deepStrictEqual(alertFor({ ...snap, model: snap.strip }), { text: 'Closed feat/a (merged)', kind: 'info' });
  assert.deepStrictEqual(mergedRows(h), [{ key: key('feat-a'), label: 'feat/a', state: 'closed · Undo', closed: true, undo: true }]);
  const row = h.shell.lanesMenu([]).find(r => r.key === key('feat-a'));
  assert.deepStrictEqual({ action: row.action, state: row.state, shortcut: row.shortcut }, { action: 'reopen', state: 'closed · Undo', shortcut: 'Ctrl+Shift+T' });
  assert.deepStrictEqual(strip(h), [key('dev')]);
});

test('#139: the notice goes with the next selection', async () => {
  const h = await liveThenMerged();
  await h.poll();
  await h.shell.select(key('dev'));
  assert.strictEqual(h.shell.snapshot().mergedNotice, null);
});

test('#139: a selected tab, being looked at, is still closed when safe; its neighbour is selected', async () => {
  const h = await liveThenMerged();
  await h.shell.select(key('feat-a'));
  await flush();
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  assert.strictEqual(h.shell.snapshot().selectedKey, key('dev'));
  assert.strictEqual(h.shell.snapshot().mergedNotice, 'Closed feat/a (merged)', 'the selection the close made does not wipe its notice');
});

test('#139: merged with an unsaved reader edit -> kept; closed on a later poll once it is saved', async () => {
  const h = await liveThenMerged();
  h.unsaved = 'app/x.js';
  await h.poll();
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')), 'kept');
  assert.deepStrictEqual(h.stops(), []);
  assert.strictEqual(h.logs.filter(l => /merged, kept open: the file reader has unsaved edits to app\/x\.js/.test(l)).length, 1, 'said once, not every poll');
  h.unsaved = null;
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
});

test('#139: merged with a turn running -> kept (never mid-turn); closed on a later poll once idle', async () => {
  const h = await liveThenMerged();
  h.report('feat-a', { ...AT_REST, working: true, turn: 'turn' });
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')));
  h.report('feat-a', { ...AT_REST, needsInput: true, turn: 'prompt' });
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')), 'a dialog waiting for you keeps it too');
  assert.deepStrictEqual(h.stops(), []);
  h.report('feat-a', AT_REST);
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
});

test('#139: a turn that starts while the safe check reads git keeps it (the check is re-read before the stop)', async () => {
  const h = await liveThenMerged();
  // The second read of git's facts is the re-check right before the stop: a turn starts while it runs.
  h.onFacts = (n) => { if (n === 2) h.report('feat-a', { ...AT_REST, working: true, turn: 'turn' }); };
  await h.poll();
  assert.strictEqual(h.factReads, 2, 'read once to decide, once more right before the stop');
  assert.ok(h.shell.tabByKey(key('feat-a')), 'kept');
  assert.deepStrictEqual(h.stops(), []);
});

test('#139: merged but the CLI box holds a draft, or the page does not answer -> kept', async () => {
  const h = await liveThenMerged();
  h.boxClear = false;
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')));
  h.boxClear = undefined;
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')));
  assert.ok(h.boxAsks >= 2, 'the page was asked each time');
  assert.deepStrictEqual(h.stops(), []);
  h.boxClear = true;
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
});

test('#139: merged but uncommitted, unpushed, an agent here, or HEAD past the merge -> kept', async () => {
  for (const [name, set] of [
    ['dirty', (h) => { h.facts = { ...GIT_OK, dirtyCount: 1 }; }],
    ['unpushed', (h) => { h.facts = { ...GIT_OK, unpushedCount: 2 }; }],
    ['agent', (h) => { h.agents = 1; }],
    ['after the merge', (h) => { h.facts = { ...GIT_OK, headInDevelop: false }; }],
    ['git can\'t say', (h) => { h.facts = { ...GIT_OK, dirtyCount: null }; }],
  ]) {
    const h = await liveThenMerged();
    set(h);
    await h.poll();
    assert.ok(h.shell.tabByKey(key('feat-a')), name);
    assert.deepStrictEqual(h.stops(), [], name);
  }
});

// --- PR #236 Dexter 1: the close ends the lane's side session and shell too, so they are judged too -----

const SIDE_KEY = () => sideKeyOf(key('feat-a'));
const SHELL_KEY = () => shellKeyOf(key('feat-a'));
const reportSide = (h, status) => { const s = h.shell.tabByKey(SIDE_KEY()); h.shell.report(s.view, status); };

test('#139 P1: a side session in a turn, asking, or not reported keeps the lane; at rest, the lane closes and the side goes with it', async () => {
  const h = await liveThenMerged();
  await h.shell.openSide(key('feat-a'));
  await flush();
  const side = h.shell.tabByKey(SIDE_KEY());
  assert.ok(side && side.started, 'the side session runs');
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')), 'kept: the side session has not said what it is doing');
  reportSide(h, { ...AT_REST, lock: 'unlocked', working: true, turn: 'turn' });
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')), 'kept: the side session is answering');
  reportSide(h, { ...AT_REST, lock: 'unlocked', needsInput: true, turn: 'prompt' });
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')), 'kept: the side session is asking');
  assert.deepStrictEqual(h.stops(), [], 'nothing stopped, the side least of all');
  assert.ok(h.logs.some(l => /merged, kept open: its side session is working/.test(l)));
  reportSide(h, { ...AT_REST, lock: 'unlocked' });
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null, 'both at rest: closed');
  assert.strictEqual(h.shell.tabByKey(SIDE_KEY()), null, 'its side went with it');
});

test('#139 P1: a side session whose box holds a draft keeps the lane', async () => {
  const h = await liveThenMerged();
  await h.shell.openSide(key('feat-a'));
  await flush();
  reportSide(h, { ...AT_REST, lock: 'unlocked' });
  // the fake page answers per tab: the branch page's box is empty, the side page's isn't
  const send = h.shell.tabByKey(SIDE_KEY()).view;
  h.boxFor = (view) => (view === send ? false : true);
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')));
  assert.deepStrictEqual(h.stops(), []);
  assert.ok(h.logs.some(l => /its side session's input box holds text/.test(l)));
});

test('#139 P1: an open shell tab keeps the lane whatever it reports (nothing proves a shell idle)', async () => {
  const h = await liveThenMerged();
  await h.shell.openShell(key('feat-a'));
  await flush();
  assert.ok(h.shell.tabByKey(SHELL_KEY()), 'the shell tab is open');
  for (let i = 0; i < 3; i++) await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')));
  assert.deepStrictEqual(h.stops(), []);
  assert.ok(h.logs.some(l => /its shell tab is open/.test(l)));
  await h.shell.closeTab(SHELL_KEY());
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null, 'the shell closed: the lane closes');
});

test('#139 P1: a lane session in a night run (/bedtime) keeps the lane, idle between ticks or not', async () => {
  const h = await liveThenMerged();
  h.report('feat-a', { ...AT_REST, night: true });
  await h.poll();
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')));
  assert.deepStrictEqual(h.stops(), []);
  h.report('feat-a', AT_REST);
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
});

test('#139 P1: a side session that ended (its claude exited) does not keep the lane', async () => {
  const h = await liveThenMerged();
  await h.shell.openSide(key('feat-a'));
  await flush();
  h.shell.tabByKey(SIDE_KEY()).ended = true;
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
});

test('#139: merged, the stop fails -> kept with the Stop offer; later polls never try again (no loop)', async () => {
  const h = await liveThenMerged();
  h.controlReply = () => ({ ok: false, error: 'refused' });
  h.pidReply = () => 'unknown';
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')), 'kept');
  assert.strictEqual(h.shell.snapshot().closeStuck.key, key('feat-a'), 'the Stop offer');
  assert.strictEqual(h.shell.snapshot().mergedNotice, null);
  const sent = h.stops().length;
  assert.strictEqual(sent, 1);
  for (let i = 0; i < 4; i++) await h.poll();
  assert.strictEqual(h.stops().length, sent, 'no second try by this path');
  // the person's Stop still works
  h.controlReply = null;
  assert.deepStrictEqual(await h.shell.closeTab(key('feat-a'), { stop: true }), { ok: true });
});

test('#139 P4: a poll during the stop\'s wait that moves the tab to removing owns it: Contract C runs, and the close writes no closed row', async () => {
  const g = await liveThenMerged();
  // The stop goes in but its reply is lost (the 3 s control timeout), so the close waits in goesQuiet; the host exits meanwhile.
  g.controlReply = (c) => (c.msg.type === 'stop' ? { ok: false, error: 'timed out after 3000 ms' } : { ok: true, reply: null });
  let waits = 0;
  g.onProbe = async (port) => {
    if (port !== 7701 || g.inPoll || g.stops().length === 0) return undefined;     // only goesQuiet's looks, after the stop went
    waits++;
    if (waits !== 1) return undefined;
    // goesQuiet's first look: the host has just exited, and the 3 s poll lands before goesQuiet looks again
    delete g.running[7701];
    g.inPoll = true;
    await g.shell.poll();
    g.inPoll = false;
    return 'listening';     // goesQuiet saw it a moment before it went
  };
  let release;
  g.removeWait = new Promise((r) => { release = r; });
  await g.poll();
  await flush();
  assert.deepStrictEqual(g.removes, [key('feat-a')], 'the poll moved it to removing: Contract C runs');
  // While the folder is being removed: no closed row (no Undo, no Ctrl+Shift+T target) and no Stop offer
  assert.deepStrictEqual(mergedRows(g).filter(r => r.key === key('feat-a') && r.closed), [], 'no closed row for a folder being removed');
  assert.ok(!g.shell.lanesMenu([]).some(r => r.key === key('feat-a') && r.action === 'reopen'), 'nothing to reopen');
  assert.strictEqual(g.shell.snapshot().closeStuck, null, 'no Stop offer either');
  release();
  await flush();
  assert.strictEqual(g.shell.tabByKey(key('feat-a')), null, 'removeResult closed it');
  assert.ok(!g.shell.lanesMenu([]).some(r => r.key === key('feat-a') && r.action === 'reopen'), 'and still nothing to reopen');
});

test('#139: not merged -> never closed by this path, however many polls', async () => {
  const h = harness();
  await h.shell.open();
  await flush();
  h.report('feat-a', AT_REST);
  for (let i = 0; i < 5; i++) await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')));
  assert.deepStrictEqual(h.stops(), []);
  assert.strictEqual(h.boxAsks, 0, 'not even asked');
});

test('#139: develop is never closed by this path', async () => {
  const h = await liveThenMerged();
  h.markers[key('dev')] = 'develop';       // even a marker on develop (observeWorktrees never reads one there)
  h.report('dev', AT_REST);
  await h.poll();
  assert.ok(h.shell.tabByKey(key('dev')));
  assert.deepStrictEqual(await h.shell.closeTab(key('dev'), { auto: true }), { ok: false, error: 'not closable' });
  assert.ok(!h.stops().some(c => c.port === 7700));
});

test('#139: two polls in a row close it once', async () => {
  const h = await liveThenMerged();
  await Promise.all([h.shell.poll(), h.shell.poll()]);
  await h.shell.poll();
  await h.pass();
  await flush();
  await h.poll();
  assert.strictEqual(h.stops().length, 1);
  assert.strictEqual(h.shell.lanesMenu([]).filter(r => r.key === key('feat-a')).length, 1, 'one closed row');
});

// --- the edges around it --------------------------------------------------------------------------

test('#139: the Undo (its row) reopens the lane, and the merged close leaves it alone from then on', async () => {
  const h = await liveThenMerged();
  await h.poll();
  h.running[7701] = wt('feat-a');       // its host as the reopen will find it (a fresh session in the real app)
  assert.deepStrictEqual(await h.shell.reopen(key('feat-a')), { ok: true });
  await flush();
  h.report('feat-a', AT_REST);
  for (let i = 0; i < 3; i++) await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')), 'still open: the person asked for it');
  assert.strictEqual(h.stops().length, 1, 'only the first close');
});

// PR #236 Dexter 3: every kind of closed row, every way of reopening it. (A `merged: false` row is also what an Undo row becomes once
// an older build rewrites the file without `merged`.)
for (const [how, entryMerged, doReopen] of [
  ['its closed row (a hand close, merged: false)', false, (h) => h.shell.reopen(key('feat-a'))],
  ['Ctrl+Shift+T (a hand close, merged: false)', false, (h) => h.shell.reopen()],
  ['the Undo row (merged: true)', true, (h) => h.shell.reopen(key('feat-a'))],
]) {
  test(`#139 P3: a merged lane reopened from ${how} is never closed again by itself`, async () => {
    const closed = [{ key: key('feat-a'), path: wt('feat-a'), branch: 'feat/a', ...(entryMerged ? { merged: true } : {}) }];
    const layout = { load: () => ({ order: [], closed, error: null }), save: () => ({ ok: true }) };
    const h = harness({ running: { 7700: wt('dev') }, markers: { [key('feat-a')]: 'feat/a' }, layout });
    await h.shell.open();
    await flush();
    assert.deepStrictEqual(await doReopen(h), { ok: true });
    await flush();
    const t = h.shell.tabByKey(key('feat-a'));
    assert.ok(t && t.started, 'a fresh session came up');
    h.report('feat-a', AT_REST);
    for (let i = 0; i < 3; i++) await h.poll();
    assert.ok(h.shell.tabByKey(key('feat-a')), 'still open: the person asked for it');
    assert.deepStrictEqual(h.stops(), []);
  });
}

test('#139 P3: a lane reopened BEFORE its merge is still closed by the merged close once it merges while open', async () => {
  const closed = [{ key: key('feat-a'), path: wt('feat-a'), branch: 'feat/a' }];
  const layout = { load: () => ({ order: [], closed, error: null }), save: () => ({ ok: true }) };
  const h = harness({ running: { 7700: wt('dev') }, layout });
  await h.shell.open();
  await flush();
  await h.shell.reopen(key('feat-a'));
  await flush();
  h.report('feat-a', AT_REST);
  await h.poll();
  h.markers[key('feat-a')] = 'feat/a';     // its PR merges now, with the tab open
  await h.poll();
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null, 'merged while open: closed');
  assert.strictEqual(h.shell.snapshot().mergedNotice, 'Closed feat/a (merged)');
});

test('#139: a merged lane the person starts from its Merged row is not closed by itself', async () => {
  const h = harness({ running: { 7700: wt('dev') }, markers: { [key('feat-a')]: 'feat/a' } });
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(mergedRows(h).map(r => r.key), [key('feat-a')]);
  await h.shell.select(key('feat-a'));
  await flush();
  h.report('feat-a', AT_REST);
  for (let i = 0; i < 3; i++) await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')).started);
  assert.deepStrictEqual(h.stops(), []);
});

test('#139 startup: a lane merged before the window opened, its host still running, closes when safe with a log line and no notice', async () => {
  const h = harness({ markers: { [key('feat-a')]: 'feat/a' } });
  await h.shell.open();
  await flush();
  h.report('feat-a', AT_REST);
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  assert.strictEqual(h.shell.snapshot().mergedNotice, null, 'no notice: it never had a tab in this window before');
  assert.ok(h.logs.some(l => /merged before this window listed it; closed with no notice/.test(l)));
  assert.deepStrictEqual(mergedRows(h).map(r => [r.key, r.state]), [[key('feat-a'), 'closed · Undo']], 'still reachable');
});

test('#139 startup: a window opened from a merged lane with no session opens on develop, and starts nothing in that folder', async () => {
  const h = harness({ running: { 7700: wt('dev') }, markers: { [key('feat-a')]: 'feat/a' }, launchedFrom: wt('feat-a') });
  await h.shell.open();
  await flush();
  await h.poll();
  assert.strictEqual(h.shell.snapshot().selectedKey, key('dev'));
  assert.deepStrictEqual(h.spawns, []);
  assert.deepStrictEqual(strip(h), [key('dev')], 'no tab for it');
  assert.deepStrictEqual(mergedRows(h).map(r => r.key), [key('feat-a')], 'a Merged row, as before');
});

test('#139: a poll that cannot list the worktrees closes nothing', async () => {
  const h = await liveThenMerged();     // merged and safe: a poll that lists would close it
  h.listText = null;                    // git gave no text: no observation, so no markers this poll
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')));
  assert.deepStrictEqual(h.stops(), []);
  assert.strictEqual(h.boxAsks, 0);
});

test('#139 chat-view-state boxAtRest: only a ready, empty box that nothing is typing into', () => {
  const at = chatViewState.boxAtRest;
  assert.strictEqual(at({ screen: 'ready', box: '' }), true);
  assert.strictEqual(at({ screen: 'ready', box: 'Try "fix the bug"' }), true, "the CLI's own hint is empty");
  assert.strictEqual(at({ screen: 'ready', box: 'half a thought' }), false);
  assert.strictEqual(at({ screen: 'ready', box: '', typing: true }), false);
  assert.strictEqual(at({ screen: 'dialog', box: '' }), false);
  assert.strictEqual(at({ screen: 'multiline', box: '' }), false);
  assert.strictEqual(at({ screen: 'ready', box: null }), false);
  assert.strictEqual(at(), false);
});

test('#139 wiring: the box-state question goes main -> that tab page -> main, gated to tab views, replace-not-accumulate', () => {
  const fs = require('fs');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8');
  const PRELOAD = read('preload.js');
  const JS = read('renderer.js');
  const MAIN = read('main.js');
  assert.match(PRELOAD, /onBoxState: \(fn\) => \(ipcRenderer\.removeAllListeners\('box-state'\), ipcRenderer\.on\('box-state'/);
  assert.match(PRELOAD, /boxState: \(reply\) => ipcRenderer\.send\('tab:boxState', reply\)/);
  const handler = JS.slice(JS.indexOf('window.harness.onBoxState('), JS.indexOf('window.harness.onBoxState(') + 900);
  assert.match(handler, /chatViewState\.boxAtRest\(\{ screen: inputState\(lines, \{ vim: vimSeen \}\), box: boxText\(lines\), typing: typingBusy, drafts \}\)/);
  assert.match(handler, /const drafts = unsentDrafts\(\);/);
  assert.match(handler, /window\.harness\.boxState\(\{ id, clear: clear === true \}\)/);
  const on = MAIN.slice(MAIN.indexOf("ipcMain.on('tab:boxState'"), MAIN.indexOf("ipcMain.on('tab:boxState'") + 200);
  assert.match(on, /if \(!isTabView\(e\.sender\)\) return;/);
  assert.match(on, /tabShell\.boxAnswered\(e\.sender, reply\)/);
});

test('#139 P2 boxAtRest: text in any of the page\'s other unsent inputs (the chat view\'s draft first) is "no"; a list it can\'t read is "no"', () => {
  const at = chatViewState.boxAtRest;
  const rest = { screen: 'ready', box: '' };
  assert.strictEqual(at({ ...rest, drafts: ['a long message, not sent yet', null] }), false, "the chat view's draft");
  assert.strictEqual(at({ ...rest, drafts: [null, '', 'github token'] }), false, 'a half-filled form');
  assert.strictEqual(at({ ...rest, drafts: ['', '   \n', null] }), true, 'blank fields and missing ones are nothing typed');
  assert.strictEqual(at({ ...rest, drafts: [] }), true);
  assert.strictEqual(at({ ...rest, drafts: 'oops' }), false, "a list that isn't a list can't be read");
  assert.strictEqual(at({ ...rest, box: 'draft', drafts: [] }), false, 'the CLI box still counts');
});

test('#139 P2 wiring: the page reads #chat-input and the vault and bug-vault fields, each a real field of the tab page', () => {
  const fs = require('fs');
  const JS = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  const m = /const unsentDrafts = \(\) => \[([^\]]*)\]\.map\(el => \(el \? el\.value : null\)\);/.exec(JS);
  assert.ok(m, 'the list is declared');
  const ids = [...m[1].matchAll(/document\.getElementById\('([^']+)'\)/g)].map(x => x[1]);
  assert.strictEqual(ids[0], 'chat-input');
  for (const id of ['vault-label', 'vault-secret', 'bugvault-category', 'bugvault-summary-input']) assert.ok(ids.includes(id), id);
  for (const id of ids) assert.match(HTML, new RegExp(`<(?:input|textarea)[^>]*id="${id}"`), `${id} is an input of renderer.html`);
});

test('#139 boxAnswered: only the page that was asked, for a question still waiting, counts', async () => {
  const h = await liveThenMerged();
  const a = h.shell.tabByKey(key('feat-a'));
  const dev = h.shell.tabByKey(key('dev'));
  assert.strictEqual(h.shell.boxAnswered(a.view, { id: 999, clear: true }), false, 'no such question');
  assert.strictEqual(h.shell.boxAnswered({ stranger: true }, { id: 1, clear: true }), false, 'not a tab page');
  h.boxClear = undefined;      // the fake page stays quiet; answer by hand, from the wrong page first
  const run = h.poll();
  await settle();
  assert.strictEqual(h.shell.boxAnswered(dev.view, { id: 1, clear: true }), false, "another tab's page can't answer for it");
  await run;
  assert.ok(h.shell.tabByKey(key('feat-a')), 'no answer from its own page: kept');
});

test('#139 strip-layout: a closed lane keeps `merged: true` through the file (so its row is still the Undo after a restart); anything else is dropped', () => {
  const { parseLayout } = require('../host/strip-layout');
  const k = key('feat-a');
  const body = (merged) => JSON.stringify({ version: 1, order: [], closed: [{ key: k, path: wt('feat-a'), branch: 'feat/a', merged }] });
  assert.deepStrictEqual(parseLayout(body(true)).closed, [{ key: k, path: wt('feat-a'), branch: 'feat/a', merged: true }]);
  for (const junk of ['true', 1, false, null, undefined]) {
    assert.deepStrictEqual(parseLayout(body(junk)).closed, [{ key: k, path: wt('feat-a'), branch: 'feat/a' }], String(junk));
  }
});

test('#139: after a restart, a lane the merged close closed is still a Merged row with its Undo', async () => {
  const layout = { load: () => ({ order: [], closed: [{ key: key('feat-a'), path: wt('feat-a'), branch: 'feat/a', merged: true }], error: null }), save: () => ({ ok: true }) };
  const h = harness({ running: { 7700: wt('dev') }, layout });
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(mergedRows(h).map(r => [r.key, r.state, r.undo]), [[key('feat-a'), 'closed · Undo', true]]);
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
});

// --- the invariant --------------------------------------------------------------------------------

/**
 * PROPERTY: this path never closes a tab unless the marker says merged AND the safe check passed on the same poll. Each poll
 * draws its own facts (held for the whole poll and its merged close); the poll in which feat-a's host got its stop must have
 * had the marker and every safe fact. And the other way round: a poll with all of them closes a running, merged tab.
 */
test('#139 PROPERTY: a merged close happens only on a poll whose marker read merged and whose safe check passed, and on the first such poll', async () => {
  const pollArb = fc.record({
    merged: fc.boolean(), dirty: fc.constantFrom(0, 0, 1, null), unpushed: fc.constantFrom(0, 0, 1), inDevelop: fc.constantFrom(true, true, false, null),
    working: fc.boolean(), needs: fc.constantFrom(false, false, true), box: fc.constantFrom(true, true, false, undefined),
    unsaved: fc.constantFrom(null, null, 'x.js'), agents: fc.constantFrom(0, 0, 1),
  });
  await fc.assert(fc.asyncProperty(fc.array(pollArb, { minLength: 1, maxLength: 6 }), async (polls) => {
    const h = harness();
    await h.shell.open();
    await flush();
    let closedOn = -1;
    let everMerged = false;
    for (let i = 0; i < polls.length; i++) {
      const p = polls[i];
      if (p.merged) h.markers[key('feat-a')] = 'feat/a'; else delete h.markers[key('feat-a')];
      h.facts = { branch: 'feat/a', dirtyCount: p.dirty, unpushedCount: p.unpushed, headInDevelop: p.inDevelop };
      h.unsaved = p.unsaved;
      h.agents = p.agents;
      h.boxClear = p.box;
      h.report('feat-a', { ...AT_REST, working: p.working, turn: p.working ? 'turn' : (p.needs ? 'prompt' : 'idle'), needsInput: p.needs });
      const before = h.stops().length;
      await h.poll();
      everMerged = everMerged || p.merged;
      const safe = p.merged && p.dirty === 0 && p.unpushed === 0 && p.inDevelop === true && !p.working && !p.needs
        && p.box === true && p.unsaved === null && p.agents === 0;
      if (h.stops().length > before) {
        assert.strictEqual(closedOn, -1, 'closed twice');
        assert.ok(safe, `stopped on poll ${i} with ${JSON.stringify(p)}`);
        closedOn = i;
      }
      if (closedOn === -1) {
        assert.ok(h.shell.tabByKey(key('feat-a')), `poll ${i}: open until this path closes it`);
        // liveness: once it is merged (finishing), a poll with every fact safe closes it
        assert.ok(!(safe && everMerged), `poll ${i} was safe and merged but kept it`);
      }
    }
    if (closedOn >= 0) assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  }), { numRuns: 120 });
});
