'use strict';
/**
 * BACKLOG #81: the standing read-only side session, in the tab shell (app/tab-shell.js). A tab's menu opens a second
 * real `claude` in the same folder (the host is told it is a side host: plan mode, no session lock); it sits as a small
 * tab right after its branch's tab, stays until that tab closes, and can be reopened from the same menu once it has
 * stopped. It is a reader: it never counts as an agent working in the folder.
 *
 * Every effect is a recording fake, as in test/tab-shell.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createShell, handleProbeCommand } = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');
const { sideKeyOf } = require('../host/side-session');

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-side');
const wt = (name) => path.join(ROOT, name);
const key = (name) => normPath(wt(name));
const skey = (name) => sideKeyOf(key(name));

const porcelain = (entries) => entries.map(([name, branch]) =>
  `worktree ${wt(name).replace(/\\/g, '/')}\nHEAD 0123456789012345678901234567890123456789\n` +
  (branch ? `branch refs/heads/${branch}\n` : 'detached\n')).join('\n') + '\n';
const THREE = [['dev', 'develop'], ['feat-a', 'feat/a'], ['feat-b', 'feat/b']];

const NO_OPS = {
  available: () => ({ create: false, setup: false, remove: false }),
  create: async () => ({ ok: false, error: 'no' }), setup: async () => ({ ok: false, error: 'no' }),
  remove: async () => ({ ok: false, error: 'no' }),
};

const settle = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await settle(); };

/** running: port -> { cwd, side } of a live host. */
function harness({ mode = 'tabs', running = {}, occupancy, safety, listSideHosts = true, sideHostsSeam } = {}) {
  const h = {
    running: { ...running }, spawns: [], controls: [], viewsMade: [], viewsGone: [], sent: [], changes: [],
    confirms: [], confirm: true, tokens: 0, markers: {}, clock: 1_000_000_000, listText: porcelain(THREE),
    order: [], holdSide: null, removeHold: null, sideWalks: 0, sideHostReads: 0, controlOk: true,
  };
  const base = 7700;
  const tokenOf = (port) => (h.running[port] === undefined ? null : `tok-${port}`);
  const deps = {
    mode, container: ROOT, cwd: wt('dev'), launchedFrom: null, log: () => {},
    git: {
      list: async () => h.listText,
      marker: (p, branch) => (h.markers[normPath(p)] === branch ? { branch, pr: 1, mergedAt: '2026-10-09T00:00:00Z' } : null),
    },
    ops: {
      ...NO_OPS,
      remove: async () => { h.order.push('remove'); if (h.removeHold) await h.removeHold; return { ok: true }; },
    },
    hosts: {
      choosePort: async (tab) => {
        if (tab.side === true) { h.sideWalks++; if (h.holdSide) await h.holdSide; }
        let free = null;
        for (let p = base; p < base + 50; p++) {
          const occ = h.running[p];
          if (occ === undefined) { if (free === null) free = p; continue; }
          if (normPath(occ.cwd) === normPath(tab.cwd) && (occ.side === true) === (tab.side === true)) return { port: p, action: 'attach' };
        }
        return free === null ? null : { port: free, action: 'spawn' };
      },
      probe: async (port) => (h.running[port] !== undefined ? 'listening' : 'refused'),
      spawn: ({ tab, port, token }) => {
        h.spawns.push({ key: tab.key, port, token, side: tab.side === true, cwd: tab.cwd });
        h.running[port] = { cwd: tab.cwd, side: tab.side === true };
      },
      wait: async () => true,
      tokenFor: tokenOf,
      tokenFile: tokenOf,
      newToken: () => `fresh-${++h.tokens}`,
      control: async (c) => {
        h.controls.push(c);
        if (c.msg.type === 'stop') { h.order.push(`stop:${c.port}`); if (h.controlOk) delete h.running[c.port]; }
        return h.controlOk ? { ok: true, reply: null } : { ok: false, error: 'no answer' };
      },
      sideHosts: () => {
        h.sideHostReads++;
        return Object.entries(h.running).filter(([, o]) => o.side === true).map(([p, o]) => ({ port: Number(p), cwd: o.cwd }));
      },
      shellHosts: () => [],      // #119 A5: no shell host anywhere, so no shell walk
      identity: () => null,
      readToken: () => null,
    },
    views: {
      create: (tab) => { const v = { tab: tab.key, id: h.viewsMade.length }; h.viewsMade.push(v); return v; },
      destroy: (tab) => h.viewsGone.push(tab.key),
      send: (tab, channel, payload) => { h.sent.push([tab.key, channel, payload]); },
      owns: (tab, sender) => tab.view === sender,
    },
    ui: {
      confirmClose: async (tab, opts) => { h.confirms.push(opts || null); return h.confirm; },
      changed: (snap) => h.changes.push(snap),
      focusWindow: () => {},
      isFocused: () => true,
    },
    now: () => h.clock,
    sleep: async () => {},
  };
  if (!listSideHosts) delete deps.hosts.sideHosts;
  if (sideHostsSeam) deps.hosts.sideHosts = sideHostsSeam;
  if (occupancy !== undefined) deps.occupancy = occupancy;
  if (safety !== undefined) deps.safety = safety;
  h.shell = createShell(deps);
  return h;
}

const labels = (h) => h.shell.model().map(e => e.label);
const keys = (h) => h.shell.model().map(e => e.key);
const SIDE_A = 'feat/a · side';
const dev = (side) => ({ cwd: wt('dev'), side });
const featA = (side) => ({ cwd: wt('feat-a'), side });

async function opened(over = {}) {
  const h = harness({ running: { 7700: dev(false), 7701: featA(false) }, ...over });
  await h.shell.open();
  await flush();
  return h;
}

// --- opening it -----------------------------------------------------------------------------------------------

test('Open side session spawns a SECOND host for the same folder, told it is a side host, on its own port', async () => {
  const h = await opened();
  const r = await h.shell.openSide(key('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.spawns, [{ key: skey('feat-a'), port: 7702, token: 'fresh-1', side: true, cwd: wt('feat-a') }]);
  assert.strictEqual(h.running[7701].side, false, 'the branch tab\'s own host is untouched');
});

test('the side tab sits right after its branch tab, labelled "<branch> · side", is selected, and has a page', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SIDE_A, 'feat/b']);
  const side = h.shell.model().find(e => e.label === SIDE_A);
  assert.strictEqual(side.key, skey('feat-a'));
  assert.strictEqual(side.side, true);
  assert.strictEqual(side.parentKey, key('feat-a'));
  assert.strictEqual(side.role, 'reader');
  assert.strictEqual(side.selected, true);
  assert.strictEqual(side.started, true);
  assert.strictEqual(side.closable, true, 'it has a close of its own (Ricardo\'s look, 2026-10-26: a side tab could not be closed)');
  assert.strictEqual(h.shell.model().filter(e => e.selected).length, 1, 'exactly one tab is selected');
  assert.ok(h.viewsMade.some(v => v.tab === skey('feat-a')));
});

test('opened once: asking again selects the live one, and spawns nothing', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  await h.shell.select(key('feat-b'));
  const again = await h.shell.openSide(key('feat-a'));
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.already, true);
  assert.strictEqual(h.spawns.filter(s => s.side).length, 1, 'one side host, ever');
  assert.strictEqual(h.shell.model().find(e => e.selected).key, skey('feat-a'));
  assert.strictEqual(labels(h).filter(l => l === SIDE_A).length, 1);
});

test('the develop tab can have a side session too', async () => {
  const h = await opened();
  assert.strictEqual((await h.shell.openSide(key('dev'))).ok, true);
  assert.deepStrictEqual(labels(h), ['develop', 'develop · side', 'feat/a', 'feat/b']);
});

test('refused: a single-folder window, a tab that is not there, a side tab\'s own side, and a worktree still being set up', async () => {
  const single = harness({ mode: 'single', running: { 7700: dev(false) } });
  await single.shell.open();
  assert.strictEqual((await single.shell.openSide(key('dev'))).ok, false);

  const h = await opened();
  assert.strictEqual((await h.shell.openSide(key('ghost'))).ok, false);
  assert.strictEqual((await h.shell.openSide(undefined)).ok, false);
  await h.shell.openSide(key('feat-a'));
  assert.strictEqual((await h.shell.openSide(skey('feat-a'))).ok, false, 'no side of a side');
  assert.strictEqual(h.spawns.length, 1);
});

// --- it stays -------------------------------------------------------------------------------------------------

test('it stays: polls, other selections and a restart of nothing do not close it', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  await h.shell.select(key('feat-b'));
  await h.shell.poll();
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SIDE_A, 'feat/b']);
  assert.deepStrictEqual(h.viewsGone, []);
  assert.strictEqual(h.controls.length, 0, 'nothing was stopped');
});

test('Ctrl+Tab walks through the side tab in strip order', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  await h.shell.select(key('feat-a'));
  await h.shell.next();
  assert.strictEqual(h.shell.model().find(e => e.selected).key, skey('feat-a'));
  await h.shell.next();
  assert.strictEqual(h.shell.model().find(e => e.selected).key, key('feat-b'));
});

// --- closing it by hand (Ricardo's look, 2026-10-26: "when opening a side session, this one can't be closed") -----------

test('closing the side tab by hand stops ITS host only, drops its page, asks nothing, and goes back to its branch tab', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  const r = await h.shell.closeTab(skey('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stopError, undefined);
  assert.deepStrictEqual(h.controls.filter(c => c.msg.type === 'stop').map(c => [c.port, c.token]), [[7702, 'tok-7702']]);
  assert.strictEqual(h.running[7702], undefined, 'the side host is gone');
  assert.ok(h.running[7701], 'the branch tab\'s own session is untouched');
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  assert.ok(h.viewsGone.includes(skey('feat-a')));
  assert.ok(!h.viewsGone.includes(key('feat-a')), 'the branch tab\'s page stays');
  assert.deepStrictEqual(h.confirms, [], 'a reader of the lane closes without a question; the folder stays');
  assert.deepStrictEqual(h.shell.model().filter(e => e.selected).map(e => e.key), [key('feat-a')], 'the lane it belonged to shows next');
});

test('a Ctrl+click close (ifSafe) of the side tab closes it the same way, with no question', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  const r = await h.shell.closeTab(skey('feat-a'), { ifSafe: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.confirms, []);
  assert.deepStrictEqual(h.controls.filter(c => c.msg.type === 'stop').map(c => c.port), [7702]);
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
});

test('closing a side tab that is working asks nothing either: it can write nothing, and the branch tab keeps the work', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  h.shell.tabByKey(skey('feat-a')).status = { working: true };
  const r = await h.shell.closeTab(skey('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.confirms, []);
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
});

test('closing the side tab leaves the branch tab\'s session running, and Open side session starts a fresh one afterwards', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  await h.shell.closeTab(skey('feat-a'));
  assert.ok(h.running[7701], 'the branch tab\'s host still runs');
  assert.deepStrictEqual(h.controls.filter(c => c.msg.type === 'stop').map(c => c.port), [7702], 'only the side host was told to stop');
  assert.deepStrictEqual(h.shell.sideMenu(key('feat-a')), { enabled: true, label: 'Open side session', target: key('feat-a') });
  const again = await h.shell.openSide(key('feat-a'));
  assert.strictEqual(again.ok, true);
  assert.notStrictEqual(again.already, true);
  assert.strictEqual(h.spawns.filter(s => s.side).length, 2, 'a fresh host');
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SIDE_A, 'feat/b']);
  assert.strictEqual(h.shell.model().find(e => e.selected).key, skey('feat-a'));
});

test('closing a side tab that was NOT showing leaves the selection where it was', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  await h.shell.select(key('feat-b'));
  assert.strictEqual((await h.shell.closeTab(skey('feat-a'))).ok, true);
  assert.strictEqual(h.shell.model().find(e => e.selected).key, key('feat-b'));
});

test('the tab menu offers the close on a side tab', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  assert.strictEqual(h.shell.menuState(skey('feat-a')).close, true);
});

test('a side host that does not answer its stop: the tab still goes, and the strip says it may still be running', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  h.controlOk = false;
  const r = await h.shell.closeTab(skey('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stopError, 'no answer');
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  assert.match(h.changes[h.changes.length - 1].closeNotice, /Couldn't end the side session in feat\/a · side: no answer\. It may still be running\./);
});

test('an ended side session closes with no stop sent: its port may be another host\'s by now', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  delete h.running[7702];
  await h.shell.poll();
  const r = await h.shell.closeTab(skey('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.controls.length, 0);
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  assert.strictEqual(h.changes[h.changes.length - 1].closeNotice, null);
});

test('a side session closed while its start is still walking the ports never spawns', async () => {
  const h = await opened();
  let release;
  h.holdSide = new Promise(r => { release = r; });
  const opening = h.shell.openSide(key('feat-a'));
  await flush();
  const closing = h.shell.closeTab(skey('feat-a'));
  await flush();
  release();
  await opening;
  const r = await closing;
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.spawns, [], 'nothing was started for a tab that is gone');
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
});

test('a double click on the side tab\'s close is one close: one stop', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  const [a, b] = await Promise.all([h.shell.closeTab(skey('feat-a')), h.shell.closeTab(skey('feat-a'))]);
  assert.deepStrictEqual([a.ok, b.ok].sort(), [false, true]);
  assert.strictEqual(h.controls.filter(c => c.msg.type === 'stop').length, 1);
});

test('a closed side session is not offered back by the + menu\'s Reopen', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  await h.shell.closeTab(skey('feat-a'));
  assert.deepStrictEqual(h.shell.plusMenu().reopen, []);
});

// --- it ends with its branch tab -------------------------------------------------------------------------------

test('closing the branch tab stops the side host too, closes its page, and selects a real tab', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  const r = await h.shell.closeTab(key('feat-a'));
  assert.strictEqual(r.ok, true);
  await flush();
  const stopped = h.controls.filter(c => c.msg.type === 'stop').map(c => c.port).sort();
  assert.deepStrictEqual(stopped, [7701, 7702]);
  assert.deepStrictEqual(labels(h), ['develop', 'feat/b']);
  assert.ok(h.viewsGone.includes(skey('feat-a')));
  const sel = h.shell.model().filter(e => e.selected);
  assert.strictEqual(sel.length, 1);
  assert.strictEqual(sel[0].side, undefined, 'never a side tab that is gone');
});

test('closing a tab that was NOT showing leaves the selection where it was', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  await h.shell.select(key('feat-b'));
  await h.shell.closeTab(key('feat-a'));
  assert.strictEqual(h.shell.model().find(e => e.selected).key, key('feat-b'));
});

test('closing a branch tab with no side session stops only its own host', async () => {
  const h = await opened();
  await h.shell.closeTab(key('feat-a'));
  assert.deepStrictEqual(h.controls.map(c => c.port), [7701]);
});

test('a worktree git no longer lists takes its side session with it', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  assert.strictEqual(h.shell.model().length, 4);
  h.listText = porcelain([['dev', 'develop'], ['feat-b', 'feat/b']]);
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/b']);
  assert.deepStrictEqual(h.controls.map(c => c.port).sort(), [7701, 7702]);
});

// --- stopped: reopen from the same menu --------------------------------------------------------------------------

test('the menu offers Open, then Go to, then Reopen once the side session has stopped', async () => {
  const h = await opened();
  assert.deepStrictEqual(h.shell.sideMenu(key('feat-a')), { enabled: true, label: 'Open side session', target: key('feat-a') });
  await h.shell.openSide(key('feat-a'));
  assert.deepStrictEqual(h.shell.sideMenu(key('feat-a')), { enabled: true, label: 'Go to side session', target: key('feat-a') });
  delete h.running[7702];            // its claude ended, and the host with it
  await h.shell.poll();
  assert.deepStrictEqual(h.shell.sideMenu(key('feat-a')), { enabled: true, label: 'Reopen side session', target: key('feat-a') });
  assert.deepStrictEqual(h.shell.sideMenu(skey('feat-a')), { enabled: true, label: 'Reopen side session', target: key('feat-a') });
});

test('a stopped side session reopens fresh: a new host, one tab, selected', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  delete h.running[7702];
  await h.shell.poll();
  const r = await h.shell.openSide(key('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(r.already, true);
  assert.strictEqual(h.spawns.length, 2);
  assert.strictEqual(labels(h).filter(l => l === SIDE_A).length, 1);
  assert.strictEqual(h.shell.model().find(e => e.selected).key, skey('feat-a'));
  assert.ok(h.viewsGone.includes(skey('feat-a')), 'the dead one\'s page was dropped');
});

test('the menu is off in a single-folder window, with the reason', async () => {
  const h = harness({ mode: 'single', running: { 7700: dev(false) } });
  await h.shell.open();
  const s = h.shell.sideMenu(key('dev'));
  assert.strictEqual(s.enabled, false);
  assert.ok(s.why.length > 0);
});

test('a side session still running when the window reopens is found again, not lost', async () => {
  const h = harness({ running: { 7700: dev(false), 7701: featA(false), 7702: featA(true) } });
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SIDE_A, 'feat/b']);
  assert.strictEqual(h.spawns.length, 0);
  assert.strictEqual(h.shell.sideMenu(key('feat-a')).label, 'Go to side session');
});

test('a branch tab never picks up the side host as its own, even when the side host answers first', async () => {
  const h = harness({ running: { 7700: dev(false), 7701: featA(true), 7702: featA(false) } });
  await h.shell.open();
  await flush();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')).port, 7702);
  assert.strictEqual(h.shell.tabByKey(skey('feat-a')).port, 7701);
});

// --- a reader: never "an agent working here" -----------------------------------------------------------------

const readerClaim = (name) => ({
  agentId: 'rd-1', agent: 'Explore', worktree: wt(name), role: 'reader', fromBranch: 'feat/a', firstAt: 1, lastAt: 1,
});
const writerClaim = (name) => ({ ...readerClaim(name), agentId: 'wr-1', role: undefined });
const GIT_OK = { branch: 'feat/a', dirtyCount: 0, unpushedCount: 0, headInDevelop: true };
const AT_REST = { working: false, needsInput: false, lock: 'held', turn: 'idle' };

async function mergedHarness(claims) {
  const h = await opened({ safety: { facts: async () => GIT_OK }, occupancy: { claims: () => claims, known: () => true } });
  h.markers[key('feat-a')] = 'feat/a';
  h.shell.report(h.shell.tabByKey(key('feat-a')).view, AT_REST);
  h.clock += 11_000;
  h.confirm = false;
  return h;
}

test('Ctrl+click close ignores a reader: a side session\'s agent is not an agent working here', async () => {
  const h = await mergedHarness([readerClaim('feat-a')]);
  const r = await h.shell.closeTab(key('feat-a'), { ifSafe: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.confirms, [], 'closed with no question');
});

test('...while a writing agent in the same folder still asks', async () => {
  const h = await mergedHarness([writerClaim('feat-a')]);
  const r = await h.shell.closeTab(key('feat-a'), { ifSafe: true });
  assert.strictEqual(r.cancelled, true);
  assert.deepStrictEqual(h.confirms.map(c => c.reason), ["Ctrl+click only closes a tab that's merged, saved and pushed. An agent is working here."]);
});

test('Ctrl+click close with a side session OPEN still closes silently, and ends the side session with it', async () => {
  const h = await mergedHarness([]);
  await h.shell.openSide(key('feat-a'));
  const r = await h.shell.closeTab(key('feat-a'), { ifSafe: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.confirms, []);
  assert.deepStrictEqual(h.controls.map(c => c.port).sort(), [7701, 7702]);
});

test('the strip\'s occupancy mark for the branch tab says "reading only" for a reader, with no two-writers warning', async () => {
  const h = await opened({ occupancy: { claims: () => [readerClaim('feat-a')], known: () => true } });
  h.shell.report(h.shell.tabByKey(key('feat-a')).view, { ...AT_REST, working: true, turn: 'turn' });
  const e = h.shell.model().find(x => x.key === key('feat-a'));
  assert.ok(e.occupancy, 'shown');
  assert.strictEqual(e.occupancy.warn, false);
  assert.strictEqual(e.occupancy.readersOnly, true);
});

// --- the side tab keeps the branch tab's own signals ------------------------------------------------------------

test('a branch tab that needs you keeps pulsing while its side tab is the one showing', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  h.shell.report(h.shell.tabByKey(key('feat-a')).view, { ...AT_REST, needsInput: true });
  const parent = h.shell.model().find(e => e.key === key('feat-a'));
  assert.strictEqual(parent.pulse, 'needs');
  assert.strictEqual(parent.selected, false);
});

test('the side tab reports its own status, apart from its branch tab\'s', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  h.shell.report(h.shell.tabByKey(skey('feat-a')).view, { ...AT_REST, working: true });
  assert.strictEqual(h.shell.model().find(e => e.key === skey('feat-a')).working, true);
  assert.strictEqual(h.shell.model().find(e => e.key === key('feat-a')).working, false);
});

test('a side tab whose host could not start says why, and is still there to retry', async () => {
  const h = await opened();
  for (let p = 7702; p < 7750; p++) h.running[p] = { cwd: wt('elsewhere'), side: false };   // no free port
  const r = await h.shell.openSide(key('feat-a'));
  const e = h.shell.model().find(x => x.key === skey('feat-a'));
  assert.ok(e, 'the tab is there with its error, not silently absent');
  assert.strictEqual(e.started, false);
  assert.ok(typeof e.startError === 'string' && e.startError.length > 0);
  assert.strictEqual(r.ok, true);
  delete h.running[7705];
  await h.shell.select(skey('feat-a'));
  assert.strictEqual(h.shell.model().find(x => x.key === skey('feat-a')).started, true);
});

// --- the probe driver ----------------------------------------------------------------------------------------

const PROBE_TOKEN = 'p'.repeat(32);
const probe = (cmd, api) => handleProbeCommand(JSON.stringify({ token: PROBE_TOKEN, ...cmd }), api, PROBE_TOKEN);

test('the probe driver can open a side session by label, and refuses it without one', async () => {
  const seen = [];
  const api = { sideOpen: async (label) => { seen.push(label); return { ok: true }; } };
  assert.deepStrictEqual(await probe({ cmd: 'side-open', label: 'feat/a' }, api), { ok: true });
  assert.deepStrictEqual(seen, ['feat/a']);
  for (const bad of [{}, { label: '' }, { label: 5 }]) {
    assert.strictEqual((await probe({ cmd: 'side-open', ...bad }, api)).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(seen.length, 1);
});

// --- PR #149 review: the lifecycle around a side session ----------------------------------------------------------------

const stopsTo = (h, port) => h.controls.filter(c => c.port === port && c.msg.type === 'stop').length;
// a merged tab whose own host has ended: the reducer is about to ask for the folder's removal
async function mergedAndEnded(h) {
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();                       // finishing, and its host seen after the merge
  await h.shell.openSide(key('feat-a'));
  await h.shell.poll();
  delete h.running[7701];                     // the branch tab's claude ended
}

test('/merged with a side tab open: the side session is stopped BEFORE the worktree remover runs, and its tab goes (Dexter 2)', async () => {
  const h = await opened();
  await mergedAndEnded(h);
  h.order.length = 0;
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(h.order, ['stop:7702', 'remove'], 'the folder must be free when the remover looks');
  assert.strictEqual(h.shell.tabByKey(skey('feat-a')), null);
  assert.ok(!labels(h).some(l => l === SIDE_A));
});

test('...and a side host that does not answer its stop does not hold the removal back: the remover still runs and says why it can\'t', async () => {
  const h = await opened();
  await mergedAndEnded(h);
  h.controlOk = false;
  h.order.length = 0;
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(h.order, ['stop:7702', 'remove']);
});

test('a merged tab with NO side session is removed exactly as before: no stop, one remove', async () => {
  const h = await opened();
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();
  delete h.running[7701];
  h.order.length = 0;
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(h.order, ['remove']);
});

test('a side host found by attach AFTER its branch tab closed is stopped, not left running with no tab (adopt path) (Dexter 4)', async () => {
  const h = harness({ running: { 7700: dev(false), 7701: featA(false), 7702: featA(true) } });
  let release;
  h.holdSide = new Promise((r) => { release = r; });
  await h.shell.open();
  await flush();
  await h.shell.closeTab(key('feat-a'));
  release();
  await flush();
  assert.strictEqual(stopsTo(h, 7702), 1, 'the side host the adopt job proved was there is ended');
  assert.strictEqual(h.shell.tabByKey(skey('feat-a')), null);
});

test('a side host found by attach while Open side session was starting, then the branch tab closes: stopped (start path) (Dexter 4)', async () => {
  const h = await opened();
  h.running[7702] = featA(true);               // another window's side host serves the folder
  let release;
  h.holdSide = new Promise((r) => { release = r; });
  const opening = h.shell.openSide(key('feat-a'));
  await flush();
  await h.shell.closeTab(key('feat-a'));
  release();
  await opening;
  await flush();
  assert.strictEqual(stopsTo(h, 7702), 1);
  assert.strictEqual(h.shell.tabByKey(skey('feat-a')), null);
});

test('no side session while the branch\'s folder is being removed: the menu says so and openSide refuses (Dexter 5)', async () => {
  const h = await opened();
  h.markers[key('feat-a')] = 'feat/a';
  h.removeHold = new Promise(() => {});        // the remover never finishes: the tab stays 'removing'
  await h.shell.poll();
  delete h.running[7701];
  await h.shell.poll();
  await flush();
  assert.strictEqual(h.shell._state().tabs.find(t => normPath(t.path) === key('feat-a')).phase, 'removing');
  const m = h.shell.sideMenu(key('feat-a'));
  assert.strictEqual(m.enabled, false);
  assert.match(m.why, /removed/);
  const r = await h.shell.openSide(key('feat-a'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.spawns.filter(s => s.side).length, 0);
});

// --- PR #149 Miguel Y2: no port walk per branch tab at open --------------------------------------------------------------

test('opening a window walks the ports for a side host only where an identity file says one serves that folder (Miguel Y2)', async () => {
  const none = harness({ running: { 7700: dev(false), 7701: featA(false) } });
  await none.shell.open();
  await flush();
  assert.strictEqual(none.sideWalks, 0, 'no side host anywhere: no walk at all');
  assert.ok(none.sideHostReads >= 1, 'the identity files were read');

  const one = harness({ running: { 7700: dev(false), 7701: featA(false), 7702: featA(true) } });
  await one.shell.open();
  await flush();
  assert.strictEqual(one.sideWalks, 1, 'one folder has a side host: one walk');
  assert.deepStrictEqual(labels(one), ['develop', 'feat/a', SIDE_A, 'feat/b']);
});

test('the identity files are read once per batch of tabs, not once per tab', async () => {
  const h = harness({ running: { 7700: dev(false), 7701: featA(false) } });
  await h.shell.open();
  await flush();
  assert.strictEqual(h.sideHostReads, 1, 'three tabs opened in one poll, one read');
});

test('a shell given no way to list side hosts still finds one the slow way (the walk), so nothing is lost', async () => {
  const h = harness({ running: { 7700: dev(false), 7701: featA(false), 7702: featA(true) }, listSideHosts: false });
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SIDE_A, 'feat/b']);
});

// --- PR #149 Miguel G2: a right-click does not rebuild the model ---------------------------------------------------------

test('sideMenu reads the shell\'s records, not the whole strip model (no claims, no marks) (Miguel G2)', async () => {
  let reads = 0;
  const h = await opened({ occupancy: { claims: () => { reads++; return []; }, known: () => true } });
  reads = 0;
  h.shell.sideMenu(key('feat-a'));
  h.shell.sideMenu(skey('feat-a'));
  h.shell.sideMenu('nope');
  assert.strictEqual(reads, 0);
});

// --- PR #149 round 2 ---------------------------------------------------------------------------------------------------------

test('a side start parked in its port walk when the merged tab\'s claude exits: no side host is spawned, and the remover waits for the start (R2-2)', async () => {
  const h = await opened();
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();                         // finishing, its host seen
  let release;
  h.holdSide = new Promise((r) => { release = r; });
  const opening = h.shell.openSide(key('feat-a'));   // allowed while finishing; parks inside choosePort
  await flush();
  delete h.running[7701];                       // the main claude exits during the walk
  h.order.length = 0;
  await h.shell.poll();                         // -> removing -> endSide
  await flush();
  assert.ok(!h.order.includes('remove'), 'the remover must not start while a side start is in flight');
  release();
  await opening;
  await flush();
  assert.strictEqual(h.spawns.filter(s => s.side).length, 0, 'nothing is spawned into a folder being removed');
  assert.deepStrictEqual(h.order, ['remove']);
  assert.strictEqual(h.shell.tabByKey(skey('feat-a')), null);
});

test('a side tab closed before its host is spawned spawns none; one whose walk FOUND a host still stops it (R2-2 + Dexter 4)', async () => {
  const h = await opened();
  let release;
  h.holdSide = new Promise((r) => { release = r; });
  const opening = h.shell.openSide(key('feat-a'));
  await flush();
  await h.shell.closeTab(key('feat-a'));
  release();
  await opening;
  await flush();
  assert.strictEqual(h.spawns.filter(s => s.side).length, 0);
});

test('side hosts the identity files could not list: every tab is looked for the slow way, so a running side host is still adopted (R2-3)', async () => {
  for (const sideHosts of [() => null, () => { throw new Error('EPERM'); }]) {
    const h2 = harness({ running: { 7700: dev(false), 7701: featA(false), 7702: featA(true) }, sideHostsSeam: sideHosts });
    await h2.shell.open();
    await flush();
    assert.deepStrictEqual(labels(h2), ['develop', 'feat/a', SIDE_A, 'feat/b']);
  }
});
