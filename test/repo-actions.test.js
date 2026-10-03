'use strict';
/**
 * Show in Explorer and drag-out (#45), the two things only the main process can do. Both re-run the path
 * guard against THAT tab's worktree. Nothing is ever executed: no openPath, no openExternal, ever.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createRepoActions } = require('../app/repo-actions');

// A shell that fails the test if anything but showItemInFolder is touched.
function strictShell() {
  const shown = [];
  const shell = new Proxy({ showItemInFolder: (p) => { shown.push(p); } }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`shell.${String(prop)} must never be called by the repo browser`); };
    },
  });
  return { shell, shown };
}

function fixture() {
  const base = tmpDir('cc-actions-');
  const root = path.join(base, 'wt');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  fs.symlinkSync(outside, path.join(root, 'jn'), 'junction');
  return { root, outside };
}

test('reveal shows the file in Explorer, by the path the guard resolved', async () => {
  const { root } = fixture();
  const { shell, shown } = strictShell();
  const a = createRepoActions({ shell, startDrag: () => {}, icon: () => 'icon' });
  const r = await a.reveal(root, 'src/a.js');
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].toLowerCase(), path.join(root, 'src', 'a.js').toLowerCase());
});

test('reveal of a folder works too', async () => {
  const { root } = fixture();
  const { shell, shown } = strictShell();
  const r = await createRepoActions({ shell, startDrag: () => {}, icon: () => 'i' }).reveal(root, 'src');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(shown.length, 1);
});

test('reveal and drag refuse anything outside the worktree, however spelled, and touch nothing', async () => {
  const { root, outside } = fixture();
  const { shell, shown } = strictShell();
  const dragged = [];
  const a = createRepoActions({ shell, startDrag: (o) => dragged.push(o), icon: () => 'i' });
  for (const p of ['../outside/secret.txt', '..\\outside\\secret.txt', path.join(outside, 'secret.txt'), 'C:\\Windows\\win.ini',
    '\\\\srv\\share\\x', 'jn/secret.txt', 'src/../../outside/secret.txt', '', 'a\u0000b']) {
    const r1 = await a.reveal(root, p);
    const r2 = await a.drag(root, p);
    assert.strictEqual(r1.ok, false, `reveal ${JSON.stringify(p)}`);
    assert.strictEqual(r2.ok, false, `drag ${JSON.stringify(p)}`);
    assert.ok(r1.why && r2.why);
  }
  assert.deepStrictEqual(shown, []);
  assert.deepStrictEqual(dragged, []);
});

test('non-string input is refused, never thrown', async () => {
  const { root } = fixture();
  const a = createRepoActions({ shell: strictShell().shell, startDrag: () => {}, icon: () => 'i' });
  for (const p of [null, undefined, 5, {}, ['a']]) {
    assert.strictEqual((await a.reveal(root, p)).ok, false);
    assert.strictEqual((await a.drag(root, p)).ok, false);
  }
  assert.strictEqual((await a.reveal(undefined, 'src/a.js')).ok, false);
});

test('drag hands the OS the real file and an icon, and nothing else', async () => {
  const { root } = fixture();
  const dragged = [];
  const a = createRepoActions({ shell: strictShell().shell, startDrag: (o) => dragged.push(o), icon: () => 'THE-ICON' });
  const r = await a.drag(root, 'src/a.js');
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(dragged.length, 1);
  assert.deepStrictEqual(Object.keys(dragged[0]).sort(), ['file', 'icon']);
  assert.strictEqual(dragged[0].icon, 'THE-ICON');
  assert.strictEqual(dragged[0].file.toLowerCase(), path.join(root, 'src', 'a.js').toLowerCase());
});

test('drag starts on the window that asked: the per-call start wins over the default', async () => {
  const { root } = fixture();
  const viaDefault = [];
  const viaCall = [];
  const a = createRepoActions({ shell: strictShell().shell, startDrag: (o) => viaDefault.push(o), icon: () => 'i' });
  await a.drag(root, 'src/a.js', (o) => viaCall.push(o));
  assert.deepStrictEqual([viaDefault.length, viaCall.length], [0, 1]);
});

test('a folder is not dragged out (the OS drag takes files)', async () => {
  const { root } = fixture();
  const dragged = [];
  const r = await createRepoActions({ shell: strictShell().shell, startDrag: (o) => dragged.push(o), icon: () => 'i' }).drag(root, 'src');
  assert.deepStrictEqual({ ok: r.ok, why: r.why }, { ok: false, why: 'not-a-file' });
  assert.deepStrictEqual(dragged, []);
});

test('a file that is gone says so', async () => {
  const { root } = fixture();
  const a = createRepoActions({ shell: strictShell().shell, startDrag: () => {}, icon: () => 'i' });
  assert.strictEqual((await a.reveal(root, 'src/gone.js')).why, 'gone');
  assert.strictEqual((await a.drag(root, 'src/gone.js')).why, 'gone');
});

test('a shell or startDrag that throws is a failure reply, not a crash in main', async () => {
  const { root } = fixture();
  const boom = createRepoActions({
    shell: { showItemInFolder: () => { throw new Error('explorer is not available'); } },
    startDrag: () => { throw new Error('drag failed'); }, icon: () => 'i',
  });
  const r1 = await boom.reveal(root, 'src/a.js');
  const r2 = await boom.drag(root, 'src/a.js');
  assert.deepStrictEqual([r1.ok, r2.ok], [false, false]);
  assert.match(r1.why, /explorer is not available/);
  assert.match(r2.why, /drag failed/);
});
