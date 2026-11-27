'use strict';
/**
 * The routing pipe (single-instance PR 3 step 2, host/window-router.js): ONE listener per process on `claude-custom-window-<pid>`, with one
 * entry per window. A window's claim registers its entry instead of listening, so stop() / resume() of one window never touch another's.
 * Routing: root -> else cwd (its project root, else the registered root that contains it) -> else port -> else the only window -> nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fc = require('fast-check');

const load = () => require('../host/window-router');
const focus = require('../host/window-focus');
const { samePath, isInside } = require('../host/project-layout');
const uniquePid = () => 900_000_000 + Math.floor(Math.random() * 90_000_000);
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); }
};

const A = path.resolve('/projects/alpha');
const B = path.resolve('/projects/beta');
// A fake projectOf: a folder under /projects/<name> belongs to /projects/<name>.
const projectOf = (cwd) => {
  const m = /^(.*[\\/]projects[\\/][^\\/]+)/i.exec(path.resolve(cwd));
  return m ? { root: m[1] } : null;
};
// A router over a fake listen: records the gates so resolve() and the gates can be driven without a pipe.
function fakeRouter() {
  const calls = { listen: 0, closed: 0 };
  let gates = null;
  const listen = async (opts) => { calls.listen++; gates = opts; return { close: async () => { calls.closed++; } } };
  const router = load().createWindowRouter({ listen, pid: 1, projectOf, samePath, isInside });
  return { router, calls, gates: () => gates };
}
const entry = (root, extra = {}) => ({ root, hasPort: () => false, accepting: () => true, whenReady: () => true, onFocus: async () => {}, ...extra });

test('routing: root wins; an unknown root resolves to nothing, never another window', async () => {
  const { router } = fakeRouter();
  const a = entry(A); const b = entry(B);
  await router.register(a); await router.register(b);
  assert.strictEqual(router.resolve({ root: B }), b);
  assert.strictEqual(router.resolve({ root: A, cwd: path.join(B, 'dev') }), a, 'root is read before cwd');
  assert.strictEqual(router.resolve({ root: path.resolve('/projects/gamma') }), null);
});

test('routing: cwd -> its project root, else the registered root that contains it', async () => {
  const { router } = fakeRouter();
  const a = entry(A); const b = entry(B);
  await router.register(a); await router.register(b);
  assert.strictEqual(router.resolve({ cwd: path.join(B, 'feat-x') }), b);
  const lone = path.resolve('/elsewhere/repo');
  const c = entry(lone);
  await router.register(c);
  assert.strictEqual(router.resolve({ cwd: path.join(lone, 'src', 'deep') }), c, 'no project: the containing registered root');
});

test('routing: port -> the window with a tab on it; else the only window; else nothing', async () => {
  const { router } = fakeRouter();
  const a = entry(A, { hasPort: (p) => p === 7001 });
  await router.register(a);
  assert.strictEqual(router.resolve({}), a, 'one window: a legacy {} is that window');
  const b = entry(B, { hasPort: (p) => p === 7002 });
  await router.register(b);
  assert.strictEqual(router.resolve({ port: 7002 }), b);
  assert.strictEqual(router.resolve({}), null, 'a legacy {} with two windows cannot be routed');
  assert.strictEqual(router.resolve({ port: 9999 }), null);
});

test('register / close / register again (resume): close removes only that entry', async () => {
  const { router, calls } = fakeRouter();
  const a1 = entry(A); const b = entry(B);
  const ha = await router.register(a1); await router.register(b);
  assert.strictEqual(calls.listen, 1, 'one listener for the process');
  await ha.close();
  assert.strictEqual(router.resolve({ root: A }), null);
  assert.strictEqual(router.resolve({ root: B }), b);
  const a2 = entry(A);
  const ha2 = await router.register(a2);
  assert.strictEqual(router.resolve({ root: A }), a2);
  await ha.close();                                  // a stale handle closes nothing of the new entry
  assert.strictEqual(router.resolve({ root: A }), a2);
  await ha2.close();
  assert.strictEqual(calls.listen, 1);
});

test('the gates go to the resolved entry; an unknown root is not accepting and says why', async () => {
  const { router, gates } = fakeRouter();
  const heard = [];
  await router.register(entry(A, { accepting: () => false }));
  await router.register(entry(B, { onFocus: async (m) => { heard.push(m); } }));
  const g = gates();
  assert.strictEqual(g.accepting({ root: A }), false);
  assert.strictEqual(g.accepting({ root: B }), true);
  assert.strictEqual(g.accepting({ root: path.resolve('/projects/none') }), 'no such window');
  assert.strictEqual(await g.whenReady({ root: path.resolve('/projects/none') }), false);
  await g.onFocus({ root: B, cwd: 'x' });
  assert.deepStrictEqual(heard, [{ root: B, cwd: 'x' }]);
});

test('a listen failure rejects register (the claim\'s "no launch pipe" path), and the next register tries again', async () => {
  let n = 0;
  const listen = async () => { n++; if (n === 1) throw new Error('taken'); return { close: async () => {} }; };
  const router = load().createWindowRouter({ listen, pid: 1, projectOf, samePath, isInside });
  await assert.rejects(router.register(entry(A)), /taken/);
  assert.strictEqual(router.resolve({ root: A }), null);
  await router.register(entry(A));
  assert.strictEqual(n, 2);
});

test('over a real pipe: a focus with root B reaches only B; a legacy {} with two windows is refused, with one accepted', async () => {
  const pid = uniquePid();
  const router = load().createWindowRouter({ listen: focus.listen, pid, projectOf, samePath, isInside });
  const heard = { a: [], b: [] };
  const ha = await router.register(entry(A, { onFocus: async (m) => { heard.a.push(m); } }));
  try {
    assert.deepStrictEqual(await focus.send({ pid, msg: {} }), { ok: true }, 'one window: the legacy {} is accepted');
    await until(() => heard.a.length === 1);
    await router.register(entry(B, { onFocus: async (m) => { heard.b.push(m); } }));
    assert.deepStrictEqual(await focus.send({ pid, msg: { root: B } }), { ok: true });
    await until(() => heard.b.length === 1);
    assert.strictEqual(heard.a.length, 1, 'A heard nothing of B\'s launch');
    assert.deepStrictEqual(await focus.send({ pid, msg: {} }), { ok: false, error: 'no such window' });
    await ha.close();
    assert.deepStrictEqual(await focus.send({ pid, msg: { root: A } }), { ok: false, error: 'no such window' });
  } finally { await router.stop(); }
});

test('P-R1: a message with root R resolves to the entry registered for R or to nothing; any register/close order leaves the open entries', async () => {
  const roots = ['alpha', 'beta', 'gamma'].map((n) => path.resolve('/projects', n));
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ op: fc.constantFrom('register', 'close'), r: fc.integer({ min: 0, max: 2 }) }), { maxLength: 30 }),
    async (ops) => {
      const { router } = fakeRouter();
      const open = new Map();          // root index -> { entry, handle }
      for (const { op, r } of ops) {
        if (op === 'register') {
          if (open.has(r)) continue;
          const e = entry(roots[r]);
          open.set(r, { e, h: await router.register(e) });
        } else if (open.has(r)) { await open.get(r).h.close(); open.delete(r); }
      }
      for (let r = 0; r < roots.length; r++) {
        const got = router.resolve({ root: roots[r] });
        if (open.has(r)) assert.strictEqual(got, open.get(r).e);
        else assert.strictEqual(got, null);
      }
      assert.strictEqual(router.size(), open.size);
    }), { numRuns: 100 });
});
