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

function harness() {
  const h = { running: {}, spawns: [], created: [], destroyed: [], clock: 1_000_000_000 };
  const tokenOf = (port) => (h.running[port] === undefined ? null : `tok-${port}`);
  const deps = {
    mode: 'tabs', container: ROOT, cwd: wt('dev'), launchedFrom: null, log: () => {},
    git: { list: async () => { await settle(); return porcelain([['dev', 'develop'], ['feat-a', 'feat/a'], ['feat-b', 'feat/b']]); }, marker: () => null },
    ops: { available: () => ({ create: false, setup: false, remove: false }), create: async () => ({ ok: false, error: 'no' }), setup: async () => ({ ok: false, error: 'no' }), remove: async () => ({ ok: true }) },
    hosts: {
      choosePort: async (tab) => {
        for (let p = 7800; p < 7850; p++) { if (h.running[p] !== undefined && normPath(h.running[p]) === tab.key) return { port: p, action: 'attach' }; }
        for (let p = 7800; p < 7850; p++) if (h.running[p] === undefined) return { port: p, action: 'spawn' };
        return null;
      },
      probe: async (port) => (h.running[port] !== undefined ? 'listening' : 'refused'),
      spawn: ({ tab, port }) => { h.spawns.push(tab.key); h.running[port] = tab.cwd; },
      wait: async () => true, tokenFor: tokenOf, tokenFile: tokenOf, newToken: () => 'fresh',
      control: async () => ({ ok: true, reply: null }), identity: () => null, readToken: () => null,
    },
    views: { create: (tab) => { h.created.push(tab.key); return { tab: tab.key }; }, destroy: (t) => { h.destroyed.push(t.key); }, send: () => {}, owns: (tab, s) => tab.view === s },
    ui: { confirmClose: async () => true, changed: () => {}, focusWindow: () => {}, isFocused: () => true },
    now: () => h.clock,
  };
  h.shell = createShell(deps);
  h.endSession = (name) => { for (const [p, cwd] of Object.entries(h.running)) if (normPath(cwd) === key(name)) delete h.running[p]; };
  h.live = (name) => Object.values(h.running).some(cwd => normPath(cwd) === key(name));
  h.record = (name) => h.shell.snapshot().model.find(e => e.key === key(name));
  return h;
}

async function opened() { const h = harness(); await h.shell.open(); await flush(); return h; }

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
