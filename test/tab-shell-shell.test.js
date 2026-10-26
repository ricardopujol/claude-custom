'use strict';
/**
 * BACKLOG #119 A5: plain shell tabs, in the tab shell (app/tab-shell.js). A branch tab's menu (or the + menu) opens a shell in
 * the tab's folder: a host of its own whose pty runs the person's shell instead of `claude`. It sits right after its branch
 * tab (after the side tab, when there is one), stays until that tab closes, and can be restarted from the same menu once its
 * shell has exited. Modelled on test/tab-shell-side.test.js; every effect is a recording fake.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createShell, handleProbeCommand } = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');
const { sideKeyOf } = require('../host/side-session');
const { shellKeyOf } = require('../host/shell-tab');

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-shell');
const wt = (name) => path.join(ROOT, name);
const key = (name) => normPath(wt(name));
const skey = (name) => shellKeyOf(key(name));
const sidekey = (name) => sideKeyOf(key(name));

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
const roleOf = (o) => (o.shell === true ? 'shell' : o.side === true ? 'side' : 'own');

/** running: port -> { cwd, side, shell } of a live host. */
function harness({ mode = 'tabs', running = {}, listShellHosts = true } = {}) {
  const h = {
    running: { ...running }, spawns: [], controls: [], viewsMade: [], viewsGone: [], sent: [], changes: [],
    confirms: [], confirm: true, tokens: 0, markers: {}, clock: 1_000_000_000, listText: porcelain(THREE),
    order: [], holdShell: null, shellWalks: 0, shellHostReads: 0, controlOk: true, removeHold: null,
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
        if (tab.shell === true) { h.shellWalks++; if (h.holdShell) await h.holdShell; }
        let free = null;
        for (let p = base; p < base + 50; p++) {
          const occ = h.running[p];
          if (occ === undefined) { if (free === null) free = p; continue; }
          if (normPath(occ.cwd) === normPath(tab.cwd) && roleOf(occ) === roleOf(tab)) return { port: p, action: 'attach' };
        }
        return free === null ? null : { port: free, action: 'spawn' };
      },
      probe: async (port) => (h.running[port] !== undefined ? 'listening' : 'refused'),
      spawn: ({ tab, port, token }) => {
        h.spawns.push({ key: tab.key, port, token, side: tab.side === true, shell: tab.shell === true, cwd: tab.cwd });
        h.running[port] = { cwd: tab.cwd, side: tab.side === true, shell: tab.shell === true };
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
      sideHosts: () => Object.entries(h.running).filter(([, o]) => o.side === true).map(([p, o]) => ({ port: Number(p), cwd: o.cwd })),
      shellHosts: () => {
        h.shellHostReads++;
        return Object.entries(h.running).filter(([, o]) => o.shell === true).map(([p, o]) => ({ port: Number(p), cwd: o.cwd }));
      },
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
  if (!listShellHosts) delete deps.hosts.shellHosts;
  h.shell = createShell(deps);
  return h;
}

const labels = (h) => h.shell.model().map(e => e.label);
const SHELL_A = 'feat/a · shell';
const SIDE_A = 'feat/a · side';
const dev = (extra) => ({ cwd: wt('dev'), ...extra });
const featA = (extra) => ({ cwd: wt('feat-a'), ...extra });

async function opened(over = {}) {
  const h = harness({ running: { 7700: dev(), 7701: featA() }, ...over });
  await h.shell.open();
  await flush();
  return h;
}

// --- opening it -----------------------------------------------------------------------------------------------

test('Open shell spawns a SECOND host for the same folder, told it is a shell host, on its own port', async () => {
  const h = await opened();
  const r = await h.shell.openShell(key('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.spawns, [{ key: skey('feat-a'), port: 7702, token: 'fresh-1', side: false, shell: true, cwd: wt('feat-a') }]);
  assert.strictEqual(h.running[7701].shell, undefined, 'the branch tab\'s own host is untouched');
});

test('the shell tab sits right after its branch tab, labelled "<branch> · shell", is selected, started, and has a page', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SHELL_A, 'feat/b']);
  const e = h.shell.model().find(x => x.label === SHELL_A);
  assert.strictEqual(e.key, skey('feat-a'));
  assert.strictEqual(e.shell, true);
  assert.notStrictEqual(e.side, true, 'a shell is not a side session');
  assert.strictEqual(e.parentKey, key('feat-a'));
  assert.strictEqual(e.role, undefined, 'a shell can write: it is not a reader');
  assert.strictEqual(e.selected, true);
  assert.strictEqual(e.started, true);
  assert.strictEqual(e.closable, true, 'it has a close of its own (Ricardo\'s look, 2026-10-26: a shell tab could not be closed)');
  assert.strictEqual(h.shell.model().filter(x => x.selected).length, 1, 'exactly one tab is selected');
  assert.ok(h.viewsMade.some(v => v.tab === skey('feat-a')));
});

test('opened once per lane: asking again selects the live one and spawns nothing', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  await h.shell.select(key('feat-b'));
  const again = await h.shell.openShell(key('feat-a'));
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.already, true);
  assert.strictEqual(h.spawns.filter(s => s.shell).length, 1, 'one shell host, ever');
  assert.strictEqual(h.shell.model().find(e => e.selected).key, skey('feat-a'));
  assert.strictEqual(labels(h).filter(l => l === SHELL_A).length, 1);
});

test('opening it from the shell tab itself acts on the lane: it goes to the same shell', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  const r = await h.shell.openShell(skey('feat-a'));
  assert.strictEqual(r.ok, false, 'no shell of a shell');
  assert.strictEqual(h.spawns.length, 1);
});

test('the develop tab can have a shell too', async () => {
  const h = await opened();
  assert.strictEqual((await h.shell.openShell(key('dev'))).ok, true);
  assert.deepStrictEqual(labels(h), ['develop', 'develop · shell', 'feat/a', 'feat/b']);
});

test('refused: a single-folder window, a tab that is not there, no key, a side tab\'s own shell', async () => {
  const single = harness({ mode: 'single', running: { 7700: dev() } });
  await single.shell.open();
  assert.strictEqual((await single.shell.openShell(key('dev'))).ok, false);

  const h = await opened();
  assert.strictEqual((await h.shell.openShell(key('ghost'))).ok, false);
  assert.strictEqual((await h.shell.openShell(undefined)).ok, false);
  await h.shell.openSide(key('feat-a'));
  assert.strictEqual((await h.shell.openShell(sidekey('feat-a'))).ok, false, 'no shell of a side tab');
  assert.strictEqual(h.spawns.filter(s => s.shell).length, 0);
});

test('a shell and a side session live side by side on one lane: branch, side, shell, in that order, on three hosts', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  await h.shell.openSide(key('feat-a'));
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SIDE_A, SHELL_A, 'feat/b']);
  assert.deepStrictEqual(h.spawns.map(s => [s.side, s.shell]), [[false, true], [true, false]]);
  assert.strictEqual(new Set(h.spawns.map(s => s.port)).size, 2);
  assert.strictEqual(h.shell.sideMenu(key('feat-a')).label, 'Go to side session');
  assert.strictEqual(h.shell.shellMenu(key('feat-a')).label, 'Go to shell');
});

// --- it stays -------------------------------------------------------------------------------------------------

test('it stays: polls and other selections do not close it', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  await h.shell.select(key('feat-b'));
  await h.shell.poll();
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SHELL_A, 'feat/b']);
  assert.deepStrictEqual(h.viewsGone, []);
  assert.strictEqual(h.controls.length, 0, 'nothing was stopped');
});

test('Ctrl+Tab walks through the shell tab in strip order', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  await h.shell.select(key('feat-a'));
  await h.shell.next();
  assert.strictEqual(h.shell.model().find(e => e.selected).key, skey('feat-a'));
  await h.shell.next();
  assert.strictEqual(h.shell.model().find(e => e.selected).key, key('feat-b'));
});

// --- closing it by hand (Ricardo's look, 2026-10-26: "a shell tab can't be closed") ------------------------------

test('closing the shell tab by hand stops ITS host only, drops its page, asks nothing, and goes back to its branch tab', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  const r = await h.shell.closeTab(skey('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stopError, undefined);
  // The stop is what makes the host end its pty tree by pid (host/pty-stop.js, host/kill-tree.js) and remove its identity file.
  assert.deepStrictEqual(h.controls.filter(c => c.msg.type === 'stop').map(c => [c.port, c.token]), [[7702, 'tok-7702']]);
  assert.strictEqual(h.running[7702], undefined, 'the shell host is gone');
  assert.ok(h.running[7701], 'the branch tab\'s own host is untouched');
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  assert.ok(h.viewsGone.includes(skey('feat-a')));
  assert.deepStrictEqual(h.confirms, [], 'a terminal closes without a question; the folder stays');
  const sel = h.shell.model().filter(e => e.selected);
  assert.deepStrictEqual(sel.map(e => e.key), [key('feat-a')], 'the lane it belonged to is what shows next');
});

test('the develop tab\'s shell closes too: that tab never closes, so its shell had no way to end at all', async () => {
  const h = await opened();
  await h.shell.openShell(key('dev'));
  const r = await h.shell.closeTab(shellKeyOf(key('dev')));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.controls.filter(c => c.msg.type === 'stop').map(c => c.port), [7702]);
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  assert.strictEqual(h.shell.model().find(e => e.selected).key, key('dev'));
});

test('closing a shell tab that was NOT showing leaves the selection where it was', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  await h.shell.select(key('feat-b'));
  assert.strictEqual((await h.shell.closeTab(skey('feat-a'))).ok, true);
  assert.strictEqual(h.shell.model().find(e => e.selected).key, key('feat-b'));
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
});

test('the tab menu offers the close on a shell tab, and still not on a side tab', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  await h.shell.openSide(key('feat-a'));
  assert.strictEqual(h.shell.menuState(skey('feat-a')).close, true);
  assert.strictEqual(h.shell.menuState(sidekey('feat-a')).close, false, 'a side tab still ends with its branch tab (#81)');
  assert.strictEqual(h.shell.model().find(e => e.key === sidekey('feat-a')).closable, false);
  assert.strictEqual((await h.shell.closeTab(sidekey('feat-a'))).ok, false);
});

test('a shell host that does not answer its stop: the tab still goes, and the strip says it may still be running', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  h.controlOk = false;
  const r = await h.shell.closeTab(skey('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stopError, 'no answer');
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  assert.match(h.changes[h.changes.length - 1].closeNotice, /Couldn't end the shell in feat\/a · shell: no answer\. It may still be running\./);
});

test('an exited shell closes with no stop sent: its port may be another host\'s by now', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  delete h.running[7702];
  await h.shell.poll();
  const r = await h.shell.closeTab(skey('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.controls.length, 0);
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', 'feat/b']);
  assert.strictEqual(h.changes[h.changes.length - 1].closeNotice, null);
});

test('a shell closed while its start is still walking the ports never spawns', async () => {
  const h = await opened();
  let release;
  h.holdShell = new Promise(r => { release = r; });
  const opening = h.shell.openShell(key('feat-a'));
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

test('a double click on the close is one close: one stop', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  const [a, b] = await Promise.all([h.shell.closeTab(skey('feat-a')), h.shell.closeTab(skey('feat-a'))]);
  assert.deepStrictEqual([a.ok, b.ok].sort(), [false, true]);
  assert.strictEqual(h.controls.filter(c => c.msg.type === 'stop').length, 1);
});

test('a closed shell is not offered back by the + menu\'s Reopen, and Open shell here starts a fresh one', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  await h.shell.closeTab(skey('feat-a'));
  assert.deepStrictEqual(h.shell.plusMenu().reopen, []);
  assert.strictEqual(h.shell.shellMenu(key('feat-a')).label, 'Open shell here');
  const r = await h.shell.openShell(key('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(r.already, true);
  assert.strictEqual(h.spawns.filter(s => s.shell).length, 2);
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SHELL_A, 'feat/b']);
});

// --- it ends with its branch tab -------------------------------------------------------------------------------

test('closing the branch tab stops the shell host too, closes its page, and selects a real tab', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  const r = await h.shell.closeTab(key('feat-a'));
  assert.strictEqual(r.ok, true);
  await flush();
  assert.deepStrictEqual(h.controls.filter(c => c.msg.type === 'stop').map(c => c.port).sort(), [7701, 7702]);
  assert.deepStrictEqual(labels(h), ['develop', 'feat/b']);
  assert.ok(h.viewsGone.includes(skey('feat-a')));
  const sel = h.shell.model().filter(e => e.selected);
  assert.strictEqual(sel.length, 1);
  assert.notStrictEqual(sel[0].shell, true, 'never a shell tab that is gone');
});

test('closing a branch tab that has a side session AND a shell stops all three hosts', async () => {
  const h = await opened();
  await h.shell.openSide(key('feat-a'));
  await h.shell.openShell(key('feat-a'));
  await h.shell.closeTab(key('feat-a'));
  await flush();
  assert.deepStrictEqual(h.controls.filter(c => c.msg.type === 'stop').map(c => c.port).sort(), [7701, 7702, 7703]);
  assert.deepStrictEqual(labels(h), ['develop', 'feat/b']);
});

test('closing a tab that was NOT showing leaves the selection where it was', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  await h.shell.select(key('feat-b'));
  await h.shell.closeTab(key('feat-a'));
  assert.strictEqual(h.shell.model().find(e => e.selected).key, key('feat-b'));
});

test('closing a branch tab with no shell stops only its own host', async () => {
  const h = await opened();
  await h.shell.closeTab(key('feat-a'));
  assert.deepStrictEqual(h.controls.map(c => c.port), [7701]);
});

test('a worktree git no longer lists takes its shell with it', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  h.listText = porcelain([['dev', 'develop'], ['feat-b', 'feat/b']]);
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/b']);
  assert.deepStrictEqual(h.controls.map(c => c.port).sort(), [7701, 7702]);
});

// --- exited: restart from the same menu ------------------------------------------------------------------------

test('the menu offers Open shell here, then Go to shell, then Restart shell once the shell has exited', async () => {
  const h = await opened();
  assert.deepStrictEqual(h.shell.shellMenu(key('feat-a')), { enabled: true, label: 'Open shell here', target: key('feat-a') });
  await h.shell.openShell(key('feat-a'));
  assert.deepStrictEqual(h.shell.shellMenu(key('feat-a')), { enabled: true, label: 'Go to shell', target: key('feat-a') });
  delete h.running[7702];            // the shell exited, and the host with it
  await h.shell.poll();
  assert.deepStrictEqual(h.shell.shellMenu(key('feat-a')), { enabled: true, label: 'Restart shell', target: key('feat-a') });
  assert.deepStrictEqual(h.shell.shellMenu(skey('feat-a')), { enabled: true, label: 'Restart shell', target: key('feat-a') });
});

test('an exited shell says so on its tab', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  assert.ok(!/exited/.test(h.shell.model().find(e => e.key === skey('feat-a')).phaseText || ''));
  delete h.running[7702];
  await h.shell.poll();
  const e = h.shell.model().find(x => x.key === skey('feat-a'));
  assert.match(e.phaseText, /shell has exited/i);
  assert.match(e.phaseText, /Restart/);
});

test('a restarted shell is fresh: a new host, one tab, selected, the dead page dropped', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  delete h.running[7702];
  await h.shell.poll();
  const r = await h.shell.openShell(key('feat-a'));
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(r.already, true);
  assert.strictEqual(h.spawns.length, 2);
  assert.strictEqual(labels(h).filter(l => l === SHELL_A).length, 1);
  assert.strictEqual(h.shell.model().find(e => e.selected).key, skey('feat-a'));
  assert.ok(h.viewsGone.includes(skey('feat-a')));
});

test('the menu is off in a single-folder window, with the reason', async () => {
  const h = harness({ mode: 'single', running: { 7700: dev() } });
  await h.shell.open();
  const s = h.shell.shellMenu(key('dev'));
  assert.strictEqual(s.enabled, false);
  assert.ok(s.why.length > 0);
});

test('the + menu offers a Shell tab for the SELECTED lane, whether the lane or its shell is showing', async () => {
  const h = await opened();
  await h.shell.select(key('feat-b'));
  assert.deepStrictEqual(h.shell.plusMenu().shell, { enabled: true, label: 'Shell tab', target: key('feat-b') });
  await h.shell.openShell(key('feat-a'));
  assert.deepStrictEqual(h.shell.plusMenu().shell, { enabled: true, label: 'Go to shell', target: key('feat-a') });
});

// --- adopt on reopen ------------------------------------------------------------------------------------------

test('a shell still running when the window reopens is found again, not lost', async () => {
  const h = harness({ running: { 7700: dev(), 7701: featA(), 7702: featA({ shell: true }) } });
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SHELL_A, 'feat/b']);
  assert.strictEqual(h.spawns.length, 0);
  assert.strictEqual(h.shell.shellMenu(key('feat-a')).label, 'Go to shell');
});

test('a branch tab never picks up the shell host as its own, even when the shell host answers first', async () => {
  const h = harness({ running: { 7700: dev(), 7701: featA({ shell: true }), 7702: featA() } });
  await h.shell.open();
  await flush();
  assert.strictEqual(h.shell.tabByKey(key('feat-a')).port, 7702);
  assert.strictEqual(h.shell.tabByKey(skey('feat-a')).port, 7701);
  assert.strictEqual(h.shell.tabByKey(sidekey('feat-a')), null, 'and it is not adopted as a side session either');
});

test('opening a window walks the ports for a shell host only where an identity file says one serves that folder', async () => {
  const none = harness({ running: { 7700: dev(), 7701: featA() } });
  await none.shell.open();
  await flush();
  assert.strictEqual(none.shellWalks, 0, 'no shell host anywhere: no walk at all');
  assert.ok(none.shellHostReads >= 1, 'the identity files were read');
  assert.strictEqual(none.shellHostReads, 1, 'once per batch of tabs, not once per tab');

  const one = harness({ running: { 7700: dev(), 7701: featA(), 7702: featA({ shell: true }) } });
  await one.shell.open();
  await flush();
  assert.strictEqual(one.shellWalks, 1);
});

test('given no way to list shell hosts, each tab is still looked for the slow way, so nothing is lost', async () => {
  const h = harness({ running: { 7700: dev(), 7701: featA(), 7702: featA({ shell: true }) }, listShellHosts: false });
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(labels(h), ['develop', 'feat/a', SHELL_A, 'feat/b']);
});

test('a shell host found AFTER its branch tab closed is stopped, not left running with no tab', async () => {
  const h = harness({ running: { 7700: dev(), 7701: featA(), 7702: featA({ shell: true }) } });
  let release;
  h.holdShell = new Promise((r) => { release = r; });
  await h.shell.open();
  await flush();
  await h.shell.closeTab(key('feat-a'));
  release();
  await flush();
  assert.strictEqual(h.controls.filter(c => c.port === 7702 && c.msg.type === 'stop').length, 1);
  assert.strictEqual(h.shell.tabByKey(skey('feat-a')), null);
});

// --- /merged: the folder must be free for the remover ------------------------------------------------------------

test('/merged with a shell open: the shell is stopped BEFORE the worktree remover runs, and its tab goes', async () => {
  const h = await opened();
  h.markers[key('feat-a')] = 'feat/a';
  await h.shell.poll();
  await h.shell.openShell(key('feat-a'));
  await h.shell.poll();
  delete h.running[7701];
  h.order.length = 0;
  await h.shell.poll();
  await flush();
  assert.deepStrictEqual(h.order, ['stop:7702', 'remove'], 'the folder must be free when the remover looks');
  assert.strictEqual(h.shell.tabByKey(skey('feat-a')), null);
});

test('no shell while the branch\'s folder is being removed: the menu says so and openShell refuses', async () => {
  const h = await opened();
  h.markers[key('feat-a')] = 'feat/a';
  h.removeHold = new Promise(() => {});
  await h.shell.poll();
  delete h.running[7701];
  await h.shell.poll();
  await flush();
  const m = h.shell.shellMenu(key('feat-a'));
  assert.strictEqual(m.enabled, false);
  assert.match(m.why, /removed/);
  assert.strictEqual((await h.shell.openShell(key('feat-a'))).ok, false);
  assert.strictEqual(h.spawns.filter(s => s.shell).length, 0);
});

// --- its signals are its own ------------------------------------------------------------------------------------

const AT_REST = { working: false, needsInput: false, lock: 'held', turn: 'idle' };

test('a shell tab reports its own status (what OSC 7501 gives it), apart from its branch tab\'s', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  h.shell.report(h.shell.tabByKey(skey('feat-a')).view, { ...AT_REST, working: true });
  assert.strictEqual(h.shell.model().find(e => e.key === skey('feat-a')).working, true);
  assert.strictEqual(h.shell.model().find(e => e.key === key('feat-a')).working, false);
});

test('the shell tab entry carries the program own state (OSC 7501), because that is its only feed: the dots and the tooltip read it', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  const view = h.shell.tabByKey(skey('feat-a')).view;
  assert.strictEqual(h.shell.model().find(e => e.key === skey('feat-a')).program, null, 'a program that says nothing shows nothing');
  await h.shell.select(key('feat-b'));     // looking at it would answer the need at once
  const program = { state: 'blocked', kind: 'permission', msg: 'Allow cargo publish?', progress: null };
  h.shell.report(view, { ...AT_REST, needsInput: true, program });
  const e = h.shell.model().find(x => x.key === skey('feat-a'));
  assert.deepStrictEqual(e.program, program);
  assert.strictEqual(e.needsInput, true);
  h.shell.report(view, { ...AT_REST, finished: true, program: { state: 'done', kind: null, msg: null, progress: null } });
  assert.strictEqual(h.shell.model().find(x => x.key === skey('feat-a')).pulse, 'done');
});

test('a branch tab that needs you keeps pulsing while its shell tab is the one showing', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  h.shell.report(h.shell.tabByKey(key('feat-a')).view, { ...AT_REST, needsInput: true });
  const parent = h.shell.model().find(e => e.key === key('feat-a'));
  assert.strictEqual(parent.pulse, 'needs');
  assert.strictEqual(parent.selected, false);
});

test('a shell tab shows no issue link and no brief marker, as a side tab does not', async () => {
  const h = await opened();
  await h.shell.openShell(key('feat-a'));
  const e = h.shell.model().find(x => x.key === skey('feat-a'));
  assert.strictEqual(e.issue, null);
  assert.strictEqual(e.briefing, false);
});

test('a shell tab whose host could not start says why, and is still there to retry', async () => {
  const h = await opened();
  for (let p = 7702; p < 7750; p++) h.running[p] = { cwd: wt('elsewhere') };   // no free port
  const r = await h.shell.openShell(key('feat-a'));
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

test('the probe driver can open a shell by label, and refuses it without one', async () => {
  const seen = [];
  const api = { shellOpen: async (label) => { seen.push(label); return { ok: true }; } };
  assert.deepStrictEqual(await probe({ cmd: 'shell-open', label: 'feat/a' }, api), { ok: true });
  assert.deepStrictEqual(seen, ['feat/a']);
  for (const bad of [{}, { label: '' }, { label: 5 }]) {
    assert.strictEqual((await probe({ cmd: 'shell-open', ...bad }, api)).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(seen.length, 1);
});

test('the probe driver can click a tab\'s x and its menu\'s items by label (Ricardo\'s look, 2026-10-26), and refuses them without one', async () => {
  const seen = [];
  const api = {
    xClick: async (label) => { seen.push(['x', label]); return { ok: true }; },
    tabMenu: async (label, item) => { seen.push(['menu', label, item]); return { ok: true, items: [] }; },
  };
  assert.deepStrictEqual(await probe({ cmd: 'xClick', label: SHELL_A }, api), { ok: true });
  assert.deepStrictEqual(await probe({ cmd: 'tabMenu', label: SHELL_A }, api), { ok: true, items: [] });
  assert.deepStrictEqual(await probe({ cmd: 'tabMenu', label: SHELL_A, item: 'Close shell' }, api), { ok: true, items: [] });
  assert.deepStrictEqual(seen, [['x', SHELL_A], ['menu', SHELL_A, undefined], ['menu', SHELL_A, 'Close shell']]);
  for (const bad of [{}, { label: '' }, { label: 5 }]) {
    assert.strictEqual((await probe({ cmd: 'xClick', ...bad }, api)).ok, false, JSON.stringify(bad));
    assert.strictEqual((await probe({ cmd: 'tabMenu', ...bad }, api)).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual((await probe({ cmd: 'tabMenu', label: SHELL_A, item: 5 }, api)).ok, false, 'an item is a label');
  assert.strictEqual(seen.length, 3);
});
