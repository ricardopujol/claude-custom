'use strict';
/**
 * The tab shell's half of the strip redesign (BACKLOG #139, #141, #151; documentation/DESIGN_TAB_STRIP.md): which lanes
 * have a tab and which are rows in the Lanes menu (1B), the drag order and the lanes closed by hand surviving a restart,
 * develop never wearing the agent stripes, and Ctrl+Tab / close landing only on tabs you can see. Every effect is a
 * recording fake (see test/tab-shell.test.js for the long form of this harness).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createShell } = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-lanes');
const wt = (name) => path.join(ROOT, name);
const key = (name) => normPath(wt(name));
const porcelain = (entries) => entries.map(([name, branch]) =>
  `worktree ${wt(name).replace(/\\/g, '/')}\nHEAD 0123456789012345678901234567890123456789\n` +
  (branch ? `branch refs/heads/${branch}\n` : 'detached\n')).join('\n') + '\n';

const FOUR = [['dev', 'develop'], ['feat-a', 'feat/a'], ['feat-b', 'feat/b'], ['feat-c', 'feat/c']];
const NO_OPS = {
  available: () => ({ create: false, setup: false, remove: false }),
  create: async () => ({ ok: false, error: 'no' }), setup: async () => ({ ok: false, error: 'no' }),
  remove: async () => ({ ok: true }),
};
const settle = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await settle(); };

/** An in-memory layout store: `saved` is what was last saved; `seed` what a restart would load. */
function memoryLayout(seed = { order: [], closed: [] }) {
  const l = { saved: [], load: () => ({ order: [...seed.order], closed: seed.closed.map(c => ({ ...c })), error: null }) };
  l.save = (v) => { l.saved.push(JSON.parse(JSON.stringify(v))); return { ok: true }; };
  return l;
}

function harness({ list = porcelain(FOUR), running = {}, layout, occupancy, markers = {} } = {}) {
  const h = {
    running: { ...running }, spawns: [], controls: [], listText: list, markers: { ...markers }, clock: 1_000_000_000, layout, confirm: true,
  };
  const base = 7700;
  const tokenOf = (port) => (h.running[port] === undefined ? null : `tok-${port}`);
  const deps = {
    mode: 'tabs', container: ROOT, cwd: wt('dev'), launchedFrom: null, log: () => {},
    git: {
      list: async () => { await settle(); return h.listText; },
      marker: (p, branch) => (h.markers[normPath(p)] === branch ? { branch, pr: 1, mergedAt: '2026-10-29T00:00:00Z' } : null),
    },
    ops: NO_OPS,
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
      control: async (c) => { h.controls.push(c); return { ok: true, reply: null }; },
      identity: () => null, readToken: () => null,
    },
    views: {
      create: (tab) => ({ tab: tab.key }), destroy: () => {}, send: () => {}, owns: (tab, sender) => tab.view === sender,
    },
    ui: { confirmClose: async () => h.confirm, changed: () => {}, focusWindow: () => {}, isFocused: () => true },
    now: () => h.clock,
  };
  if (layout) deps.layout = layout;
  if (occupancy) deps.occupancy = occupancy;
  h.shell = createShell(deps);
  h.endSession = (name) => { for (const [p, cwd] of Object.entries(h.running)) if (normPath(cwd) === key(name)) delete h.running[p]; };
  return h;
}

const stripKeys = (h) => h.shell.snapshot().strip.map(e => e.key);
const menuKeys = (h, group) => h.shell.snapshot().lanes[group].map(r => r.key);

async function opened(opts) {
  const h = harness(opts);
  await h.shell.open();
  await flush();
  return h;
}

// --- 1B: only running lanes have a tab -----------------------------------------------------------

test('1B: on open only develop (selected and started) has a tab; every other lane is a Not started row', async () => {
  const h = await opened();
  assert.deepStrictEqual(stripKeys(h), [key('dev')]);
  assert.deepStrictEqual(menuKeys(h, 'notStarted'), [key('feat-a'), key('feat-b'), key('feat-c')]);
  assert.deepStrictEqual(menuKeys(h, 'merged'), []);
  assert.strictEqual(h.shell.snapshot().model.length, 4, 'the full model still lists every lane');
});

test('1B: a lane with a session already running (from before this window) has its tab', async () => {
  const h = await opened({ running: { 7701: wt('feat-b') } });
  assert.deepStrictEqual(stripKeys(h), [key('dev'), key('feat-b')]);
  assert.deepStrictEqual(menuKeys(h, 'notStarted'), [key('feat-a'), key('feat-c')]);
});

test('1B: choosing a lane (a click on its menu row) starts its session and gives it a tab, which it keeps when you switch away', async () => {
  const h = await opened();
  await h.shell.select(key('feat-a'));
  await flush();
  assert.deepStrictEqual(stripKeys(h), [key('dev'), key('feat-a')]);
  await h.shell.select(key('dev'));
  await flush();
  assert.deepStrictEqual(stripKeys(h), [key('dev'), key('feat-a')], 'running: it stays');
  assert.deepStrictEqual(menuKeys(h, 'notStarted'), [key('feat-b'), key('feat-c')]);
});

test('an ended session stays on the strip while it is selected and moves to the menu when you switch away (open question 1)', async () => {
  const h = await opened();
  await h.shell.select(key('feat-a'));
  await flush();
  h.endSession('feat-a');
  await h.shell.poll();
  assert.deepStrictEqual(stripKeys(h), [key('dev'), key('feat-a')], 'selected: stays, so its click-to-restart works in place');
  await h.shell.select(key('dev'));
  await flush();
  assert.deepStrictEqual(stripKeys(h), [key('dev')]);
  assert.deepStrictEqual(h.shell.snapshot().lanes.notStarted.find(r => r.key === key('feat-a')).state, 'ended');
});

test('a merged lane with no session is a Merged row; once its session is running it has its tab (with the merged badge)', async () => {
  const h = await opened({ markers: { [key('feat-a')]: 'feat/a' } });
  assert.deepStrictEqual(menuKeys(h, 'merged'), [key('feat-a')]);
  assert.deepStrictEqual(stripKeys(h), [key('dev')]);
  await h.shell.select(key('feat-a'));
  await flush();
  assert.deepStrictEqual(menuKeys(h, 'merged'), []);
  assert.strictEqual(h.shell.snapshot().strip.find(e => e.key === key('feat-a')).badge, 'merged');
});

test('Ctrl+Tab steps through the tabs you can see, and never starts a lane that is only a menu row', async () => {
  const h = await opened({ running: { 7701: wt('feat-b') } });
  await h.shell.next();
  await flush();
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-b'));
  await h.shell.next();
  await flush();
  assert.strictEqual(h.shell.snapshot().selectedKey, key('dev'), 'wraps over the strip, past feat-a and feat-c');
  assert.ok(!h.spawns.includes(key('feat-a')) && !h.spawns.includes(key('feat-c')));
  await h.shell.previous();
  await flush();
  assert.strictEqual(h.shell.snapshot().selectedKey, key('feat-b'));
});

test('closing the selected tab lands on a tab you can see, not on the next lane in the list', async () => {
  const h = await opened({ running: { 7701: wt('feat-a') } });
  await h.shell.select(key('feat-a'));
  await flush();
  const r = await h.shell.closeTab(key('feat-a'));
  await flush();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.shell.snapshot().selectedKey, key('dev'));
  assert.ok(!h.spawns.includes(key('feat-b')), 'feat-b was not started by the close');
});

// --- the menu ------------------------------------------------------------------------------------

test('lanesMenu: the rows for the native menu, with the tabs the strip reports as hidden first', async () => {
  const h = await opened({ running: { 7701: wt('feat-b') } });
  const rows = h.shell.lanesMenu([key('feat-b'), 'not-a-tab', 7]);
  assert.deepStrictEqual(rows.map(r => [r.type, r.label, r.action || null]), [
    ['header', 'Hidden tabs', null], ['row', 'feat/b', 'select'],
    ['header', 'Not started', null], ['row', 'feat/a', 'select'], ['row', 'feat/c', 'select'],
  ]);
  assert.deepStrictEqual(h.shell.lanesMenu(null).filter(r => r.label === 'Hidden tabs'), []);
  assert.deepStrictEqual(h.shell.lanesMenu([key('dev')]).filter(r => r.label === 'Hidden tabs'), [], 'develop is never hidden');
});

test('lanesMenu: a lane closed by hand is a row that reopens it, labelled with the shortcut for the most recent', async () => {
  const h = await opened({ running: { 7701: wt('feat-a') } });
  await h.shell.closeTab(key('feat-a'));
  await flush();
  const closed = h.shell.lanesMenu([]).filter(r => r.action === 'reopen');
  assert.deepStrictEqual(closed.map(r => [r.key, r.label, r.state, r.shortcut]), [[key('feat-a'), 'feat/a', 'closed', 'Ctrl+Shift+T']]);
});

test('lanesMenu: only the most recent closed lane carries the shortcut, and Ctrl+Shift+T reopens exactly that one', async () => {
  const h = await opened({ running: { 7701: wt('feat-a'), 7702: wt('feat-b') } });
  await h.shell.closeTab(key('feat-a'));
  await h.shell.closeTab(key('feat-b'));
  await flush();
  const closed = h.shell.lanesMenu([]).filter(r => r.action === 'reopen');
  assert.deepStrictEqual(closed.map(r => [r.label, r.shortcut || null]), [['feat/b', 'Ctrl+Shift+T'], ['feat/a', null]]);
  await h.shell.reopen();
  assert.ok(h.shell.model().some(e => e.key === key('feat-b')) && !h.shell.model().some(e => e.key === key('feat-a')));
});

// --- #141: drag order, saved ----------------------------------------------------------------------

test('reorder: a lane dropped before another moves there; develop stays first; the order is saved', async () => {
  const layout = memoryLayout();
  const h = await opened({ layout, running: { 7701: wt('feat-a'), 7702: wt('feat-b'), 7703: wt('feat-c') } });
  assert.deepStrictEqual(stripKeys(h), [key('dev'), key('feat-a'), key('feat-b'), key('feat-c')]);
  assert.deepStrictEqual(h.shell.reorder(key('feat-c'), key('feat-a')), { ok: true });
  assert.deepStrictEqual(stripKeys(h), [key('dev'), key('feat-c'), key('feat-a'), key('feat-b')]);
  h.shell.reorder(key('feat-c'), key('dev'));
  assert.deepStrictEqual(stripKeys(h)[0], key('dev'), 'dropped on develop: it goes first among the others, develop stays first');
  h.shell.reorder(key('feat-a'), null);
  assert.deepStrictEqual(stripKeys(h), [key('dev'), key('feat-c'), key('feat-b'), key('feat-a')], 'no target: the end');
  assert.deepStrictEqual(layout.saved[layout.saved.length - 1].order.slice(0, 3), [key('feat-c'), key('feat-b'), key('feat-a')]);
});

test('reorder refuses develop, a side tab, a key that is no tab, and a drop on itself changes nothing', async () => {
  const layout = memoryLayout();
  const h = await opened({ layout, running: { 7701: wt('feat-a'), 7702: wt('feat-b') } });
  const before = stripKeys(h);
  assert.strictEqual(h.shell.reorder(key('dev'), key('feat-a')).ok, false);
  assert.strictEqual(h.shell.reorder('nope', key('feat-a')).ok, false);
  assert.strictEqual(h.shell.reorder(7, key('feat-a')).ok, false);
  assert.strictEqual(h.shell.reorder(key('feat-a'), key('feat-a')).ok, true);
  assert.deepStrictEqual(stripKeys(h), before);
});

test('the saved order survives a restart: a new shell on the same layout draws the lanes where they were dragged', async () => {
  const layout = memoryLayout();
  const a = await opened({ layout, running: { 7701: wt('feat-a'), 7702: wt('feat-b') } });
  a.shell.reorder(key('feat-b'), key('feat-a'));
  const saved = layout.saved[layout.saved.length - 1];
  const b = await opened({ layout: memoryLayout(saved), running: { 7701: wt('feat-a'), 7702: wt('feat-b') } });
  assert.deepStrictEqual(stripKeys(b), [key('dev'), key('feat-b'), key('feat-a')]);
});

test('a layout that throws on load or save never takes the strip down', async () => {
  const bad = { load: () => { throw new Error('boom'); }, save: () => { throw new Error('boom'); } };
  const h = await opened({ layout: bad, running: { 7701: wt('feat-a') } });
  assert.deepStrictEqual(stripKeys(h), [key('dev'), key('feat-a')]);
  assert.doesNotThrow(() => h.shell.reorder(key('feat-a'), null));
  await h.shell.closeTab(key('feat-a'));
});

// --- closed stays closed -------------------------------------------------------------------------

test('a lane closed by hand is saved, and stays closed after a restart (a Lanes row, not a tab)', async () => {
  const layout = memoryLayout();
  const a = await opened({ layout, running: { 7701: wt('feat-a') } });
  await a.shell.select(key('feat-a'));
  await a.shell.closeTab(key('feat-a'));
  await flush();
  const saved = layout.saved[layout.saved.length - 1];
  assert.deepStrictEqual(saved.closed.map(c => [c.key, c.branch]), [[key('feat-a'), 'feat/a']]);

  const b = await opened({ layout: memoryLayout(saved) });
  assert.ok(!b.shell.model().some(e => e.key === key('feat-a')), 'no tab for it, not even a dim one');
  assert.deepStrictEqual(b.shell.snapshot().lanes.notStarted.filter(r => r.closed).map(r => [r.key, r.label, r.state]), [[key('feat-a'), 'feat/a', 'closed']]);
  const r = await b.shell.reopen(key('feat-a'));
  assert.strictEqual(r.ok, true);
  await flush();
  assert.ok(b.shell.model().some(e => e.key === key('feat-a')));
  assert.deepStrictEqual(layout.saved.length > 0 && b.shell.snapshot().lanes.notStarted.filter(r2 => r2.closed), []);
});

test('reopening it saves that too: it is not closed after the next restart', async () => {
  const layout = memoryLayout({ order: [], closed: [{ key: key('feat-a'), path: wt('feat-a'), branch: 'feat/a' }] });
  const h = await opened({ layout });
  await h.shell.reopen(key('feat-a'));
  await flush();
  assert.deepStrictEqual(layout.saved[layout.saved.length - 1].closed, []);
});

test('a closed lane that git no longer lists is forgotten, in the menu and on disk', async () => {
  const layout = memoryLayout({ order: [], closed: [{ key: key('feat-gone'), path: wt('feat-gone'), branch: 'feat/gone' }] });
  const h = await opened({ layout });
  assert.deepStrictEqual(h.shell.snapshot().lanes.notStarted.filter(r => r.closed), []);
  assert.deepStrictEqual(layout.saved[layout.saved.length - 1].closed, []);
});

// --- #151: develop never stripes -------------------------------------------------------------------

test('#151: an agent writing into develop\'s folder draws no stripes on develop, while another lane\'s still do', async () => {
  const claim = (name) => ({
    agentId: `a-${name}`, agent: 'electron-pro', worktree: wt(name), also: [], fromBranch: 'develop', fromRoot: wt('dev'),
    hostPid: 4242, hostStartedAt: '1', firstAt: 1_000_000_000 - 4 * 60000, lastAt: 1_000_000_000 - 1000, count: 3,
  });
  const claims = [claim('dev'), claim('feat-a')];
  const h = await opened({ running: { 7701: wt('feat-a') }, occupancy: { claims: () => claims, known: () => true } });
  const m = h.shell.model();
  assert.strictEqual(m.find(e => e.isDev).occupancy, null);
  assert.notStrictEqual(m.find(e => e.key === key('feat-a')).occupancy, null, 'a branch lane keeps its mark');
});

// --- the probe driver's two new commands (verify/probe-tab-strip-lanes.js) -------------------------

test('handleProbeCommand: drag-tab needs two labels and a half; window-size needs a sane whole width', async () => {
  const { handleProbeCommand } = require('../app/tab-shell');
  const PT = 'probe-token-0123456789abcdef';
  const run = (o, api) => handleProbeCommand(JSON.stringify({ ...o, token: PT }), api, PT);
  const seen = [];
  const api = {
    dragTab: async (a, b, c) => { seen.push(['drag', a, b, c]); return { ok: true }; },
    windowSize: async (w) => { seen.push(['size', w]); return { ok: true }; },
  };
  assert.deepStrictEqual(await run({ cmd: 'drag-tab', label: 'feat/c', onLabel: 'feat/a', half: 'left' }, api), { ok: true });
  assert.deepStrictEqual(await run({ cmd: 'window-size', width: 900 }, api), { ok: true });
  for (const bad of [{ label: '', onLabel: 'a', half: 'left' }, { label: 'a', onLabel: 5, half: 'left' }, { label: 'a', onLabel: 'b', half: 'middle' }, { label: 'a', onLabel: 'b' }]) {
    assert.strictEqual((await run({ cmd: 'drag-tab', ...bad }, api)).ok, false, JSON.stringify(bad));
  }
  for (const w of [299, 8001, 900.5, '900', null, undefined]) assert.strictEqual((await run({ cmd: 'window-size', width: w }, api)).ok, false, String(w));
  assert.deepStrictEqual(seen, [['drag', 'feat/c', 'feat/a', 'left'], ['size', 900]]);
});
