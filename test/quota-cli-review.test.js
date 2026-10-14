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

// --- kill tests for the release-176 survivors (BACKLOG #94) ----------------------

const { main, parse } = require('../host/quota-cli');

test('parse: every flag lands in its own field, with the defaults when absent', () => {
  assert.deepStrictEqual(parse([]), { opts: { json: false, dir: undefined, configDir: undefined } });
  assert.deepStrictEqual(parse(['--json']), { opts: { json: true, dir: undefined, configDir: undefined } });
  assert.deepStrictEqual(parse(['--dir', 'x']), { opts: { json: false, dir: 'x', configDir: undefined } });
  assert.deepStrictEqual(parse(['--config-dir', 'cfg', '--json']), { opts: { json: true, dir: undefined, configDir: path.resolve('cfg') } });
});

test('parse: an empty value is a usage error, like a missing one', () => {
  assert.deepStrictEqual(parse(['--dir', '']), { error: '--dir needs a value' });
  assert.deepStrictEqual(parse(['--config-dir', '']), { error: '--config-dir needs a value' });
  assert.deepStrictEqual(parse(['--dir']), { error: '--dir needs a value' });
  assert.deepStrictEqual(parse(['--dir', '--json']), { error: '--dir needs a value' });
  assert.deepStrictEqual(parse(['--nope']), { error: 'unknown argument --nope' });
});

test('main: a usage error prints the reason and the usage to the error stream and returns 2, printing nothing else', () => {
  const out = []; const err = [];
  assert.strictEqual(main(['--bogus'], { out: (s) => out.push(s), err: (s) => err.push(s) }), 2);
  assert.deepStrictEqual(out, []);
  assert.strictEqual(err.length, 1);
  assert.match(err[0], /^unknown argument --bogus\nusage: node host\/quota-cli\.js \[--json\]/);
});

test('main: reads the folder it is given and returns 0 with the one-line text, or the JSON with --json', () => {
  const d = tmpDir('quota-cli-main-');
  const cfg = path.join(d, 'cfg');
  recordPoll({ dir: d, configDir: cfg, now: () => Date.now(), result: { ok: true, windows: [{ key: 's', label: '5h', percent: 31 }] } });
  const out = [];
  assert.strictEqual(main(['--dir', d, '--config-dir', cfg], { out: (s) => out.push(s) }), 0);
  assert.match(out[0], /^5h 31% · read \d+ s ago$/);
  const json = [];
  assert.strictEqual(main(['--dir', d, '--config-dir', cfg, '--json'], { out: (s) => json.push(s) }), 0);
  const shared = JSON.parse(json[0]);
  assert.deepStrictEqual([shared.ok, shared.state, shared.windows.map(w => w.percent)], [true, 'fresh', [31]]);
  const none = [];
  assert.strictEqual(main(['--dir', d, '--config-dir', path.join(d, 'other')], { out: (s) => none.push(s) }), 0, 'unknown is still exit 0');
  assert.match(none[0], /^unknown \(/);
});

test('requiring the module runs nothing: no output and process.exitCode untouched', () => {
  const r = spawnSync(process.execPath, ['-e', "require(process.argv[1]); process.stdout.write('exitCode=' + String(process.exitCode))", CLI], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'exitCode=undefined');
});
