'use strict';
/**
 * The launcher's --help (PR 2, worktree tabs): launching from dev\ or a sibling
 * worktree opens the project window with THAT tab selected. The launcher itself
 * still just passes the folder; main folds it with projectOf.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'claude-custom.js');

test('--help says a container project opens one window with the launched folder\'s tab selected', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /ONE window with a tab per worktree/);
  assert.match(r.stdout, /THAT worktree's tab selected/);
  assert.match(r.stdout, /single-tab window/);
  assert.match(r.stdout, /CLAUDE_CUSTOM_PORT/);
});
