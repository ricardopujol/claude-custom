'use strict';
/**
 * The shell and a lane started from an issue (BACKLOG #119 A6): `createWorktree(branch, issueNumber)` writes the
 * lane's brief once the worktree exists, the tab remembers its issue, and a failed brief is a line on the tab,
 * never a lost tab. Every effect is a recording fake (the same shape as test/tab-shell.test.js's harness, cut down).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createShell } = require('../app/tab-shell');
const { normPath } = require('../host/project-layout');
const tabModel = require('../app/tab-model');

const ROOT = path.join(os.tmpdir(), 'cc-tabshell-issues');
const wt = (name) => path.join(ROOT, name);
const key = (name) => normPath(wt(name));
const settle = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await settle(); };

const porcelain = (entries) => entries.map(([name, branch]) =>
  `worktree ${wt(name).replace(/\\/g, '/')}\nHEAD 0123456789012345678901234567890123456789\nbranch refs/heads/${branch}\n`).join('\n') + '\n';

const ISSUE = { number: 12, title: 'Fix the thing', labels: ['bug'], assignees: [], updatedAt: null, url: 'https://github.com/o/r/issues/12' };

function harness({ issues, withSetup = false } = {}) {
  const h = { list: porcelain([['dev', 'develop']]), opsCalls: [], briefCalls: [], changes: [], spawns: [], running: {}, order: [] };
  const deps = {
    mode: 'tabs', container: ROOT, cwd: wt('dev'), launchedFrom: null, log: () => {},
    git: { list: async () => { await settle(); return h.list; }, marker: () => null },
    ops: {
      available: () => ({ create: true, setup: withSetup, remove: true }),
      create: async ({ branch }) => {
        h.order.push('create');
        const dir = branch.replace(/\//g, '-');
        h.list += '\n' + porcelain([[dir, branch]]);
        return { ok: true, path: wt(dir), branch, warning: h.warning || null };
      },
      setup: async ({ path: p }) => { h.order.push('setup'); h.opsCalls.push(['setup', p]); return { ok: true, result: null }; },
      remove: async () => ({ ok: true, already: false }),
    },
    hosts: {
      choosePort: async (tab) => ({ port: 7700 + h.spawns.length, action: 'spawn' }),
      probe: async (port) => (h.running[port] ? 'listening' : 'refused'),
      spawn: ({ tab, port }) => { h.spawns.push(tab.key); h.running[port] = true; },
      wait: async () => true, tokenFor: () => 't', tokenFile: () => 't', newToken: () => 't',
      control: async () => ({ ok: true, reply: null }), identity: () => null, readToken: () => null,
    },
    views: { create: (tab) => ({ tab: tab.key }), destroy: () => {}, send: () => {}, owns: (tab, s) => tab.view === s },
    ui: { confirmClose: async () => true, changed: (s) => h.changes.push(s), focusWindow: () => {}, isFocused: () => true },
    sleep: async () => {},
  };
  if (issues !== undefined) {
    deps.issues = issues === null ? null : {
      brief: async (lane) => { h.order.push('brief'); h.briefCalls.push(lane); return typeof issues.brief === 'function' ? issues.brief(lane) : issues.brief; },
      forBranch: (b) => (issues.forBranch ? issues.forBranch(b) : null),
    };
  }
  h.shell = createShell(deps);
  return h;
}

const entry = (h, name) => h.shell.model().find(e => e.key === key(name));

test('an issue number makes the brief for the new worktree, with the branch and path Contract A returned', async () => {
  const h = harness({ issues: { brief: { ok: true, issue: ISSUE, brief: 'C:\\b.md', existed: false } } });
  await h.shell.open();
  await flush();
  const r = await h.shell.createWorktree('fix/12-fix-the-thing', 12);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.briefCalls, [{ number: 12, branch: 'fix/12-fix-the-thing', worktree: wt('fix-12-fix-the-thing') }]);
});

test('the brief is written after the worktree exists and before its setup runs', async () => {
  const h = harness({ withSetup: true, issues: { brief: { ok: true, issue: ISSUE, brief: 'C:\\b.md', existed: false } } });
  await h.shell.open();
  await flush();
  await h.shell.createWorktree('fix/12-fix-the-thing', 12);
  assert.deepStrictEqual(h.order, ['create', 'brief', 'setup']);
});

test('the tab remembers its issue: number, title and link', async () => {
  const h = harness({ issues: { brief: { ok: true, issue: ISSUE, brief: 'C:\\b.md', existed: false } } });
  await h.shell.open();
  await flush();
  await h.shell.createWorktree('fix/12-fix-the-thing', 12);
  await flush();
  assert.deepStrictEqual(entry(h, 'fix-12-fix-the-thing').issue, { number: 12, title: 'Fix the thing', url: 'https://github.com/o/r/issues/12' });
  assert.strictEqual(entry(h, 'dev').issue, null, 'a tab made some other way has none');
});

test('a brief that could not be written keeps the tab, keeps the issue number, and says why on the tab', async () => {
  const h = harness({ issues: { brief: { ok: false, error: "brief-path.ps1 isn't installed (looked in D:\\x).", issue: ISSUE } } });
  await h.shell.open();
  await flush();
  const r = await h.shell.createWorktree('fix/12-fix-the-thing', 12);
  await flush();
  assert.strictEqual(r.ok, true, 'the worktree itself was made');
  const e = entry(h, 'fix-12-fix-the-thing');
  assert.strictEqual(e.issue.number, 12);
  assert.match(tabModel.phaseText(e), /^Created, but: .*brief.*isn't installed/);
});

test('a brief that fails with no issue at all still keeps the number the person picked', async () => {
  const h = harness({ issues: { brief: { ok: false, error: 'Sign in to gh to pick an issue', issue: null } } });
  await h.shell.open();
  await flush();
  await h.shell.createWorktree('fix/12-fix-the-thing', 12);
  await flush();
  assert.deepStrictEqual(entry(h, 'fix-12-fix-the-thing').issue, { number: 12, title: null, url: null });
});

test("Contract A's own warning and a failed brief both show", async () => {
  const h = harness({ issues: { brief: { ok: false, error: 'disk full', issue: ISSUE } } });
  h.warning = 'Active Lanes row not added';
  await h.shell.open();
  await flush();
  await h.shell.createWorktree('fix/12-fix-the-thing', 12);
  await flush();
  const text = tabModel.phaseText(entry(h, 'fix-12-fix-the-thing'));
  assert.match(text, /Active Lanes row not added/);
  assert.match(text, /disk full/);
});

test('a brief writer that throws is the same as one that failed', async () => {
  const h = harness({ issues: { brief: () => { throw new Error('boom'); } } });
  await h.shell.open();
  await flush();
  const r = await h.shell.createWorktree('fix/12-fix-the-thing', 12);
  await flush();
  assert.strictEqual(r.ok, true);
  assert.match(tabModel.phaseText(entry(h, 'fix-12-fix-the-thing')), /boom/);
});

test('no issue number, or one that is not a positive integer: no brief is asked for and the tab has no issue', async () => {
  for (const n of [undefined, null, 0, -3, 1.5, '12', NaN]) {
    const h = harness({ issues: { brief: { ok: true, issue: ISSUE, brief: 'C:\\b.md', existed: false } } });
    await h.shell.open();
    await flush();
    await h.shell.createWorktree('feat/plain', n);
    await flush();
    assert.deepStrictEqual(h.briefCalls, [], String(n));
    assert.strictEqual(entry(h, 'feat-plain').issue, null, String(n));
  }
});

test('a window built without an issues dependency creates exactly as before', async () => {
  const h = harness({ issues: null });
  await h.shell.open();
  await flush();
  const r = await h.shell.createWorktree('feat/plain', 12);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(entry(h, 'feat-plain').issue, null);
});

test('a refused branch never asks for a brief', async () => {
  const h = harness({ issues: { brief: { ok: true, issue: ISSUE, brief: 'C:\\b.md', existed: false } } });
  await h.shell.open();
  await flush();
  const r = await h.shell.createWorktree('-Base', 12);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(h.briefCalls, []);
});

test('a tab the window did not make shows the issue its branch came from, when the list knows it', async () => {
  const known = { number: 7, title: 'Seven', url: 'https://github.com/o/r/issues/7' };
  const h = harness({ issues: { brief: null, forBranch: (b) => (b === 'feat/7-seven' ? known : null) } });
  h.list = porcelain([['dev', 'develop'], ['feat-7-seven', 'feat/7-seven'], ['feat-8-eight', 'feat/8-eight']]);
  await h.shell.open();
  await flush();
  assert.deepStrictEqual(entry(h, 'feat-7-seven').issue, known);
  assert.strictEqual(entry(h, 'feat-8-eight').issue, null);
});

test('an issue answer of the wrong shape draws no issue (decoration never takes the strip down)', async () => {
  for (const bad of [{ number: '7', title: 'x' }, { number: 7, title: 5 }, 'x', 5, [], { title: 'x' }]) {
    const h = harness({ issues: { brief: null, forBranch: () => bad } });
    h.list = porcelain([['dev', 'develop'], ['feat-7-seven', 'feat/7-seven']]);
    await h.shell.open();
    await flush();
    const e = entry(h, 'feat-7-seven');
    assert.ok(e.issue === null || (e.issue.number === 7 && (e.issue.title === null || typeof e.issue.title === 'string')), JSON.stringify(bad));
  }
  const throwing = harness({ issues: { brief: null, forBranch: () => { throw new Error('nope'); } } });
  throwing.list = porcelain([['dev', 'develop'], ['feat-7-seven', 'feat/7-seven']]);
  await throwing.shell.open();
  await flush();
  assert.strictEqual(entry(throwing, 'feat-7-seven').issue, null);
});

test('issueOf(key) is the same record the model shows, or null', async () => {
  const h = harness({ issues: { brief: { ok: true, issue: ISSUE, brief: 'C:\\b.md', existed: false } } });
  await h.shell.open();
  await flush();
  await h.shell.createWorktree('fix/12-fix-the-thing', 12);
  await flush();
  assert.deepStrictEqual(h.shell.issueOf(key('fix-12-fix-the-thing')), entry(h, 'fix-12-fix-the-thing').issue);
  assert.strictEqual(h.shell.issueOf(key('dev')), null);
  assert.strictEqual(h.shell.issueOf('nope'), null);
});

// --- the picker is part of the branch form's state ----------------------------------------------

test('openPicker works only while the branch form is open for typing, and publishes it', async () => {
  const h = harness({ issues: { brief: null } });
  await h.shell.open();
  await flush();
  assert.strictEqual(h.shell.openPicker(), false, 'no form, no picker');
  assert.strictEqual(h.shell.openCreate(), true);
  const before = h.changes.length;
  assert.strictEqual(h.shell.openPicker(), true);
  assert.deepStrictEqual(h.shell.snapshot().create, { phase: 'input', picker: true });
  assert.ok(h.changes.length > before, 'published');
  assert.strictEqual(h.shell.openPicker(), true, 'already open stays open');
});

test('closePicker leaves the form open; Esc on the form (cancelCreate) closes both', async () => {
  const h = harness({ issues: { brief: null } });
  await h.shell.open();
  await flush();
  h.shell.openCreate();
  h.shell.openPicker();
  assert.strictEqual(h.shell.closePicker(), true);
  assert.deepStrictEqual(h.shell.snapshot().create, { phase: 'input' });
  assert.strictEqual(h.shell.closePicker(), false, 'nothing to close');
  h.shell.openPicker();
  assert.strictEqual(h.shell.cancelCreate(), true);
  assert.strictEqual(h.shell.snapshot().create, null);
});

test('a creation closes the picker; a failed one leaves the form without it, and it can be opened again', async () => {
  const h = harness({ issues: { brief: { ok: true, issue: ISSUE, brief: 'C:\b.md', existed: false } } });
  await h.shell.open();
  await flush();
  h.shell.openCreate();
  h.shell.openPicker();
  await h.shell.createWorktree('-bad', 12);
  assert.strictEqual(h.shell.snapshot().create.phase, 'failed');
  assert.strictEqual(h.shell.snapshot().create.picker, undefined);
  assert.strictEqual(h.shell.openPicker(), true, 'a failed form can still pick another issue');
  assert.strictEqual(h.shell.snapshot().create.phase, 'failed');
  assert.strictEqual(h.shell.snapshot().create.picker, true);
});

test('the picker cannot open while a creation runs', async () => {
  const h = harness({ issues: { brief: { ok: true, issue: ISSUE, brief: 'C:\b.md', existed: false } } });
  await h.shell.open();
  await flush();
  h.shell.openCreate();
  const done = h.shell.createWorktree('fix/12-fix-the-thing', 12);
  assert.strictEqual(h.shell.openPicker(), false);
  await done;
});

// --- the probe driver's stripIssues command -----------------------------------------------------

const { handleProbeCommand } = require('../app/tab-shell');
const PT = 'p'.repeat(32);
const probe = (o, api) => handleProbeCommand(JSON.stringify({ ...o, token: PT }), api, PT);

test('stripIssues: a named action and its data reach the driver; anything else is refused by name', async () => {
  const seen = [];
  const api = { stripIssues: async (action, args) => { seen.push([action, args]); return { ok: true, view: {} }; } };
  assert.strictEqual((await probe({ cmd: 'stripIssues', action: 'read' }, api)).ok, true);
  assert.strictEqual((await probe({ cmd: 'stripIssues', action: 'pick', index: 2 }, api)).ok, true);
  assert.strictEqual((await probe({ cmd: 'stripIssues', action: 'filter', text: 'wid' }, api)).ok, true);
  assert.deepStrictEqual(seen.map(s => s[0]), ['read', 'pick', 'filter']);
  assert.deepStrictEqual(seen[1][1].index, 2);
  assert.deepStrictEqual(seen[2][1].text, 'wid');
  const before = seen.length;
  for (const bad of [{ action: 'eval' }, { action: undefined }, { action: 'pick' }, { action: 'pick', index: -1 }, { action: 'pick', index: '1' },
    { action: 'pick', index: 1.5 }, { action: 'filter' }, { action: 'filter', text: 5 }, { action: 'filter', text: 'x'.repeat(201) }]) {
    const r = await probe({ cmd: 'stripIssues', ...bad }, api);
    assert.strictEqual(r.ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(seen.length, before, 'nothing refused reached the driver');
  assert.strictEqual((await handleProbeCommand(JSON.stringify({ cmd: 'stripIssues', action: 'read', token: 'wrong' }), api, PT)).ok, false);
});

test('openCreate: the probe opens the strip\'s branch form, and nothing else is read from the command', async () => {
  const seen = [];
  const api = { openCreate: async (...a) => { seen.push(a); return { ok: true }; } };
  assert.deepStrictEqual(await probe({ cmd: 'openCreate', branch: 'feat/x', evil: 'x' }, api), { ok: true });
  assert.deepStrictEqual(seen, [[]], 'no argument reaches the driver');
});

// --- the brief runs beside the setup, and holds only the session ---------------------------------

function deferredBrief() {
  let release;
  const gate = new Promise((r) => { release = r; });
  return { release: (v) => release(v), brief: () => gate };
}

test('the tab appears and shows its issue number while the brief is still being written; its session waits for the brief', async () => {
  const d = deferredBrief();
  const h = harness({ issues: { brief: d.brief } });
  await h.shell.open();
  await flush();
  const done = h.shell.createWorktree('fix/12-fix-the-thing', 12);
  for (let i = 0; i < 6; i++) await flush();
  assert.ok(h.shell.model().some(e => e.key === key('fix-12-fix-the-thing')), 'the tab is there');
  assert.deepStrictEqual(entry(h, 'fix-12-fix-the-thing').issue, { number: 12, title: null, url: null }, 'the number is known at once');
  assert.strictEqual(h.shell.snapshot().create, null, 'the form is already done');
  assert.ok(!h.spawns.includes(key('fix-12-fix-the-thing')), 'no session before the brief');
  await h.shell.poll();
  await flush();
  assert.ok(!h.spawns.includes(key('fix-12-fix-the-thing')), 'a poll that lists the tab does not start it either');
  await h.shell.select(key('fix-12-fix-the-thing'));
  await flush();
  assert.ok(!h.spawns.includes(key('fix-12-fix-the-thing')), 'nor does selecting it by hand');
  d.release({ ok: true, issue: ISSUE, brief: 'C:\b.md', existed: false });
  await done;
  await flush();
  assert.ok(h.spawns.includes(key('fix-12-fix-the-thing')), 'the session starts once the brief is there');
  assert.deepStrictEqual(entry(h, 'fix-12-fix-the-thing').issue, { number: 12, title: 'Fix the thing', url: 'https://github.com/o/r/issues/12' });
});

test('the brief is asked for before the setup starts and does not wait for it; the session waits for both', async () => {
  const d = deferredBrief();
  const h = harness({ withSetup: true, issues: { brief: d.brief } });
  await h.shell.open();
  await flush();
  const done = h.shell.createWorktree('fix/12-fix-the-thing', 12);
  for (let i = 0; i < 6; i++) await flush();
  assert.deepStrictEqual(h.order, ['create', 'brief', 'setup'], 'setup ran while the brief was still pending');
  assert.ok(!h.spawns.includes(key('fix-12-fix-the-thing')));
  d.release({ ok: true, issue: ISSUE, brief: 'C:\b.md', existed: false });
  await done;
  await flush();
  assert.ok(h.spawns.includes(key('fix-12-fix-the-thing')));
});

test('a brief that fails after the tab is up puts its warning on the tab and still starts the session', async () => {
  const d = deferredBrief();
  const h = harness({ issues: { brief: d.brief } });
  await h.shell.open();
  await flush();
  const done = h.shell.createWorktree('fix/12-fix-the-thing', 12);
  for (let i = 0; i < 6; i++) await flush();
  d.release({ ok: false, error: 'disk full', issue: null });
  await done;
  await flush();
  assert.match(tabModel.phaseText(entry(h, 'fix-12-fix-the-thing')), /^Created, but: the brief wasn't written \(disk full\)/);
  assert.ok(h.spawns.includes(key('fix-12-fix-the-thing')));
  assert.strictEqual(entry(h, 'fix-12-fix-the-thing').issue.number, 12);
});

test('a tab closed by hand while the brief is pending keeps no warning for a later reopen', async () => {
  const d = deferredBrief();
  const h = harness({ issues: { brief: d.brief } });
  await h.shell.open();
  await flush();
  const done = h.shell.createWorktree('fix/12-fix-the-thing', 12);
  for (let i = 0; i < 6; i++) await flush();
  await h.shell.closeTab(key('fix-12-fix-the-thing'));
  d.release({ ok: false, error: 'late failure', issue: null });
  await done;
  await h.shell.reopen(key('fix-12-fix-the-thing'));
  await flush();
  assert.strictEqual(tabModel.phaseText(entry(h, 'fix-12-fix-the-thing')), null);
});
