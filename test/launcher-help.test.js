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

// Windowless sessions PR 3: `claude-custom <folder> --stop`.
test('--help documents --stop and its exit codes', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(r.stdout, /--stop/);
  assert.match(r.stdout, /exit 0/i);
  assert.match(r.stdout, /exit 3/i);
});

test('an unknown option exits 1 with one line, and opens nothing', () => {
  const r = spawnSync(process.execPath, [BIN, '--stpo'], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown option: --stpo/);
});

test('--stop on a folder nothing serves says so, without a window, and exits 0 (3 only if the list was incomplete)', () => {
  const folder = path.join(require('os').tmpdir(), `cc-stop-none-${process.pid}-${Date.now()}`);
  const r = spawnSync(process.execPath, [BIN, folder, '--stop'], { encoding: 'utf8', timeout: 60000 });
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.strictEqual(lines[0], `no claude-custom session is serving ${folder}`);
  if (r.status === 3) assert.match(lines[1], /couldn't check every session/i);
  else assert.strictEqual(r.status, 0);
});
