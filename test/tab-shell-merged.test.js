'use strict';
/**
 * BACKLOG #139: a merged tab closes by itself (Ricardo, 2026-11-05: "they should close when merge automatically"; 2026-11-06,
 * on the folder: "B: no Undo").
 *
 * A branch tab whose PR is merged and whose lane is safe (#77's rule: merged, nothing uncommitted or unpushed, no agent, no
 * unsaved reader edit; plus an idle lane and empty input boxes) has its session stopped by itself. That is the merged close's
 * only act: the existing flow then moves it to `removing`, Contract C removes the folder, and the tab closes with
 * "Closed <lane> (merged)" on the strip's notice line. No closed row, no Undo. An unsafe lane is looked at again on a later poll.
 * Every effect is a recording fake (test/tab-shell.test.js has the long form of this harness).
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

// `sleep`: the shell's wait (default: none at all); `'real'` leaves it out, so the shell uses real timers.
function harness({ running = { 7700: wt('dev'), 7701: wt('feat-a') }, markers = {}, launchedFrom = null, layout = null, sleep = async () => {} } = {}) {
  const h = {
    running: { ...running }, markers: { ...markers }, spawns: [], controls: [], confirms: [], removes: [], logs: [], destroyed: [],
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
      // `removeReply()`: what Contract C answers (default: removed)
      remove: async ({ path: p }) => { h.removes.push(normPath(p)); if (h.removeWait) await h.removeWait; return h.removeReply ? h.removeReply() : { ok: true }; },
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
      create: (tab) => ({ tab: tab.key }), destroy: (tab) => { h.destroyed.push(tab.key); }, owns: (tab, sender) => tab.view === sender,
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
      // `factsWait`: a promise that holds git's read open (a slow `git status` on Windows)
      facts: async () => { h.factReads = (h.factReads || 0) + 1; if (h.onFacts) h.onFacts(h.factReads); if (h.factsWait) await h.factsWait; return { ...h.facts }; },
      readerUnsaved: () => h.unsaved,
    },
    occupancy: { claims: () => (h.agents > 0 ? [{ agentId: 'a1', agent: 'builder', worktree: wt('feat-a'), lastAt: 0 }] : []), known: () => true },
  };
  if (sleep !== 'real') deps.sleep = sleep;
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
/** The Lanes menu's closed rows (a hand close's): the merged close never makes one. */
const closedRowsOf = (h) => h.shell.lanesMenu([]).filter(r => r.type === 'row' && r.action === 'reopen');

// --- the rows the brief names --------------------------------------------------------------------

test('#139 (B): merged and safe -> its idle session stopped, nothing asked; the existing removal takes the folder and closes the tab, with the notice; no closed row', async () => {
  const h = await liveThenMerged();
  await h.poll();
  assert.deepStrictEqual(h.stops(), [{ port: 7701, token: 'tok-7701', msg: { type: 'stop' } }], 'its host ended through the hand-close path');
  assert.deepStrictEqual(h.confirms, [], 'nothing asked');
  assert.deepStrictEqual(h.removes, [key('feat-a')], 'Contract C, through the reducer\'s finishing -> removing, as when a person ends the session');
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null, "removeResult closed it");
  const snap = h.shell.snapshot();
  assert.strictEqual(snap.mergedNotice, 'Closed feat/a (merged)');
  assert.deepStrictEqual(alertFor({ ...snap, model: snap.strip }), { text: 'Closed feat/a (merged)', kind: 'info' });
  assert.deepStrictEqual(closedRowsOf(h), [], 'no closed row, no Undo, nothing for Ctrl+Shift+T');
  assert.deepStrictEqual(mergedRows(h), [], 'no Merged row either: the folder is gone');
  assert.deepStrictEqual(strip(h), [key('dev')]);
});

test('#139 (B): the merged close never calls closeByHand and writes nothing to the saved layout', async () => {
  const saves = [];
  const layout = { load: () => ({ order: [], closed: [], error: null }), save: (v) => { saves.push(JSON.parse(JSON.stringify(v))); return { ok: true }; } };
  const h = await liveThenMerged({ layout });
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  assert.ok(saves.every(s => s.closed.length === 0), `no closed entry saved: ${JSON.stringify(saves)}`);
  assert.deepStrictEqual(closedRowsOf(h), []);
});

test('#167 P7: the merged close ignores a pin, and the pin goes in the same save as the close', async () => {
  const saves = [];
  const layout = { load: () => ({ order: [], closed: [], pinned: [key('feat-a'), key('feat-b')], error: null }), save: (v) => { saves.push(JSON.parse(JSON.stringify(v))); return { ok: true }; } };
  const h = await liveThenMerged({ layout });
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null, 'a pinned lane that merged is closed all the same');
  assert.ok(saves.length > 0, 'the pin change was saved');
  assert.deepStrictEqual(saves[saves.length - 1].pinned, [key('feat-b')], 'only the merged lane lost its pin');
  assert.deepStrictEqual(saves[saves.length - 1].closed, [], 'and no closed entry came with it');
});

for (const [what, reply, phase] of [
  ['keeping the folder (the branch still has a brief)', { ok: false, kept: true, reason: 'the branch still has a handoff brief' }, 'kept'],
  ['failing', { ok: false, error: 'git worktree remove failed' }, 'remove-failed'],
]) {
  test(`#139 (B): Contract C ${what} leaves the tab as that flow does, and this path never stops it again`, async () => {
    const h = await liveThenMerged();
    h.removeReply = () => reply;
    await h.poll();
    assert.deepStrictEqual(h.removes, [key('feat-a')]);
    assert.ok(h.shell.tabByKey(key('feat-a')), 'the tab stays');
    assert.strictEqual(h.shell._state().tabs.find(t => normPath(t.path) === key('feat-a')).phase, phase);
    assert.strictEqual(h.shell.snapshot().mergedNotice, null, 'it did not close: no notice');
    for (let i = 0; i < 4; i++) await h.poll();
    assert.strictEqual(h.stops().length, 1, 'one stop, no loop');
    assert.deepStrictEqual(h.removes, [key('feat-a')], 'one removal: the flow retries nothing by itself');
  });
}

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

test('#139 P6 A: the box is asked AFTER git\'s reads: a draft typed while git is read keeps it', async () => {
  const h = await liveThenMerged();
  // The second git read is the re-check right before the stop; the person starts typing while it runs.
  h.onFacts = (n) => { if (n === 2) h.boxClear = false; };
  await h.poll();
  assert.strictEqual(h.factReads, 2);
  assert.ok(h.shell.tabByKey(key('feat-a')), 'kept');
  assert.deepStrictEqual(h.stops(), []);
});

/** feat-a merged and safe; its stop's reply is lost, so the close waits (goesQuiet) while `during()` happens; the host then goes. */
async function stopThatWaits(during) {
  const h = await liveThenMerged();
  h.controlReply = (c) => (c.msg.type === 'stop' ? { ok: false, error: 'timed out after 3000 ms' } : { ok: true, reply: null });
  let looks = 0;
  h.onProbe = async (port) => {
    if (port !== 7701 || h.stops().length === 0) return undefined;     // only goesQuiet's looks, after the stop went
    looks++;
    if (looks !== 1) return undefined;
    during(h);
    delete h.running[7701];     // the host goes; goesQuiet's next look sees it refuse
    return 'listening';
  };
  await h.poll();
  await flush();
  return h;
}

test('#139 (B): a stop whose reply is lost waits for the host to go, then the removal follows: one stop, one removal, the notice, no closed row', async () => {
  const h = await stopThatWaits(() => {});
  assert.strictEqual(h.stops().length, 1, 'the stop went once');
  assert.deepStrictEqual(h.removes, [key('feat-a')]);
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  assert.strictEqual(h.shell.snapshot().mergedNotice, 'Closed feat/a (merged)');
  assert.deepStrictEqual(closedRowsOf(h), []);
  assert.strictEqual(h.shell.snapshot().closeStuck, null, 'no Stop offer: the host went');
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

// --- PR #236 Dexter 12 / Miguel Y2: a merged lane git keeps isn't read every 3 s for ever -----------------

test('#139 P7: after git says no, its reads back off: polls 1, 3, 6, 11, 20, 37 of 40 read git, and no page is asked', async () => {
  const h = await liveThenMerged();
  h.facts = { ...GIT_OK, headInDevelop: false };     // a commit after the merge: git keeps it, and nothing else will change that soon
  const readOn = [];
  for (let i = 1; i <= 40; i++) {
    const before = h.factReads || 0;
    await h.poll();
    if ((h.factReads || 0) > before) readOn.push(i);
  }
  assert.deepStrictEqual(readOn, [1, 3, 6, 11, 20, 37], 'skips of 1, 2, 4, 8, 16, then 16 (the cap)');
  assert.strictEqual(h.boxAsks, 0, 'git said no first: no page is asked');
  assert.ok(h.shell.tabByKey(key('feat-a')));
  assert.strictEqual(h.logs.filter(l => /merged, kept open: /.test(l)).length, 1, 'said once');
});

test('#139 P7: a selection, a status change or a companion closing looks again at once', async () => {
  for (const [what, poke] of [
    ['a selection', (h) => h.shell.select(key('feat-a'))],
    ['a status change (a turn that ended)', (h) => h.report('feat-a', { ...AT_REST, messages: 3 })],
    ['its side session closing', async (h) => { await h.shell.openSide(key('feat-a')); await flush(); await h.shell.closeTab(SIDE_KEY()); }],
  ]) {
    const h = await liveThenMerged();
    h.facts = { ...GIT_OK, dirtyCount: 1 };
    await h.poll();                       // read 1: kept, backs off one poll
    await h.poll();                       // skipped
    await h.poll();                       // read 2: kept, backs off two
    const reads = h.factReads;
    await h.poll();                       // skipped
    assert.strictEqual(h.factReads, reads, `${what}: backing off`);
    h.facts = { ...GIT_OK };              // the person committed and the file is clean now
    await poke(h);
    await flush();
    await h.poll();
    assert.ok(h.factReads > reads, `${what}: read again at once`);
    assert.strictEqual(h.shell.tabByKey(key('feat-a')), null, `${what}: and closed`);
  }
});

test('#139 P7: a refusal that isn\'t git\'s (a turn, a draft) backs nothing off: the next poll looks again', async () => {
  const h = await liveThenMerged();
  h.boxClear = false;
  await h.poll();
  h.boxClear = true;
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
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
  await g.poll();
  assert.strictEqual(g.shell.tabByKey(key('feat-a')), null, 'removeResult closed it');
  assert.ok(!g.shell.lanesMenu([]).some(r => r.key === key('feat-a') && r.action === 'reopen'), 'and still nothing to reopen');
  assert.deepStrictEqual(g.removes, [key('feat-a')], 'one removal');
  assert.strictEqual(g.shell.snapshot().mergedNotice, 'Closed feat/a (merged)', 'one notice');
  assert.strictEqual(g.stops().length, 1);
});

test('#139 P11: an x clicked during a merged check that keeps the tab ends in the normal hand close once the check is over', async () => {
  const h = await liveThenMerged();
  h.facts = { ...GIT_OK, dirtyCount: 1 };  // the merged check will keep it, on git's slow read
  let release;
  h.factsWait = new Promise((r) => { release = r; });
  const polled = h.shell.poll();
  await flush();
  assert.strictEqual(h.factReads, 1, 'the merged check is reading git');
  const x = h.shell.closeTab(key('feat-a'));     // the person's x, mid-check
  await flush();
  assert.deepStrictEqual(h.confirms, [], 'it waits for the check rather than racing it');
  h.factsWait = null;
  release();
  await polled;
  await h.pass();
  assert.deepStrictEqual(await x, { ok: true }, 'not dropped as "already closing"');
  assert.deepStrictEqual(h.confirms.map(c => c[0]), [key('feat-a')], 'the hand close asked its question, as any x does');
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  assert.deepStrictEqual(mergedRows(h).filter(r => r.key === key('feat-a')), [], 'a hand close: a plain closed row, not the Undo');
  assert.strictEqual(h.shell.snapshot().mergedNotice, null);
});

test('#139 P11: an x clicked during a merged check that then closes the tab is answered by that close, nothing asked', async () => {
  const h = await liveThenMerged();
  let release;
  h.factsWait = new Promise((r) => { release = r; });
  const polled = h.shell.poll();
  await flush();
  const x = h.shell.closeTab(key('feat-a'));
  h.factsWait = null;
  release();
  await polled;
  await h.pass();
  assert.deepStrictEqual(await x, { ok: true });
  assert.deepStrictEqual(h.confirms, []);
  assert.strictEqual(h.stops().length, 1, 'one close, one stop');
  assert.strictEqual(h.shell.snapshot().mergedNotice, 'Closed feat/a (merged)');
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

test('#139 P9: a second real poll while the first one\'s close is in flight starts no second close', async () => {
  const h = await liveThenMerged();
  // The stop is held open, so the first poll's close is still in flight when the second poll runs all the way through.
  let release;
  const held = new Promise((r) => { release = r; });
  h.controlReply = async (c) => { if (c.msg.type === 'stop') { await held; delete h.running[c.port]; } return { ok: true, reply: null }; };
  await h.shell.poll();                     // poll 1 returns; its merged close waits on the stop
  await flush();
  assert.strictEqual(h.stops().length, 1, 'the first close sent its stop');
  const firstPass = h.pass();
  await h.shell.poll();                     // poll 2: a real one, not one that returned at once on `polling`
  await flush();
  assert.ok((h.factReads || 0) <= 2, 'poll 2 read nothing for it (one close at a time)');
  assert.strictEqual(h.stops().length, 1, 'and sent no second stop');
  release();
  await firstPass;
  await flush();
  await h.poll();
  assert.strictEqual(h.stops().length, 1);
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  assert.deepStrictEqual(h.removes, [key('feat-a')], 'one removal');
  assert.deepStrictEqual(closedRowsOf(h), [], 'no closed row');
});

test('#139 (B): a stopped lane is never stopped again, though its tab waits for the next poll to move to removing', async () => {
  const h = await liveThenMerged();
  // The host takes the stop and goes, but the next poll's probe can't tell yet ('unknown'): the reducer can't move it, and the
  // lane sits stopped. Polls go on; this path doesn't stop it again.
  h.onProbe = async (port) => (port === 7701 && h.stops().length > 0 ? 'unknown' : undefined);
  for (let i = 0; i < 4; i++) await h.poll();
  assert.strictEqual(h.stops().length, 1);
  assert.deepStrictEqual(h.removes, []);
  h.onProbe = null;
  await h.poll();
  assert.deepStrictEqual(h.removes, [key('feat-a')], 'once a poll sees it refuse, the removal runs');
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
});

test('#139 P9: a failed merged close is tried once per record, even after a selection takes its Stop offer away', async () => {
  const h = await liveThenMerged();
  h.controlReply = () => ({ ok: false, error: 'refused' });
  h.pidReply = () => 'unknown';
  await h.poll();
  assert.ok(h.shell.snapshot().closeStuck, 'kept with the Stop offer');
  await h.shell.select(key('feat-a'));      // looked at again: the Stop offer goes (PR #231 Dexter M1), so only mergedTried holds it
  await flush();
  assert.strictEqual(h.shell.snapshot().closeStuck, null);
  for (let i = 0; i < 4; i++) await h.poll();
  assert.strictEqual(h.stops().length, 1, 'no second try by this path');
  assert.ok(h.shell.tabByKey(key('feat-a')));
});

// --- the edges around it --------------------------------------------------------------------------

// PR #236 Dexter 3: a lane closed by hand (before or after its merge), reopened while its folder exists, every way of reopening it.
// An earlier build of this PR saved `merged: true` on such rows; that flag is ignored now, and the row reopens the same way.
for (const [how, entryMerged, doReopen] of [
  ['its closed row (a hand close)', false, (h) => h.shell.reopen(key('feat-a'))],
  ['Ctrl+Shift+T (a hand close)', false, (h) => h.shell.reopen()],
  ['a closed row an earlier build saved with merged: true (ignored)', true, (h) => h.shell.reopen(key('feat-a'))],
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

test('#139 startup (P5): a lane merged before the window opened, its host still running, is drawn, so its close when safe gets the notice', async () => {
  const h = harness({ markers: { [key('feat-a')]: 'feat/a' } });
  await h.shell.open();
  await flush();
  assert.ok(strip(h).includes(key('feat-a')), 'its session runs: it is drawn on the strip (1B)');
  h.report('feat-a', AT_REST);
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  assert.strictEqual(h.shell.snapshot().mergedNotice, 'Closed feat/a (merged)', 'it had a tab in this window: the notice');
  assert.deepStrictEqual(h.removes, [key('feat-a')]);
});

test('#139 P5: a merged lane whose session the PERSON ended is removed by the same flow and gets the same notice', async () => {
  const h = await liveThenMerged();
  h.boxClear = false;                       // the merged close keeps it (a draft) ...
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')));
  delete h.running[7701];                   // ... and the person ends the session themselves (/exit)
  await h.poll();
  assert.deepStrictEqual(h.stops(), [], 'this path stopped nothing');
  assert.deepStrictEqual(h.removes, [key('feat-a')]);
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  assert.strictEqual(h.shell.snapshot().mergedNotice, 'Closed feat/a (merged)');
});

test('#139 startup: a window opened from a merged lane with no session opens on develop, and starts nothing in that folder', async () => {
  const h = harness({ running: { 7700: wt('dev') }, markers: { [key('feat-a')]: 'feat/a' }, launchedFrom: wt('feat-a') });
  await h.shell.open();
  await flush();
  await h.poll();
  assert.strictEqual(h.shell.snapshot().selectedKey, key('dev'));
  assert.deepStrictEqual(h.spawns, []);
  assert.deepStrictEqual(strip(h), [key('dev')], 'no tab for it');
  assert.strictEqual(h.shell.snapshot().mergedNotice, null, 'it never had a tab here: no notice (the default built), a log line only');
  assert.ok(h.logs.some(l => /merged; the window doesn't open on it/.test(l)));
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
  assert.match(handler, /clear = chatViewState\.boxAtRest\(\{ screen: inputState\(lines, \{ vim: vimSeen \}\), box: boxText\(lines\), typing: typingBusy, drafts \}\)/);
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

test('#139 P16 G5: destroy() answers a question a page never answered ("no answer": kept), so no merged check hangs on it', async () => {
  const h = await liveThenMerged({ sleep: () => new Promise(() => {}) });     // a wait that never ends: only destroy can settle it
  h.boxClear = undefined;                                                    // the page stays quiet
  h.shell.poll();
  await flush();
  assert.strictEqual(h.boxAsks, 1, 'the merged check is waiting on the page');
  h.shell.destroy();
  const settled = await Promise.race([h.pass().then(() => 'settled'), new Promise(r => setTimeout(() => r('hung'), 1000))]);
  assert.strictEqual(settled, 'settled');
  assert.ok(h.shell.tabByKey(key('feat-a')), 'no answer: kept');
  assert.deepStrictEqual(h.stops(), []);
});

test('#139 P16 G5: with real timers, an answered question leaves no timer running', async () => {
  const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  const h = await liveThenMerged({ sleep: 'real' });
  const before = timers();
  await h.poll();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')), null, 'closed (both questions answered at once)');
  assert.ok(h.boxAsks >= 2);
  assert.strictEqual(timers(), before, 'the two 2 s waits were cleared, not left to run out');
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

test('#139 (B) strip-layout: `merged` on a closed entry (an earlier build of this PR wrote it) is read without throwing and dropped', () => {
  const { parseLayout } = require('../host/strip-layout');
  const k = key('feat-a');
  const body = (merged) => JSON.stringify({ version: 1, order: [], closed: [{ key: k, path: wt('feat-a'), branch: 'feat/a', merged }] });
  for (const any of [true, 'true', 1, false, null, undefined]) {
    assert.deepStrictEqual(parseLayout(body(any)).closed, [{ key: k, path: wt('feat-a'), branch: 'feat/a' }], String(any));
  }
});

test('#139 (B): after a restart, an old file\'s `merged: true` closed entry is a plain closed row (no Undo, no Merged row), merged marker or not', async () => {
  for (const markers of [{ [key('feat-a')]: 'feat/a' }, {}]) {
    const layout = { load: () => ({ order: [], closed: [{ key: key('feat-a'), path: wt('feat-a'), branch: 'feat/a', merged: true }], error: null }), save: () => ({ ok: true }) };
    const h = harness({ running: { 7700: wt('dev') }, layout, markers });
    await h.shell.open();
    await flush();
    const row = h.shell.lanesMenu([]).find(r => r.key === key('feat-a'));
    assert.deepStrictEqual({ state: row.state, action: row.action }, { state: 'closed', action: 'reopen' }, 'a closed row, as any hand close');
    assert.deepStrictEqual(mergedRows(h).filter(r => r.key === key('feat-a')), []);
    assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  }
});

// --- the invariant --------------------------------------------------------------------------------

/**
 * PROPERTY: this path never closes a tab unless the marker says merged AND the safe check passed on the same poll. Each poll
 * draws its own facts (held for the whole poll and its merged close); the poll in which feat-a's host got its stop must have
 * had the marker and every safe fact. And the other way round: a poll with all of them closes a running, merged tab.
 */
test('#139 PROPERTY: a merged close happens only on a poll whose marker read merged and whose safe check passed, and on the first such poll', async () => {
  // A fact that flips WHILE one of the poll's git reads runs (PR #236 Dexter 14, Miguel G8): read 1 is the decision's, read 2 the
  // re-check's right before the stop. Whatever flips, that poll must not stop the host.
  const flipArb = fc.option(fc.record({ read: fc.constantFrom(1, 2), what: fc.constantFrom('box', 'turn', 'reader', 'agent', 'side') }), { nil: null });
  const anyPollArb = fc.record({
    merged: fc.boolean(), dirty: fc.constantFrom(0, 0, 1, null), unpushed: fc.constantFrom(0, 0, 1), inDevelop: fc.constantFrom(true, true, false, null),
    working: fc.boolean(), needs: fc.constantFrom(false, false, true), box: fc.constantFrom(true, true, false, undefined),
    unsaved: fc.constantFrom(null, null, 'x.js'), agents: fc.constantFrom(0, 0, 1), flip: flipArb,
  });
  // Half the polls start from every fact safe (drawn freely, under 1% of polls would be), so the flips and the liveness are reached.
  const safePollArb = flipArb.map(flip => ({
    merged: true, dirty: 0, unpushed: 0, inDevelop: true, working: false, needs: false, box: true, unsaved: null, agents: 0, flip,
  }));
  const pollArb = fc.oneof(anyPollArb, safePollArb);
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(pollArb, { minLength: 1, maxLength: 6 }), async (withSide, polls) => {
    const h = harness();
    await h.shell.open();
    await flush();
    if (withSide) { await h.shell.openSide(key('feat-a')); await flush(); }     // a companion the close would end too
    let closedOn = -1;
    let everMerged = false;
    let gitBackedOff = false;     // a poll ended in a refusal of git's: later polls may skip git's reads (P7)
    for (let i = 0; i < polls.length; i++) {
      const p = polls[i];
      if (p.merged) h.markers[key('feat-a')] = 'feat/a'; else delete h.markers[key('feat-a')];
      h.facts = { branch: 'feat/a', dirtyCount: p.dirty, unpushedCount: p.unpushed, headInDevelop: p.inDevelop };
      h.unsaved = p.unsaved;
      h.agents = p.agents;
      h.boxClear = p.box;
      h.report('feat-a', { ...AT_REST, working: p.working, turn: p.working ? 'turn' : (p.needs ? 'prompt' : 'idle'), needsInput: p.needs });
      if (withSide && h.shell.tabByKey(SIDE_KEY())) reportSide(h, { ...AT_REST, lock: 'unlocked' });
      const readsBefore = h.factReads || 0;
      const flips = p.flip !== null && (p.flip.what !== 'side' || withSide);
      h.onFacts = (n) => {
        if (!flips || n - readsBefore !== p.flip.read) return;
        if (p.flip.what === 'box') h.boxClear = false;
        else if (p.flip.what === 'turn') h.report('feat-a', { ...AT_REST, working: true, turn: 'turn' });
        else if (p.flip.what === 'reader') h.unsaved = 'y.js';
        else if (p.flip.what === 'agent') h.agents = 1;
        else reportSide(h, { ...AT_REST, lock: 'unlocked', working: true, turn: 'turn' });
      };
      const before = h.stops().length;
      await h.poll();
      everMerged = everMerged || p.merged;
      const cheapOk = !p.working && !p.needs && p.unsaved === null && p.agents === 0;
      const gitOk = p.dirty === 0 && p.unpushed === 0 && p.inDevelop === true;
      // a safe poll's check reads git twice (decision, re-check), so its flip always lands, and makes the poll unsafe
      const safe = p.merged && gitOk && cheapOk && p.box === true && !flips;
      if (h.stops().length > before) {
        assert.strictEqual(closedOn, -1, 'closed twice');
        assert.ok(safe, `stopped on poll ${i} with ${JSON.stringify(p)}`);
        closedOn = i;
      }
      if (closedOn === -1) {
        assert.ok(h.shell.tabByKey(key('feat-a')), `poll ${i}: open until this path closes it`);
        // liveness: once it is merged (finishing), a poll with every fact safe closes it -- unless git's reads are backing off
        // after a refusal of git's on an earlier poll (P7: that poll isn't read; its schedule is pinned by its own test)
        if (h.factReads > readsBefore || !gitBackedOff) assert.ok(!(safe && everMerged), `poll ${i} was safe and merged but kept it`);
      }
      if (p.merged && cheapOk && !gitOk) gitBackedOff = true;
    }
    if (closedOn >= 0) assert.strictEqual(h.shell.tabByKey(key('feat-a')), null);
  }), { numRuns: 120 });
});

test('Dexter 3 (#167 P7): when the merged close KEEPS the folder (the branch still has a brief), the pin is dropped too', async () => {
  const saves = [];
  const layout = { load: () => ({ order: [], closed: [], pinned: [key('feat-a')], error: null }), save: (v) => { saves.push(JSON.parse(JSON.stringify(v))); return { ok: true }; } };
  const h = await liveThenMerged({ layout });
  h.removeReply = () => ({ ok: false, kept: true, reason: 'the branch still has a handoff brief' });
  await h.poll();
  assert.ok(h.shell.tabByKey(key('feat-a')), 'the tab stays (the folder is kept)');
  assert.deepStrictEqual(saves[saves.length - 1].pinned, [], 'but the lane is merged: its pin is gone, so the next launch does not start it again');
});
