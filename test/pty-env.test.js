'use strict';
// host/pty-env.js: what a tab's pty must not inherit. Pure, and it reads host/tab-env.js's key list, so it is in Stryker's command.
const test = require('node:test');
const assert = require('node:assert/strict');

test('withoutNodeMode drops ELECTRON_RUN_AS_NODE in any spelling and touches nothing else, and leaves its input alone', () => {
  const { withoutNodeMode } = require('../host/pty-env');
  const env = { ELECTRON_RUN_AS_NODE: '1', PATH: 'p', CLAUDE_CODE_X: 'y' };
  assert.deepEqual(withoutNodeMode(env), { PATH: 'p', CLAUDE_CODE_X: 'y' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(withoutNodeMode({}), {});
  assert.deepEqual(withoutNodeMode({ electron_run_as_node: '1', A: 'b' }), { A: 'b' });
});

test('forPty: the COMPOSED env of a tab host has neither node mode nor the tab\'s identity, and keeps everything else', () => {
  const { forPty } = require('../host/pty-env');
  const { hostEnv, PER_TAB_KEYS } = require('../host/tab-env');
  const h = hostEnv({ PATH: 'p', CLAUDE_CODE_USER_SETTING: 'keep', CLAUDE_CUSTOM_BIN: 'b' },
    { cwd: 'C:/p', port: 7001, token: 't', project: { kind: 'none', root: 'C:/p', dev: 'C:/p' }, side: true });
  assert.equal(h.ELECTRON_RUN_AS_NODE, '1');
  for (const k of ['CLAUDE_CUSTOM_PORT', 'CLAUDE_CUSTOM_TOKEN', 'CLAUDE_CUSTOM_CWD']) assert.ok(k in h, `the host has ${k}`);
  const pty = forPty(h);
  assert.ok(!('ELECTRON_RUN_AS_NODE' in pty));
  for (const k of PER_TAB_KEYS) assert.ok(!(k in pty), `${k} must not reach the pty`);
  assert.equal(pty.PATH, 'p');
  assert.equal(pty.CLAUDE_CODE_USER_SETTING, 'keep', 'the user\'s own CLAUDE_CODE_* settings still travel');
  assert.equal(pty.CLAUDE_CUSTOM_BIN, 'b', 'only the per-tab identity goes, not the rest of the namespace');
  assert.deepEqual(forPty({ claude_custom_port: '1', A: 'b' }), { A: 'b' }, 'case-insensitive');
});

