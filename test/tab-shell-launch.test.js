'use strict';
/**
 * The launch set (BACKLOG #166, #167; documentation/DESIGN_TABS_SESSIONS.md 3.1, Ricardo's picks P1 and P10): develop's session starts
 * the moment the window opens, before the first git poll, and the poll reconciles; then the pinned lanes start, in strip order, each
 * through the shell's one start chain. A pin git no longer lists, a lane closed by hand and every unpinned lane start nothing. Opened
 * from a lane's worktree, that lane starts first and develop follows. Every effect is a recording fake.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createShell } = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-launch');
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
const flush = async () => { for (let i = 0; i < 10; i++) await settle(); };

function memoryLayout(seed = {}) {
  const l = { saved: [], load: () => ({ order: seed.order || [], closed: (seed.closed || []).map(c => ({ ...c })), pinned: seed.pinned || [], error: null }) };
  l.save = (v) => { l.saved.push(JSON.parse(JSON.stringify(v))); return { ok: true }; };
  return l;
}

function harness({ list = porcelain(FOUR), running = {}, layout, launchedFrom = null } = {}) {
  const h = { running: { ...running }, spawns: [], controls: [], logs: [], listText: list, gitGate: null, listCalls: 0, failWait: new Set() };
  const base = 7700;
  const tokenOf = (port) => (h.running[port] === undefined ? null : `tok-${port}`);
  const deps = {
    mode: 'tabs', container: ROOT, cwd: wt('dev'), launchedFrom, log: (...a) => h.logs.push(a.join(' ')),
    git: {
      list: async () => { h.listCalls++; if (h.gitGate) await h.gitGate; await settle(); return h.listText; },
      marker: () => null,
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
      wait: async (port) => !h.failWait.has(normPath(h.running[port] || '')),
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

test('P10: develop starts the moment the window opens, before the first git poll has answered', async () => {
  const h = harness();
  let release;
  h.gitGate = new Promise(r => { release = r; });
  const opening = h.shell.open();
  await flush();
  assert.ok(h.listCalls >= 1, 'the poll has started and is held');
  assert.deepStrictEqual(h.spawns, [key('dev')], 'develop is already started, from the launch folder');
  release();
  await opening;
  await flush();
  assert.deepStrictEqual(h.spawns, [key('dev')], 'the poll reconciles: no second start, no second record');
  const snap = h.shell.snapshot();
  assert.deepStrictEqual(snap.strip.map(e => e.key), [key('dev')]);
  assert.strictEqual(snap.selectedKey, key('dev'));
  assert.strictEqual(snap.model.find(e => e.key === key('dev')).started, true);
  assert.strictEqual(h.shell.tabByKey(key('dev')).branch, 'develop', 'the record takes its branch from git once git has answered');
});

test('P10: develop already running (a host from before this window) is attached, not spawned again', async () => {
  const h = await opened({ running: { 7700: wt('dev') } });
  assert.deepStrictEqual(h.spawns, []);
  assert.strictEqual(h.shell.snapshot().model.find(e => e.key === key('dev')).started, true);
});

test('P10: develop closed by hand last time is not started at launch', async () => {
  const layout = memoryLayout({ closed: [{ key: key('dev'), path: wt('dev'), branch: 'develop' }] });
  const h = await opened({ layout });
  assert.deepStrictEqual(h.spawns, []);
});

test('P1: the pinned lanes start at launch, in strip order, right after develop; unpinned lanes start nothing', async () => {
  const layout = memoryLayout({ order: [key('feat-c'), key('feat-a')], pinned: [key('feat-a'), key('feat-c')] });
  const h = await opened({ layout });
  assert.deepStrictEqual(h.spawns, [key('dev'), key('feat-c'), key('feat-a')]);
  assert.strictEqual(h.spawns.includes(key('feat-b')), false);
  const snap = h.shell.snapshot();
  assert.deepStrictEqual(snap.strip.map(e => e.key), [key('dev'), key('feat-c'), key('feat-a')], 'three live tabs on the strip');
  assert.ok(snap.strip.every(e => e.started === true));
});

test('P1: pinned lanes already running are attached, not spawned', async () => {
  const layout = memoryLayout({ pinned: [key('feat-a')] });
  const h = await opened({ layout, running: { 7701: wt('feat-a') } });
  assert.deepStrictEqual(h.spawns, [key('dev')]);
  assert.strictEqual(h.shell.snapshot().model.find(e => e.key === key('feat-a')).started, true);
});

test('P7: a pin whose lane git no longer lists starts nothing and is forgotten', async () => {
  const layout = memoryLayout({ pinned: [key('feat-gone'), key('feat-a')] });
  const h = await opened({ layout });
  assert.deepStrictEqual(h.spawns, [key('dev'), key('feat-a')]);
  assert.deepStrictEqual(layout.saved[layout.saved.length - 1].pinned, [key('feat-a')]);
});

test('a pinned lane closed by hand is not brought back by the launch', async () => {
  const layout = memoryLayout({ pinned: [key('feat-a'), key('feat-b')], closed: [{ key: key('feat-a'), path: wt('feat-a'), branch: 'feat/a' }] });
  const h = await opened({ layout });
  assert.deepStrictEqual(h.spawns, [key('dev'), key('feat-b')]);
});

test('a pinned lane that fails to start shows its error and holds nobody else', async () => {
  const layout = memoryLayout({ pinned: [key('feat-a'), key('feat-b')] });
  const h = harness({ layout });
  h.failWait.add(key('feat-a'));
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(h.spawns, [key('dev'), key('feat-a'), key('feat-b')]);
  assert.match(h.shell.tabByKey(key('feat-a')).error, /did not come up/);
  assert.strictEqual(h.shell.tabByKey(key('feat-b')).started, true);
  assert.strictEqual(h.shell.tabByKey(key('dev')).started, true);
});

test('the launch set runs once: a later pin starts nothing by itself, and a later poll starts nothing', async () => {
  const h = await opened();
  assert.deepStrictEqual(h.spawns, [key('dev')]);
  h.shell.pin(key('feat-a'));
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(h.spawns, [key('dev')]);
  assert.ok(h.shell.snapshot().strip.some(e => e.key === key('feat-a')), 'but the pinned lane is on the strip, idle');
});

test('opened from a lane\'s worktree: that lane starts first, develop follows, then the pins', async () => {
  const layout = memoryLayout({ pinned: [key('feat-a')] });
  const h = await opened({ layout, launchedFrom: wt('feat-b') });
  assert.deepStrictEqual(h.spawns, [key('feat-b'), key('dev'), key('feat-a')]);
});

test('a git that cannot list at first still gets its launch set once it can, and develop is not held up by it', async () => {
  const layout = memoryLayout({ pinned: [key('feat-a')] });
  const h = harness({ layout });
  h.listText = null;
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(h.spawns, [key('dev')], 'develop came up regardless');
  h.listText = porcelain(FOUR);
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(h.spawns, [key('dev'), key('feat-a')]);
});

test('an early develop that git does not list is ended, not left running with no tab', async () => {
  const h = harness({ list: porcelain([['feat-a', 'feat/a']]) });
  await h.shell.open();
  await flush();
  assert.strictEqual(h.shell.tabByKey(key('dev')), null, 'no tab record for a folder git does not list');
  assert.strictEqual(h.controls.filter(c => c.msg.type === 'stop').length, 1, 'its session was asked to stop');
});
