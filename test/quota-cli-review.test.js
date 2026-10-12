'use strict';
/** PR #165 review fixes for host/quota-cli.js: Dexter 1 and 7, Miguel 6. */
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { recordPoll } = require('../host/quota-share');

const CLI = path.join(__dirname, '..', 'host', 'quota-cli.js');
const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env || process.env });

test('--dir / --config-dir with no value, or followed by another flag, is a usage error (exit 2), never the default dir', () => {
  for (const args of [['--dir'], ['--dir', '--json'], ['--config-dir'], ['--config-dir', '--json']]) {
    const r = run(args);
    assert.strictEqual(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: node host\/quota-cli\.js/);
    assert.strictEqual(r.stdout, '', 'nothing printed as if it were the answer');
  }
});

test('an unknown argument is a usage error too', () => {
  const r = run(['--nope']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /unknown argument --nope/);
});

test('the file is per account: --config-dir picks that account\'s figure, never a neighbour\'s', () => {
  const d = tmpDir('quota-cli-');
  const cfgA = path.join(d, 'cfg-a');
  const cfgB = path.join(d, 'cfg-b');
  recordPoll({ dir: d, configDir: cfgA, now: () => Date.now(), result: { ok: true, windows: [{ key: 's', label: '5h', percent: 11 }] } });
  assert.match(run(['--dir', d, '--config-dir', cfgA]).stdout, /^5h 11%/);
  assert.match(run(['--dir', d, '--config-dir', cfgB]).stdout, /^unknown \(no quota file/);
});

test('by default the CLI reads the file for its own environment\'s CLAUDE_CONFIG_DIR', () => {
  const d = tmpDir('quota-cli-');
  const cfgA = path.join(d, 'cfg-a');
  recordPoll({ dir: d, configDir: cfgA, now: () => Date.now(), result: { ok: true, windows: [{ key: 's', label: '5h', percent: 23 }] } });
  const env = (cfg) => ({ ...process.env, CLAUDE_CONFIG_DIR: cfg });
  assert.match(run(['--dir', d], env(cfgA)).stdout, /^5h 23%/);
  assert.match(run(['--dir', d], env(path.join(d, 'cfg-b'))).stdout, /^unknown/);
});
