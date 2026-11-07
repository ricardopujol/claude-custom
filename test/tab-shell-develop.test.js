'use strict';
/**
 * BACKLOG #160: the develop tab can be closed, and it comes back in one click (Ricardo, 2026-11-05: "go for your
 * recommendation" = develop closes like a lane, and the Lanes menu and the + menu always list "develop" first while it has
 * no tab; Ctrl+Shift+T reopens it like any hand-closed tab; a restart keeps it closed with its row still there).
 *
 * Every effect is a recording fake (test/tab-shell.test.js has the long form of this harness).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createShell, lanesMenuTemplate, plusMenuTemplate } = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');
const tabLanes = require('../app/tab-lanes');
const { paneFor } = require('../app/tab-strip');

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-develop');
const wt = (name) => path.join(ROOT, name);
const key = (name) => normPath(wt(name));
const porcelain = (entries) => entries.map(([name, branch]) =>
  `worktree ${wt(name).replace(/\\/g, '/')}\nHEAD 0123456789012345678901234567890123456789\n` +
  (branch ? `branch refs/heads/${branch}\n` : 'detached\n')).join('\n') + '\n';

const THREE = [['dev', 'develop'], ['feat-a', 'feat/a'], ['feat-b', 'feat/b']];
const settle = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await settle(); };

function memoryLayout(seed = { order: [], closed: [] }) {
  const l = { saved: [], load: () => ({ order: [...seed.order], closed: seed.closed.map(c => ({ ...c })), error: null }) };
  l.save = (v) => { l.saved.push(JSON.parse(JSON.stringify(v))); return { ok: true }; };
  return l;
}

function harness({ list = porcelain(THREE), running = {}, layout, launchedFrom = null } = {}) {
  const h = { running: { ...running }, spawns: [], controls: [], confirms: [], removes: [], logs: [], listText: list, confirm: true, controlReply: null, pidReply: null };
  const base = 7700;
  const tokenOf = (port) => (h.running[port] === undefined ? null : `tok-${port}`);
  const deps = {
    mode: 'tabs', container: ROOT, cwd: wt('dev'), launchedFrom, log: (...a) => h.logs.push(a.join(' ')),
    git: { list: async () => { await settle(); return h.listText; }, marker: () => null },
    ops: {
      available: () => ({ create: false, setup: false, remove: false }),
      create: async () => ({ ok: false, error: 'no' }), setup: async () => ({ ok: false, error: 'no' }),
      remove: async ({ path: p }) => { h.removes.push(normPath(p)); return { ok: true }; },
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
      probe: async (port) => (h.running[port] !== undefined ? 'listening' : 'refused'),
      spawn: ({ tab, port }) => { h.spawns.push(tab.key); h.running[port] = tab.cwd; },
      wait: async () => true,
      tokenFor: tokenOf, tokenFile: tokenOf, newToken: () => 'fresh',
      control: async (c) => {
        h.controls.push(c);
        if (h.controlReply) return h.controlReply(c);
        if (c.msg.type === 'stop') delete h.running[c.port];     // the host takes the stop and goes
        return { ok: true, reply: null };
      },
      stopByPid: async () => (h.pidReply ? h.pidReply() : 'killed'),
      identity: () => null, readToken: () => null,
    },
    views: { create: (tab) => ({ tab: tab.key }), destroy: () => {}, send: () => {}, owns: (tab, sender) => tab.view === sender },
    ui: {
      confirmClose: async (tab, opts) => { h.confirms.push([tab.key, opts || null]); return h.confirm; },
      changed: () => {}, focusWindow: () => {}, isFocused: () => true,
    },
    sleep: async () => {},
  };
  if (layout) deps.layout = layout;
  h.shell = createShell(deps);
  return h;
}

async function opened(opts) {
  const h = harness(opts);
  await h.shell.open();
  await flush();
  return h;
}

const stripKeys = (h) => h.shell.snapshot().strip.map(e => e.key);
const rows = (h) => h.shell.lanesMenu([]).filter(r => r.type === 'row');
const DEV_ROW = { label: 'develop', key: key('dev'), state: 'closed', action: 'reopen' };

// --- closing it ----------------------------------------------------------------------------------

test('#160: develop closes like a lane: asked once, its host stopped, nothing on disk, and both menus list it first', async () => {
  const h = await opened({ running: { 7701: wt('feat-a') }, layout: memoryLayout() });
  assert.strictEqual(h.shell.model().find(e => e.isDev).closable, true, 'its x is drawn');
  const devPort = h.shell.tabByKey(key('dev')).port;
  const r = await h.shell.closeTab(key('dev'));
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(h.confirms.map(c => c[0]), [key('dev')], 'the same question a lane gets');
  assert.deepStrictEqual(h.controls, [{ port: devPort, token: `tok-${devPort}`, msg: { type: 'stop' } }], 'its host is stopped through the hand-close path');
  assert.deepStrictEqual(h.removes, [], 'nothing on disk');
  assert.strictEqual(h.shell.tabByKey(key('dev')), null);
  assert.deepStrictEqual(stripKeys(h), [key('feat-a')], 'its neighbour is selected');
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-a'));
  const lanes = rows(h);
  const first = lanes[0];
  assert.deepStrictEqual({ label: first.label, key: first.key, state: first.state, action: first.action }, DEV_ROW, 'develop is the first row');
  assert.strictEqual(first.shortcut, 'Ctrl+Shift+T', 'and the most recent close');
  assert.deepStrictEqual(h.shell.plusMenu().develop, { key: key('dev'), label: 'develop', shortcut: 'Ctrl+Shift+T' });
  assert.deepStrictEqual(h.shell.snapshot().lanes.develop, { key: key('dev'), label: 'develop', state: 'closed', closed: true });
  assert.deepStrictEqual(h.shell.snapshot().lanes.notStarted.map(x => x.key), [key('feat-b')], 'never a Not started row as well');
  assert.ok(h.shell._state().dismissed.includes(key('dev')));
});

test('#160 P8: with develop closed and one lane left, that lane keeps its x, its Close tab and its close (one rule: the last tab closes)', async () => {
  const h = await opened({ list: porcelain([['dev', 'develop'], ['feat-a', 'feat/a']]), running: { 7701: wt('feat-a') } });
  await h.shell.closeTab(key('dev'));
  assert.deepStrictEqual(h.shell._state().tabs.map(t => normPath(t.path)), [key('feat-a')], 'the reducer holds only the lane');
  const lane = h.shell.model().find(e => e.key === key('feat-a'));
  assert.strictEqual(lane.closable, true, 'its x is drawn');
  assert.strictEqual(h.shell.menuState(key('feat-a')).close, true, 'its Close tab is enabled');
  assert.deepStrictEqual(await h.shell.closeTab(key('feat-a')), { ok: true });
  assert.deepStrictEqual(stripKeys(h), [], 'nothing left open; both rows are in the menus');
});

test('#160: a "no" leaves develop exactly as it was', async () => {
  const h = await opened();
  h.confirm = false;
  assert.strictEqual((await h.shell.closeTab(key('dev'))).cancelled, true);
  assert.deepStrictEqual(h.controls, []);
  assert.ok(h.shell.tabByKey(key('dev')));
  assert.strictEqual(h.shell.plusMenu().develop, null);
  assert.strictEqual(rows(h).some(r => r.key === key('dev')), false);
});

test('#160: develop closes even as the last tab the reducer holds (every lane closed by hand), and in a project with no lanes', async () => {
  const h = await opened({ running: { 7701: wt('feat-a') } });
  await h.shell.closeTab(key('feat-a'));
  assert.deepStrictEqual(h.shell._state().tabs.map(t => normPath(t.path)), [key('dev'), key('feat-b')]);
  await h.shell.closeTab(key('feat-b'));     // not running, but closable: it was a Not started lane (its x if selected)
  assert.deepStrictEqual(h.shell._state().tabs.map(t => normPath(t.path)), [key('dev')], 'the reducer holds develop alone');
  assert.strictEqual(h.shell.model()[0].closable, true, 'its x is still drawn (found live by verify/probe-develop-merged.js)');
  assert.deepStrictEqual(await h.shell.closeTab(key('dev')), { ok: true });
  assert.strictEqual(rows(h)[0].key, key('dev'));
  const lone = await opened({ list: porcelain([['dev', 'develop']]) });
  assert.strictEqual(lone.shell.model()[0].closable, true);
  assert.deepStrictEqual(await lone.shell.closeTab(key('dev')), { ok: true });
  assert.strictEqual(lone.shell.plusMenu().develop.key, key('dev'), 'one click brings it back');
});

test('#160: a single-folder window still has no close', async () => {
  const single = createShell({
    mode: 'single', cwd: wt('dev'), git: { list: async () => '', marker: () => null },
    ops: { available: () => ({}), create: async () => ({}), setup: async () => ({}), remove: async () => ({}) },
    hosts: { choosePort: async () => ({ port: 7790, action: 'spawn' }), probe: async () => 'listening', spawn: () => {}, wait: async () => true,
      tokenFor: () => 't', tokenFile: () => 't', newToken: () => 't', control: async () => ({ ok: true }), identity: () => null, readToken: () => null },
    views: { create: () => ({}), destroy: () => {}, send: () => {}, owns: () => false },
    ui: { confirmClose: async () => true, changed: () => {}, focusWindow: () => {}, isFocused: () => true },
  });
  await single.open();
  assert.strictEqual(single.model()[0].closable, false);
  assert.deepStrictEqual(await single.closeTab(single.model()[0].key), { ok: false, error: 'not closable' });
});

test('#160: a stop that fails keeps develop with the Stop offer, as it keeps a lane (PR #231)', async () => {
  const h = await opened();
  h.controlReply = () => ({ ok: false, error: 'refused' });
  h.pidReply = () => 'unknown';
  const r = await h.shell.closeTab(key('dev'));
  assert.strictEqual(r.kept, true);
  assert.ok(h.shell.tabByKey(key('dev')), 'kept');
  assert.strictEqual(h.shell.snapshot().closeStuck.key, key('dev'));
  assert.strictEqual(h.shell.plusMenu().develop, null, 'not closed, so not offered back');
});

// --- the last visible tab -----------------------------------------------------------------------

test('#160: closing develop as the last tab you can see selects nothing, starts no lane, and the pane says how to get it back', async () => {
  const h = await opened();
  assert.deepStrictEqual(stripKeys(h), [key('dev')]);
  const spawnsBefore = h.spawns.length;
  assert.strictEqual((await h.shell.closeTab(key('dev'))).ok, true);
  await h.shell.poll();
  await flush();
  await h.shell.poll();
  await flush();
  const snap = h.shell.snapshot();
  assert.strictEqual(snap.selectedKey, null, 'nothing is selected');
  assert.deepStrictEqual(snap.strip, [], 'no tab is drawn');
  assert.strictEqual(h.spawns.length, spawnsBefore, 'no lane was started by the close or by a poll');
  assert.strictEqual(snap.devClosed, true);
  assert.deepStrictEqual(paneFor({ model: snap.strip, mode: 'tabs', devClosed: snap.devClosed }),
    { text: 'No tab is open. Open develop or a lane from Lanes ▾ or +.', retry: null });
  assert.deepStrictEqual(paneFor({ model: [], notice: "can't list worktrees: x", devClosed: true }).text, "can't list worktrees: x", 'a git failure still wins');
  assert.deepStrictEqual(paneFor({ model: [] }).text, 'No worktrees yet.', 'unchanged without it');
  // and the window still works: a lane can be chosen, and develop can be brought back
  await h.shell.select(key('feat-a'));
  await flush();
  assert.deepStrictEqual(stripKeys(h), [key('feat-a')]);
});

// --- bringing it back ---------------------------------------------------------------------------

test('#160: the develop row reopens it, selected, first on the strip again; the row goes', async () => {
  const h = await opened({ running: { 7701: wt('feat-a') }, layout: memoryLayout() });
  await h.shell.closeTab(key('dev'));
  assert.deepStrictEqual(await h.shell.reopen(key('dev')), { ok: true });
  await flush();
  assert.deepStrictEqual(stripKeys(h), [key('dev'), key('feat-a')]);
  assert.strictEqual(h.shell.snapshot().selectedKey, key('dev'));
  assert.strictEqual(h.shell.tabByKey(key('dev')).started, true);
  assert.strictEqual(h.shell.plusMenu().develop, null);
  assert.strictEqual(rows(h).some(r => r.key === key('dev')), false);
  assert.strictEqual(h.shell.snapshot().devClosed, false);
});

test('#160: Ctrl+Shift+T (reopen with no key) brings develop back like any hand-closed tab, most recent first', async () => {
  const h = await opened({ running: { 7701: wt('feat-a'), 7702: wt('feat-b') } });
  await h.shell.closeTab(key('dev'));
  await h.shell.closeTab(key('feat-b'));
  // develop is listed first, but the shortcut names what it reopens: the most recent close, feat-b
  const lanes = rows(h);
  assert.strictEqual(lanes[0].key, key('dev'));
  assert.strictEqual(lanes[0].shortcut, undefined);
  assert.strictEqual(lanes.find(r => r.key === key('feat-b')).shortcut, 'Ctrl+Shift+T');
  assert.strictEqual(h.shell.plusMenu().develop.shortcut, null);
  await h.shell.reopen();
  await flush();
  assert.ok(h.shell.tabByKey(key('feat-b')));
  assert.strictEqual(rows(h)[0].shortcut, 'Ctrl+Shift+T', 'develop is the most recent close now');
  await h.shell.reopen();
  await flush();
  assert.ok(h.shell.tabByKey(key('dev')));
});

// --- a restart ----------------------------------------------------------------------------------

test('#160: a restart with develop closed keeps it closed, lists its row first, and starts nothing nobody chose', async () => {
  const layout = memoryLayout({ order: [], closed: [{ key: key('dev'), path: wt('dev'), branch: 'develop' }] });
  const h = await opened({ layout });
  assert.strictEqual(h.shell.tabByKey(key('dev')), null, 'no develop tab');
  assert.deepStrictEqual(h.spawns, [], 'nothing started');
  assert.strictEqual(h.shell.snapshot().selectedKey, null);
  assert.deepStrictEqual(rows(h)[0], { type: 'row', ...DEV_ROW, shortcut: 'Ctrl+Shift+T' });
  assert.strictEqual(h.shell.plusMenu().develop.key, key('dev'));
  // before git has answered at all, the row is already there (the key is known from the project folder)
  const cold = harness({ layout: memoryLayout({ order: [], closed: [{ key: key('dev'), path: wt('dev'), branch: 'develop' }] }) });
  assert.strictEqual(cold.shell.snapshot().lanes.develop.key, key('dev'), 'already there: the saved close seeds the reducer');
});

test('#160: a restart with develop closed and a lane still running selects that lane once its host is found, and spawns nothing', async () => {
  const layout = memoryLayout({ order: [], closed: [{ key: key('dev'), path: wt('dev'), branch: 'develop' }] });
  const h = await opened({ layout, running: { 7702: wt('feat-b') } });
  await h.shell.poll();
  await flush();
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-b'));
  assert.deepStrictEqual(stripKeys(h), [key('feat-b')]);
  assert.deepStrictEqual(h.spawns, []);
  assert.strictEqual(rows(h)[0].key, key('dev'), 'and develop is still the first row');
});

test('#160: a restart with develop closed, opened from a lane\'s folder, selects that lane', async () => {
  const layout = memoryLayout({ order: [], closed: [{ key: key('dev'), path: wt('dev'), branch: 'develop' }] });
  const h = await opened({ layout, launchedFrom: wt('feat-b') });
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-b'));
  assert.deepStrictEqual(h.spawns, [key('feat-b')]);
});

test('#160: the saved layout holds develop like a lane: its closed entry is written and read back', async () => {
  const layout = memoryLayout();
  const h = await opened({ layout });
  await h.shell.select(key('feat-a'));
  await flush();
  await h.shell.closeTab(key('dev'));
  const last = layout.saved[layout.saved.length - 1];
  assert.deepStrictEqual(last.closed, [{ key: key('dev'), path: wt('dev'), branch: 'develop' }]);
  // The real store's strict parse keeps it (host/strip-layout.js cleanClosed: key === normPath(path)).
  const { parseLayout } = require('../host/strip-layout');
  assert.deepStrictEqual(parseLayout(JSON.stringify({ version: 1, ...last })).closed, last.closed);
});

// --- the pure pieces ----------------------------------------------------------------------------

test('#160 tab-lanes: a closed develop is menu.develop and the first menu row, with a separator before the rest', () => {
  const placed = tabLanes.placeLanes([{ key: 'a', label: 'feat/a', isDev: false }], [{ key: 'z', label: 'feat/z' }, { key: 'd', label: 'develop', isDev: true }]);
  assert.deepStrictEqual(placed.menu.develop, { key: 'd', label: 'develop', state: 'closed', closed: true });
  assert.deepStrictEqual(placed.menu.notStarted.map(r => r.key), ['a', 'z']);
  const out = tabLanes.lanesMenuRows(placed.menu, []);
  assert.deepStrictEqual(out.slice(0, 3), [
    { type: 'row', label: 'develop', key: 'd', state: 'closed', action: 'reopen' },
    { type: 'separator' },
    { type: 'header', label: 'Not started' },
  ]);
  assert.deepStrictEqual(tabLanes.lanesMenuRows({ develop: placed.menu.develop, notStarted: [], merged: [] }, []),
    [{ type: 'row', label: 'develop', key: 'd', state: 'closed', action: 'reopen' }], 'no separator with nothing after it');
  assert.strictEqual(tabLanes.placeLanes([], []).menu.develop, null);
});

test('#170 S8 lanesMenuTemplate: headers are disabled, separators pass, a row is its label with state and shortcut and clicks act(row)', () => {
  const acted = [];
  const rowsIn = [
    { type: 'row', label: 'develop', key: 'd', state: 'closed', action: 'reopen', shortcut: 'Ctrl+Shift+T' },
    { type: 'separator' },
    { type: 'header', label: 'Not started' },
    { type: 'row', label: 'feat/r&d', key: 'r', state: 'not started', action: 'select' },
    { type: 'row', label: 'feat/x', key: 'x', state: '', action: 'select' },
  ];
  const t = lanesMenuTemplate(rowsIn, (r) => acted.push(r.key));
  assert.deepStrictEqual(t.map(i => ({ ...i, click: typeof i.click })), [
    { label: 'develop  (closed)  (Ctrl+Shift+T)', click: 'function' },
    { type: 'separator', click: 'undefined' },
    { label: 'Not started', enabled: false, click: 'undefined' },
    { label: 'feat/r&&d  (not started)', click: 'function' },
    { label: 'feat/x', click: 'function' },
  ]);
  t[0].click();
  t[3].click();
  assert.deepStrictEqual(acted, ['d', 'r']);
  assert.deepStrictEqual(lanesMenuTemplate([], () => {}), [{ label: 'No other lanes', enabled: false }]);
  assert.deepStrictEqual(lanesMenuTemplate(null, () => {}), [{ label: 'No other lanes', enabled: false }]);
});

test('#160 plusMenuTemplate: a closed develop is the first item, then a separator, New branch… and the shell tab', () => {
  const calls = [];
  const acts = { reopen: (k) => calls.push(['reopen', k]), openCreate: () => calls.push(['create']), openShell: (t) => calls.push(['shell', t]) };
  const base = { create: { enabled: true, why: null }, shell: { enabled: false, label: 'Shell tab', why: 'no such tab', target: null } };
  const plain = plusMenuTemplate({ ...base, develop: null }, acts);
  assert.deepStrictEqual(plain.map(i => i.label), ['New branch…', 'Shell tab (no such tab)']);
  const withDev = plusMenuTemplate({ ...base, develop: { key: 'd', label: 'develop', shortcut: 'Ctrl+Shift+T' } }, acts);
  assert.deepStrictEqual(withDev.map(i => i.label || i.type), ['develop  (closed)  (Ctrl+Shift+T)', 'separator', 'New branch…', 'Shell tab (no such tab)']);
  withDev[0].click();
  withDev[2].click();
  assert.deepStrictEqual(calls, [['reopen', 'd'], ['create']]);
  assert.strictEqual(plusMenuTemplate({ ...base, create: { enabled: false, why: 'creating…' }, develop: null }, acts)[0].label, 'New branch… (creating…)');
  // #119 A5's shell item: its label when enabled, and its click opens the shell for the item's target lane
  const shellOn = plusMenuTemplate({ ...base, develop: null, shell: { enabled: true, label: 'Shell tab', why: null, target: 'lane-k' } }, acts);
  assert.deepStrictEqual([shellOn[1].label, shellOn[1].enabled], ['Shell tab', true]);
  shellOn[1].click();
  assert.deepStrictEqual(calls[calls.length - 1], ['shell', 'lane-k']);
});
