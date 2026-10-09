'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { hostEnv, PER_TAB_KEYS } = require('../host/tab-env');

const FLAT = { kind: 'flat', root: 'C:\\repo', dev: 'C:\\repo' };
const BOX = { kind: 'container', root: 'C:\\box', dev: 'C:\\box\\dev' };
const args = (over = {}) => ({ cwd: 'C:\\repo', port: 4100, token: 'tok', project: FLAT, ...over });

const SET_KEYS = [
  'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_TOKEN',
  'CLAUDE_CUSTOM_PROJECT_ROOT', 'CLAUDE_CUSTOM_PROJECT_STATE',
];

test('an inherited token, port and side-tab flag never reach the child', () => {
  const env = hostEnv({
    CLAUDE_CUSTOM_TOKEN: 'old', CLAUDE_CUSTOM_PORT: '1', CLAUDE_CUSTOM_SIDE_TAB: '1',
    CLAUDE_CUSTOM_SESSION_ID: 'abc',
  }, args());
  assert.strictEqual(env.CLAUDE_CUSTOM_TOKEN, 'tok');
  assert.strictEqual(env.CLAUDE_CUSTOM_PORT, '4100');
  assert.ok(!('CLAUDE_CUSTOM_SIDE_TAB' in env));
  assert.ok(!('CLAUDE_CUSTOM_SESSION_ID' in env));
});

test('install-level knobs pass through: probes set CLAUDE_CUSTOM_BIN to a stub so nothing bills', () => {
  const env = hostEnv({ CLAUDE_CUSTOM_BIN: 'stub.js', CLAUDE_CUSTOM_HELPER: 'h.js' }, args());
  assert.strictEqual(env.CLAUDE_CUSTOM_BIN, 'stub.js');
  assert.strictEqual(env.CLAUDE_CUSTOM_HELPER, 'h.js');
});

test('a port that is not an integer in 1-65535 throws, never "null" or "NaN"', () => {
  for (const port of [null, undefined, NaN, 1.5, '4100', 0, -1, 65536, Infinity]) {
    assert.throws(() => hostEnv({}, args({ port })), /port/, String(port));
  }
  assert.strictEqual(hostEnv({}, args({ port: 1 })).CLAUDE_CUSTOM_PORT, '1');
  assert.strictEqual(hostEnv({}, args({ port: 65535 })).CLAUDE_CUSTOM_PORT, '65535');
});

test('a missing or empty cwd or token throws', () => {
  for (const cwd of [undefined, null, '', 5]) assert.throws(() => hostEnv({}, args({ cwd })), /cwd/);
  for (const token of [undefined, null, '', 5]) assert.throws(() => hostEnv({}, args({ token })), /token/);
});

test('a flat project has root = state = the folder', () => {
  const env = hostEnv({}, args());
  assert.strictEqual(env.CLAUDE_CUSTOM_PROJECT_ROOT, 'C:\\repo');
  assert.strictEqual(env.CLAUDE_CUSTOM_PROJECT_STATE, 'C:\\repo');
});

test('a container has root = the container, state = its dev folder', () => {
  const env = hostEnv({}, args({ project: BOX, cwd: 'C:\\box\\feat' }));
  assert.strictEqual(env.CLAUDE_CUSTOM_PROJECT_ROOT, 'C:\\box');
  assert.strictEqual(env.CLAUDE_CUSTOM_PROJECT_STATE, 'C:\\box\\dev');
  assert.strictEqual(env.CLAUDE_CUSTOM_CWD, 'C:\\box\\feat');
});

test('a missing project throws rather than writing "undefined"', () => {
  assert.throws(() => hostEnv({}, args({ project: null })), /project/);
});

test('ELECTRON_RUN_AS_NODE is 1 whatever the base says', () => {
  assert.strictEqual(hostEnv({}, args()).ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(hostEnv({ ELECTRON_RUN_AS_NODE: '0' }, args()).ELECTRON_RUN_AS_NODE, '1');
});

test('the base env is not mutated', () => {
  const base = { CLAUDE_CUSTOM_TOKEN: 'old', PATH: 'p' };
  hostEnv(base, args());
  assert.deepStrictEqual(base, { CLAUDE_CUSTOM_TOKEN: 'old', PATH: 'p' });
});

test('PER_TAB_KEYS is the documented list', () => {
  assert.deepStrictEqual([...PER_TAB_KEYS].sort(), [
    'CLAUDE_CUSTOM_CWD', 'CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_PROJECT_ROOT',
    'CLAUDE_CUSTOM_PROJECT_STATE', 'CLAUDE_CUSTOM_SESSION_ID', 'CLAUDE_CUSTOM_SIDE', 'CLAUDE_CUSTOM_SIDE_TAB',
    'CLAUDE_CUSTOM_TOKEN',
  ]);
});

const keyArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 8 }).map(s => `CLAUDE_CUSTOM_${s}`),
  fc.constantFrom(...PER_TAB_KEYS, 'CLAUDE_CUSTOM_BIN', 'ELECTRON_RUN_AS_NODE', 'PATH'),
  fc.string({ minLength: 1, maxLength: 8 }),
).filter(k => !k.includes('=') && !k.includes('\0') && k !== '__proto__');

test('PROPERTY: CLAUDE_CUSTOM_* keys are base minus per-tab plus the five set keys; passthrough is byte-identical', () => {
  fc.assert(fc.property(
    fc.dictionary(keyArb, fc.string({ maxLength: 12 })),
    fc.integer({ min: 1, max: 65535 }),
    (base, port) => {
      const before = JSON.stringify(base);
      const out = hostEnv(base, args({ port }));
      const ours = o => Object.keys(o).filter(k => k.startsWith('CLAUDE_CUSTOM_'));
      const expected = new Set([
        ...ours(base).filter(k => !PER_TAB_KEYS.includes(k)),
        ...SET_KEYS,
      ]);
      assert.deepStrictEqual(new Set(ours(out)), expected);
      for (const k of ours(base)) {
        if (!PER_TAB_KEYS.includes(k)) assert.strictEqual(out[k], base[k]);
      }
      for (const k of Object.keys(base)) {
        if (!k.startsWith('CLAUDE_CUSTOM_') && k !== 'ELECTRON_RUN_AS_NODE') assert.strictEqual(out[k], base[k]);
      }
      assert.strictEqual(out.CLAUDE_CUSTOM_PORT, String(port));
      assert.strictEqual(out.CLAUDE_CUSTOM_TOKEN, 'tok');
      assert.strictEqual(out.ELECTRON_RUN_AS_NODE, '1');
      assert.strictEqual(JSON.stringify(base), before);
    },
  ));
});
