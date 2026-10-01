'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { planGoTo } = require('../app/go-to-session');

const HOLDER = { pid: 4242, port: 5150, install: 'C:\\inst-a', startedAt: 1, claudePid: 9 };
const NOT_FOUND = "That session's window can't be found.";
const NO_WINDOW = 'That session is in another claude-custom (pid 4242, port 5150) with no window open. Open its project to see it.';

function deps(over = {}) {
  const calls = { tabs: [], identity: [], token: [] };
  return {
    calls,
    tabsByPort: new Map(),
    readIdentity: (a) => { calls.identity.push(a); return { port: a.port, cwd: 'x', pid: 4242, startedAt: 1 }; },
    readToken: (i, p) => { calls.token.push([i, p]); return 'tok'; },
    ...over,
  };
}

test('a tab in this window serves the port (Map)', () => {
  const d = deps({ tabsByPort: new Map([[5150, 'k1']]) });
  assert.deepStrictEqual(planGoTo(HOLDER, d), { kind: 'select-tab', key: 'k1' });
  assert.strictEqual(d.calls.identity.length, 0);
  assert.strictEqual(d.calls.token.length, 0);
});

test('a tab in this window serves the port (function)', () => {
  const d = deps({ tabsByPort: (p) => (p === 5150 ? 'k2' : undefined) });
  assert.deepStrictEqual(planGoTo(HOLDER, d), { kind: 'select-tab', key: 'k2' });
});

test('this window wins even when the identity would also match', () => {
  const d = deps({ tabsByPort: new Map([[5150, 'k1']]) });
  assert.strictEqual(planGoTo(HOLDER, d).kind, 'select-tab');
  assert.strictEqual(d.calls.token.length, 0);
});

test('raise: identity pid equals the holder pid and a token exists', () => {
  const d = deps();
  assert.deepStrictEqual(planGoTo(HOLDER, d), { kind: 'raise', port: 5150, token: 'tok' });
  assert.deepStrictEqual(d.calls.identity, [{ install: 'C:\\inst-a', port: 5150 }]);
  assert.deepStrictEqual(d.calls.token, [['C:\\inst-a', 5150]]);
});

test('identity pid mismatch: explain, never raise, and the token is never read', () => {
  const d = deps({ readIdentity: () => ({ port: 5150, cwd: 'x', pid: 9999, startedAt: 1 }) });
  const plan = planGoTo(HOLDER, d);
  assert.deepStrictEqual(plan, { kind: 'explain', text: NOT_FOUND });
  assert.strictEqual(d.calls.token.length, 0, 'readToken must not run on a mismatch');
});

test('no live identity: explain, token never read', () => {
  const d = deps({ readIdentity: () => null });
  assert.deepStrictEqual(planGoTo(HOLDER, d), { kind: 'explain', text: NOT_FOUND });
  assert.strictEqual(d.calls.token.length, 0);
  const t = deps({ readIdentity: () => { throw new Error('boom'); } });
  assert.deepStrictEqual(planGoTo(HOLDER, t), { kind: 'explain', text: NOT_FOUND });
  assert.strictEqual(t.calls.token.length, 0);
});

test('a holder without a usable pid never matches an identity without one', () => {
  for (const pid of [undefined, null, 0, '4242', 1.5]) {
    const d = deps({ readIdentity: () => ({ port: 5150, pid }) });
    assert.deepStrictEqual(planGoTo({ ...HOLDER, pid }, d), { kind: 'explain', text: NOT_FOUND });
    assert.strictEqual(d.calls.token.length, 0);
  }
});

test('identity matches but no token: the "no window open" text', () => {
  for (const tok of [null, undefined, '', 5]) {
    const d = deps({ readToken: () => tok });
    assert.deepStrictEqual(planGoTo(HOLDER, d), { kind: 'explain', text: NO_WINDOW });
  }
  const t = deps({ readToken: () => { throw new Error('EACCES'); } });
  assert.deepStrictEqual(planGoTo(HOLDER, t), { kind: 'explain', text: NO_WINDOW });
});

test('missing install or port: explain', () => {
  for (const h of [{ ...HOLDER, install: undefined }, { ...HOLDER, install: null }, { ...HOLDER, install: '' },
                   { ...HOLDER, port: undefined }, { ...HOLDER, port: null }, null, undefined]) {
    const d = deps();
    assert.deepStrictEqual(planGoTo(h, d), { kind: 'explain', text: NOT_FOUND });
    assert.strictEqual(d.calls.identity.length, 0);
    assert.strictEqual(d.calls.token.length, 0);
  }
});

test('a port that is not a positive integer is never looked up (null is not port 0)', () => {
  for (const port of [null, undefined, 0, -1, 1.5, NaN, '5150', Infinity]) {
    const looked = [];
    const d = deps({ tabsByPort: (p) => { looked.push(p); return 'k0'; } });
    d.readIdentity = (a) => { looked.push(a.port); return { pid: 4242 }; };
    assert.deepStrictEqual(planGoTo({ ...HOLDER, port }, d), { kind: 'explain', text: NOT_FOUND });
    assert.deepStrictEqual(looked, [], `port ${String(port)} must not be consulted`);
    const withMap = new Map([[0, 'zero']]);
    assert.strictEqual(planGoTo({ ...HOLDER, port: null }, deps({ tabsByPort: withMap })).kind, 'explain');
  }
});

test('an install that is not a string is not usable', () => {
  const d = deps();
  assert.deepStrictEqual(planGoTo({ ...HOLDER, install: 7 }, d), { kind: 'explain', text: NOT_FOUND });
});

test('PROPERTY: a token is returned only when the identity pid equals the holder pid', () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 99999 }), fc.option(fc.integer({ min: 0, max: 99999 }), { nil: undefined }),
    (holderPid, idPid) => {
      let tokenReads = 0;
      const plan = planGoTo({ pid: holderPid, port: 5150, install: 'C:\\i' }, {
        tabsByPort: new Map(),
        readIdentity: () => ({ pid: idPid }),
        readToken: () => { tokenReads++; return 'secret'; },
      });
      if (idPid === holderPid) {
        assert.strictEqual(plan.kind, 'raise');
      } else {
        assert.strictEqual(plan.kind, 'explain');
        assert.strictEqual(tokenReads, 0);
        assert.ok(!JSON.stringify(plan).includes('secret'));
      }
    }));
});
