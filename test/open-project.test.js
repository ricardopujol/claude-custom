'use strict';
/**
 * app/open-project.js (single-instance PR 3 step 6): openProject({ cwd, port, show, env }) is main's ONE in-process entry for opening a
 * project (the app pipe's handed-off launch, the tray, the ▾ menu, the probe driver, a restore), over fakes.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createOpenProject } = require('../app/open-project');

function rig({ open = {}, start = null, gone = [], ownEnv = {} } = {}) {
  const lines = [];
  const calls = [];
  const closed = [];
  const tabs = [{ key: 'develop', cwd: 'C:/p/dev', port: 7001 }, { key: 'feat-a', cwd: 'C:/p/feat-a', port: 7002 }];
  const win = (root, mode = 'tabs') => ({
    root, mode, label: root, selected: null,
    tabShell: { snapshot: () => ({ tabs }), select(k) { this.owner.selected = k; } },
  });
  const windows = {};
  for (const r of Object.keys(open)) { windows[r] = win(r); windows[r].tabShell.owner = windows[r]; }
  const startProject = async (cwd, opts) => {
    calls.push(['startProject', cwd, opts]);
    if (start) return start(cwd, opts, win);
    const root = cwd.replace(/\/(dev|feat-\w+)$/, '');
    if (windows[root]) return { pw: windows[root], existing: true, first: null };
    const pw = win(root); pw.tabShell.owner = pw;
    windows[root] = pw;
    return { pw, existing: false, first: { started: true } };
  };
  const op = createOpenProject({
    startProject,
    exists: (p) => !gone.includes(p),
    pickLane: require('../host/window-owner').pickLane,
    envNames: ['CLAUDE_CUSTOM_BIN', 'CLAUDE_CUSTOM_CONPTY', 'CLAUDE_CUSTOM_SHELL'],
    ownEnv,
    closeWindow: (pw) => closed.push(pw.root),
    log: (l) => lines.push(l),
  });
  return { op, lines, calls, closed, windows };
}

test('an open root is brought forward through startProject, and the port\'s lane is selected', async () => {
  const t = rig({ open: { 'C:/p': true } });
  const r = await t.op.openProject({ cwd: 'C:/p/dev', port: 7002 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.existing, true);
  assert.strictEqual(t.windows['C:/p'].selected, 'feat-a');
});

test('a new root goes through startProject, shown by default', async () => {
  const t = rig();
  const r = await t.op.openProject({ cwd: 'C:/q/dev' });
  assert.deepStrictEqual(t.calls, [['startProject', 'C:/q/dev', { show: 'shown' }]]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.existing, false);
  await t.op.openProject({ cwd: 'C:/z/dev', show: 'hidden' });
  assert.deepStrictEqual(t.calls[1][2], { show: 'hidden' });
});

test('a folder that is gone is logged and opens nothing', async () => {
  const t = rig({ gone: ['C:/gone/dev'] });
  const r = await t.op.openProject({ cwd: 'C:/gone/dev' });
  assert.deepStrictEqual(r, { ok: false, error: 'the folder is gone' });
  assert.deepStrictEqual(t.calls, []);
  assert.ok(t.lines.some((l) => /"C:\/gone\/dev".*gone/.test(l)), t.lines.join('\n'));
  assert.deepStrictEqual(await t.op.openProject({ cwd: 7 }), { ok: false, error: 'the folder is gone' });
});

test('a root owned by another process is left to that process (the claim sent it the focus)', async () => {
  const t = rig({ start: async () => ({ pw: null, existing: false, first: null, elsewhere: true }) });
  const r = await t.op.openProject({ cwd: 'C:/o/dev' });
  assert.deepStrictEqual(r, { ok: true, elsewhere: true });
  assert.ok(t.lines.some((l) => /another process/.test(l)));
});

test('a start that failed is reported, not thrown', async () => {
  const t = rig({ start: async () => ({ pw: null, existing: false, first: null, error: 'boom' }) });
  assert.deepStrictEqual(await t.op.openProject({ cwd: 'C:/x/dev' }), { ok: false, error: 'boom' });
});

test('a single-mode handed-off window that cannot start closes only itself', async () => {
  const t = rig({ start: async (cwd, opts, win) => ({ pw: Object.assign(win('C:/flat', 'single'), { mode: 'single' }), existing: false, first: { started: false, error: 'no port' } }) });
  const r = await t.op.openProject({ cwd: 'C:/flat' });
  assert.deepStrictEqual(r, { ok: false, error: 'no port' });
  assert.deepStrictEqual(t.closed, ['C:/flat']);
});

test('a handed-off launch whose CLAUDE_CUSTOM_BIN / CONPTY / SHELL differ logs the NAMES, never the values', async () => {
  const t = rig({ ownEnv: { CLAUDE_CUSTOM_BIN: 'C:\\own\\claude.exe', CLAUDE_CUSTOM_SHELL: 'pwsh' } });
  await t.op.openProject({ cwd: 'C:/q/dev', env: { CLAUDE_CUSTOM_BIN: 'C:\\secret-path\\claude.exe', CLAUDE_CUSTOM_CONPTY: 'builtin', CLAUDE_CUSTOM_SHELL: 'pwsh' } });
  const line = t.lines.find((l) => /differ/.test(l));
  assert.ok(line, t.lines.join('\n'));
  assert.match(line, /CLAUDE_CUSTOM_BIN, CLAUDE_CUSTOM_CONPTY/);
  assert.doesNotMatch(line, /CLAUDE_CUSTOM_SHELL/);
  assert.doesNotMatch(line, /secret-path|own|builtin/);
  t.lines.length = 0;
  await t.op.openProject({ cwd: 'C:/r/dev' });            // no env (the tray, the menu): nothing compared
  assert.ok(!t.lines.some((l) => /differ/.test(l)));
});
