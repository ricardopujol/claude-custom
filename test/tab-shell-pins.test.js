'use strict';
/**
 * The tab shell's half of pins (BACKLOG #167; documentation/DESIGN_TABS_SESSIONS.md 3.2, Ricardo's picks P4 and P7): a pinned lane
 * is kept in the strip's layout beside `order`, shown on the model as `pinned`, never a side/shell tab or develop, pruned when git no
 * longer lists its folder, and dropped by the merged close in the same save. Every effect is a recording fake.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createShell } = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-pins');
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

function memoryLayout(seed = {}) {
  const l = { saved: [], load: () => ({ order: seed.order || [], closed: (seed.closed || []).map(c => ({ ...c })), pinned: seed.pinned || [], error: null }) };
  l.save = (v) => { l.saved.push(JSON.parse(JSON.stringify(v))); return { ok: true }; };
  l.last = () => l.saved[l.saved.length - 1];
  return l;
}

function harness({ list = porcelain(FOUR), running = {}, layout } = {}) {
  const h = { running: { ...running }, spawns: [], controls: [], logs: [], listText: list };
  const base = 7700;
  const tokenOf = (port) => (h.running[port] === undefined ? null : `tok-${port}`);
  const deps = {
    mode: 'tabs', container: ROOT, cwd: wt('dev'), launchedFrom: null, log: (...a) => h.logs.push(a.join(' ')),
    git: { list: async () => { await settle(); return h.listText; }, marker: () => null },
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
    views: { create: (tab) => ({ tab: tab.key }), destroy: () => {}, send: () => {}, owns: (tab, sender) => tab.view === sender },
    ui: { confirmClose: async () => true, changed: () => {}, focusWindow: () => {}, isFocused: () => true },
    now: () => 1_000_000_000,
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

const entryOf = (h, name) => h.shell.snapshot().model.find(e => e.key === key(name));

test('pin(key) pins a lane: the model says so, and the layout is saved with it', async () => {
  const layout = memoryLayout();
  const h = await opened({ layout });
  assert.strictEqual(entryOf(h, 'feat-a').pinned, false);
  assert.deepStrictEqual(h.shell.pin(key('feat-a')), { ok: true });
  assert.strictEqual(entryOf(h, 'feat-a').pinned, true);
  assert.deepStrictEqual(layout.last().pinned, [key('feat-a')]);
});

test('unpin(key) takes the pin off and saves', async () => {
  const layout = memoryLayout({ pinned: [key('feat-a')] });
  const h = await opened({ layout });
  assert.strictEqual(entryOf(h, 'feat-a').pinned, true);
  assert.deepStrictEqual(h.shell.unpin(key('feat-a')), { ok: true });
  assert.strictEqual(entryOf(h, 'feat-a').pinned, false);
  assert.deepStrictEqual(layout.last().pinned, []);
});

test('pins keep the order they were made in, and pinning twice pins once', async () => {
  const layout = memoryLayout();
  const h = await opened({ layout });
  h.shell.pin(key('feat-b'));
  h.shell.pin(key('feat-a'));
  h.shell.pin(key('feat-b'));
  assert.deepStrictEqual(layout.last().pinned, [key('feat-b'), key('feat-a')]);
});

test('develop, a side tab, a shell tab and a stranger cannot be pinned', async () => {
  const layout = memoryLayout();
  const h = await opened({ layout });
  for (const k of [key('dev'), key('feat-a') + '|side', key('feat-a') + '|shell', 'c:\\nowhere', '', null, 7]) {
    assert.strictEqual(h.shell.pin(k).ok, false, String(k));
  }
  assert.strictEqual(entryOf(h, 'dev').pinned, false);
  assert.ok(layout.saved.every(s => s.pinned.length === 0));
});

test('a pinned lane from the last run is pinned on open', async () => {
  const h = await opened({ layout: memoryLayout({ pinned: [key('feat-b')] }) });
  assert.strictEqual(entryOf(h, 'feat-b').pinned, true);
  assert.strictEqual(entryOf(h, 'feat-a').pinned, false);
});

test('a layout with no pinned field (an older store) is nothing pinned', async () => {
  const old = { load: () => ({ order: [], closed: [], error: null }), save: () => ({ ok: true }) };
  const h = await opened({ layout: old });
  assert.strictEqual(entryOf(h, 'feat-a').pinned, false);
  assert.deepStrictEqual(h.shell.pin(key('feat-a')), { ok: true });
});

test('P7: a pin whose folder git no longer lists is forgotten, like the order', async () => {
  const layout = memoryLayout({ pinned: [key('feat-gone'), key('feat-b')] });
  const h = await opened({ layout });
  h.shell.pin(key('feat-a'));
  assert.deepStrictEqual(layout.last().pinned, [key('feat-b'), key('feat-a')]);
});

test('a pin outlives a hand close of its lane (it is visibility: the lane is a Lanes row, still pinned when it comes back)', async () => {
  const layout = memoryLayout();
  const h = await opened({ layout, running: { 7701: wt('feat-a') } });
  h.shell.pin(key('feat-a'));
  await h.shell.closeTab(key('feat-a'));
  await flush();
  assert.deepStrictEqual(layout.last().pinned, [key('feat-a')]);
  assert.strictEqual(layout.last().closed.length, 1);
});

// --- the right-click menu's Pin / Unpin: the shell decides, main only draws and clicks ------------------

test('pinMenu: a lane offers Pin, a pinned lane offers Unpin, develop and companions offer nothing', async () => {
  const h = await opened({ layout: memoryLayout({ pinned: [key('feat-b')] }) });
  assert.deepStrictEqual(h.shell.pinMenu(key('feat-a')), { show: true, pinned: false, label: 'Pin (starts at launch)', target: key('feat-a') });
  assert.deepStrictEqual(h.shell.pinMenu(key('feat-b')), { show: true, pinned: true, label: 'Unpin', target: key('feat-b') });
  for (const k of [key('dev'), key('feat-a') + '|side', key('feat-a') + '|shell', 'c:\nowhere', null, undefined]) {
    assert.strictEqual(h.shell.pinMenu(k).show, false, String(k));
  }
});

test('main.js: the lane tab menu has the Pin / Unpin item, built from tabShell.pinMenu and clicking pin / unpin', () => {
  const fs = require('fs');
  const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const menu = main.slice(main.indexOf('function tabMenuTemplate('), main.indexOf('let win = null;'));
  assert.match(menu, /tabShell\.pinMenu\(key\)/);
  assert.match(menu, /pinState\.pinned \? tabShell\.unpin\(pinState\.target\) : tabShell\.pin\(pinState\.target\)/);
  assert.ok(menu.indexOf('pinItem') > menu.indexOf("if (isShellKey(key))"), 'only the branch tab\'s menu (after the side and shell returns)');
});

test('Dexter 2 (P7): a pin on a lane git still lists but cannot open (detached mid-rebase) is kept, and the lane is pinned when it opens', async () => {
  const layout = memoryLayout({ pinned: [key('feat-a')] });
  const h = await opened({ layout, list: porcelain([['dev', 'develop'], ['feat-a', null], ['feat-b', 'feat/b']]) });
  assert.strictEqual(entryOf(h, 'feat-a'), undefined, 'not a tab yet: git lists it detached');
  h.shell.pin(key('feat-b'));      // any save runs the prune
  assert.ok(layout.saved.length > 0);
  assert.ok(layout.saved.every(s => s.pinned.includes(key('feat-a'))), JSON.stringify(layout.saved.map(s => s.pinned)));
  h.listText = porcelain(FOUR);     // the rebase ended
  await h.shell.poll();
  await flush();
  assert.strictEqual(entryOf(h, 'feat-a').pinned, true);
});

test('P7: a pin whose folder git does not list at all is still forgotten (the prune keys on git\'s whole list)', async () => {
  const layout = memoryLayout({ pinned: [key('feat-a'), key('feat-gone')] });
  const h = await opened({ layout });
  h.shell.pin(key('feat-b'));
  assert.deepStrictEqual(layout.last().pinned, [key('feat-a'), key('feat-b')]);
});

test('Dexter 7: a pin before the first poll has answered is refused, and costs the layout nothing once it has', async () => {
  const layout = memoryLayout({ pinned: [key('feat-b')] });
  const h = harness({ layout });
  assert.strictEqual(h.shell.pin(key('feat-a')).ok, false, 'nothing to pin before git has answered');
  assert.strictEqual(h.shell.unpin(key('feat-b')).ok, true, 'but an unpin of a kept pin is allowed');
  const again = harness({ layout });
  await again.shell.open();
  await flush();
  assert.strictEqual(entryOf(again, 'feat-b').pinned, true, 'the kept pin is there once the first poll has answered');
  again.shell.pin(key('feat-a'));
  assert.deepStrictEqual(layout.last().pinned, [key('feat-b'), key('feat-a')]);
});

test('Dexter 7: a layout that throws on save never breaks pin or unpin', async () => {
  const throwing = { load: () => ({ order: [], closed: [], pinned: [], error: null }), save: () => { throw new Error('disk full'); } };
  const h = await opened({ layout: throwing });
  assert.deepStrictEqual(h.shell.pin(key('feat-a')), { ok: true });
  assert.strictEqual(entryOf(h, 'feat-a').pinned, true, 'pinned in memory whatever the disk says');
  assert.deepStrictEqual(h.shell.unpin(key('feat-a')), { ok: true });
  assert.ok(h.logs.some(l => /layout\.save threw: disk full/.test(l)));
});

test('Miguel S2: one "pinnable" rule serves pin and pinMenu, and the menu click reports a refusal instead of dropping it', () => {
  const fs = require('fs');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-shell.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual((shell.match(/const pinnable = /g) || []).length, 1);
  assert.ok((shell.match(/pinnable\(key\)/g) || []).length >= 2, 'used by setPinned and pinMenu');
  assert.strictEqual((shell.match(/model\(\)\.some\(e => e\.key === key && !isCompanionEntry\(e\) && !e\.isDev\)/g) || []).length, 1, 'the predicate is written once');
  const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const menu = main.slice(main.indexOf('function tabMenuTemplate('), main.indexOf('let win = null;'));
  assert.match(menu, /const done = \(r\) => \{ if \(r && r\.ok === false\) console\.log\(`\[menu\] pin: \$\{r\.error\}`\); \};/);
});
