'use strict';
/**
 * host/cc-mod-settings.js: whether the claude-custom mod is loaded into `claude` (BACKLOG #119 A2). Three gates, all read once when
 * the host builds `claude`'s arguments, so a change takes effect on the next session:
 *   - the Style tab's switch (default ON), the same file pattern as host/canvas-settings.js;
 *   - the installed CLI must be new enough for the hooks the mod uses (2.1.290), an older one gets no flag;
 *   - the mod's directory must exist.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const {
  modEnabled, readModSetting, writeModSetting, parseCliVersion, versionAtLeast, modPluginDirFor, readCliVersion, MIN_CLI_VERSION,
} = require('../host/cc-mod-settings');

const state = () => tmpDir('cc-mod-settings-');

test('the first CLI that has every hook the mod uses is 2.1.290', () => {
  assert.deepStrictEqual(MIN_CLI_VERSION, [2, 1, 290]);
});

test('on by default: no env, no file, no state dir', () => {
  assert.strictEqual(modEnabled({ env: {}, stateDir: state() }), true);
  assert.strictEqual(modEnabled({ env: {}, stateDir: path.join(state(), 'nope') }), true);
  assert.strictEqual(modEnabled({}), true);
});

test('the environment turns it off in the usual spellings; anything else leaves it on', () => {
  for (const v of ['0', 'off', 'OFF', 'false', 'No', ' no ']) assert.strictEqual(modEnabled({ env: { CLAUDE_CUSTOM_MOD: v }, stateDir: state() }), false, v);
  for (const v of ['1', 'on', 'true', '', 'maybe', undefined]) assert.strictEqual(modEnabled({ env: { CLAUDE_CUSTOM_MOD: v }, stateDir: state() }), true, String(v));
});

test('the file turns it off with { "mod": false } and only that', () => {
  const dir = state();
  const put = (v) => fs.writeFileSync(path.join(dir, 'cc-mod-settings.json'), typeof v === 'string' ? v : JSON.stringify(v));
  put({ mod: false });
  assert.strictEqual(modEnabled({ env: {}, stateDir: dir }), false);
  for (const v of [{ mod: true }, {}, { mod: 0 }, { mod: 'false' }, [], 'null', '{nope', 'x']) { put(v); assert.strictEqual(modEnabled({ env: {}, stateDir: dir }), true, JSON.stringify(v)); }
});

test('either the environment or the file is enough to turn it off; the environment cannot turn it on over the file', () => {
  const dir = state();
  fs.writeFileSync(path.join(dir, 'cc-mod-settings.json'), JSON.stringify({ mod: true }));
  assert.strictEqual(modEnabled({ env: { CLAUDE_CUSTOM_MOD: '0' }, stateDir: dir }), false);
  fs.writeFileSync(path.join(dir, 'cc-mod-settings.json'), JSON.stringify({ mod: false }));
  assert.strictEqual(modEnabled({ env: { CLAUDE_CUSTOM_MOD: '1' }, stateDir: dir }), false);
});

test('a binary override is a stand-in, so the mod is off unless =1 asks for it', () => {
  assert.strictEqual(modEnabled({ env: { CLAUDE_CUSTOM_BIN: 'C:/x/fake.cmd' }, stateDir: state() }), false);
  assert.strictEqual(modEnabled({ env: { CLAUDE_CUSTOM_BIN: 'C:/x/fake.cmd', CLAUDE_CUSTOM_MOD: '1' }, stateDir: state() }), true);
  assert.strictEqual(modEnabled({ env: { CLAUDE_CUSTOM_BIN: '' }, stateDir: state() }), true);
});

test('the switch reads back what it wrote, keeps other keys, and refuses a non-boolean', () => {
  const dir = state();
  assert.strictEqual(readModSetting(dir), true, 'no file: on');
  assert.strictEqual(writeModSetting(dir, false), false);
  assert.strictEqual(readModSetting(dir), false);
  fs.writeFileSync(path.join(dir, 'cc-mod-settings.json'), JSON.stringify({ mod: false, other: 1 }));
  assert.strictEqual(writeModSetting(dir, true), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'cc-mod-settings.json'), 'utf8')), { mod: true, other: 1 });
  for (const bad of ['yes', 1, null, undefined]) assert.strictEqual(writeModSetting(dir, bad), null);
  assert.strictEqual(writeModSetting('', true), null);
});

test('the switch\'s read is null (unknown) when the file cannot be read for a reason other than missing or corrupt', () => {
  assert.strictEqual(readModSetting(''), null);
  assert.strictEqual(readModSetting(undefined), null);
  const dir = state();
  fs.mkdirSync(path.join(dir, 'cc-mod-settings.json'));      // a directory where the file should be: EISDIR
  assert.strictEqual(readModSetting(dir), null);
});

test('a corrupt file reads as on, and a write replaces it', () => {
  const dir = state();
  fs.writeFileSync(path.join(dir, 'cc-mod-settings.json'), '{nope');
  assert.strictEqual(readModSetting(dir), true);
  assert.strictEqual(writeModSetting(dir, false), false);
  assert.strictEqual(readModSetting(dir), false);
});

// --- the version gate ---------------------------------------------------------------------------------------------------

test('parseCliVersion reads the CLI\'s own line', () => {
  assert.deepStrictEqual(parseCliVersion('2.1.304 (Claude Code)\n'), [2, 1, 304]);
  assert.deepStrictEqual(parseCliVersion('2.1.290'), [2, 1, 290]);
  assert.deepStrictEqual(parseCliVersion('v20.11.0'), [20, 11, 0]);
});

test('parseCliVersion answers null for anything that is not a version', () => {
  for (const v of ['', 'claude', '2.1', '2.1.x', 'a.b.c', undefined, null, 5, {}]) assert.strictEqual(parseCliVersion(v), null, String(v));
});

test('versionAtLeast compares numerically, part by part', () => {
  assert.strictEqual(versionAtLeast([2, 1, 290], [2, 1, 290]), true);
  assert.strictEqual(versionAtLeast([2, 1, 304], [2, 1, 290]), true);
  assert.strictEqual(versionAtLeast([2, 1, 289], [2, 1, 290]), false);
  assert.strictEqual(versionAtLeast([2, 2, 0], [2, 1, 290]), true);
  assert.strictEqual(versionAtLeast([3, 0, 0], [2, 1, 290]), true);
  assert.strictEqual(versionAtLeast([2, 0, 999], [2, 1, 290]), false);
  assert.strictEqual(versionAtLeast([1, 9, 999], [2, 1, 290]), false);
  assert.strictEqual(versionAtLeast([2, 1, 1000], [2, 1, 999]), true, 'numeric, not text: 1000 > 999');
});

test('versionAtLeast of an unknown version is false', () => {
  for (const v of [null, undefined, [], [2, 1], 'x']) assert.strictEqual(versionAtLeast(v, [2, 1, 290]), false);
});

test('modPluginDirFor: the directory only when enabled, new enough and present', () => {
  const dir = 'C:/repo/mods/claude-custom';
  const ok = { enabled: true, version: [2, 1, 304], dir, exists: () => true };
  assert.strictEqual(modPluginDirFor(ok), dir);
  assert.strictEqual(modPluginDirFor({ ...ok, enabled: false }), null, 'the switch is off');
  assert.strictEqual(modPluginDirFor({ ...ok, version: [2, 1, 289] }), null, 'an older CLI gets no flag');
  assert.strictEqual(modPluginDirFor({ ...ok, version: null }), null, 'an unknown version gets no flag');
  assert.strictEqual(modPluginDirFor({ ...ok, exists: () => false }), null, 'no directory, no flag');
  assert.strictEqual(modPluginDirFor({ ...ok, exists: () => { throw new Error('x'); } }), null);
});

test('modPluginDirFor: =1 on a stand-in binary skips the version check but not the switch or the directory', () => {
  const dir = 'C:/repo/mods/claude-custom';
  const f = { enabled: true, version: null, dir, exists: () => true, forced: true };
  assert.strictEqual(modPluginDirFor(f), dir);
  assert.strictEqual(modPluginDirFor({ ...f, enabled: false }), null);
  assert.strictEqual(modPluginDirFor({ ...f, exists: () => false }), null);
});

test('readCliVersion asks the binary for --version and parses the answer', async () => {
  const v = await readCliVersion(process.execPath);
  assert.ok(Array.isArray(v) && v.length === 3 && v.every(Number.isInteger), JSON.stringify(v));
});

test('readCliVersion is null for a binary that does not exist, never a throw', async () => {
  assert.strictEqual(await readCliVersion(path.join(state(), 'no-such-claude.exe')), null);
});

// --- PR #197 Dexter 10: a prerelease of the floor is below the floor ---------------------------------------------------------------

test('Dexter 10: 2.1.290-beta.1 fails the 2.1.290 gate; a release of 2.1.290 and a prerelease of a later version pass', () => {
  const pre = parseCliVersion('2.1.290-beta.1 (Claude Code)');
  assert.deepStrictEqual([...pre], [2, 1, 290]);
  assert.strictEqual(pre.pre, true);
  assert.strictEqual(versionAtLeast(pre, MIN_CLI_VERSION), false);
  assert.strictEqual(versionAtLeast(parseCliVersion('2.1.290 (Claude Code)'), MIN_CLI_VERSION), true);
  assert.strictEqual(versionAtLeast(parseCliVersion('2.1.291-rc.2'), MIN_CLI_VERSION), true);
  assert.strictEqual(versionAtLeast(parseCliVersion('2.1.289-beta'), MIN_CLI_VERSION), false);
});

test('Dexter 10: a plain version carries no prerelease mark, so it still equals a plain array', () => {
  assert.deepStrictEqual(parseCliVersion('2.1.304 (Claude Code)'), [2, 1, 304]);
  assert.strictEqual(parseCliVersion('2.1.304').pre, undefined);
});

test('Dexter 10: modPluginDirFor refuses the prerelease of the floor', () => {
  const dir = 'C:/m';
  assert.strictEqual(modPluginDirFor({ enabled: true, version: parseCliVersion('2.1.290-beta.1'), dir, exists: () => true }), null);
});

// --- PR #197 Miguel Y9: the version read is bounded short ----------------------------------------------------------------------------

test('Miguel Y9: the version read gives up after three seconds by default', () => {
  assert.strictEqual(require('../host/cc-mod-settings').VERSION_TIMEOUT_MS, 3000);
});

// --- PR #197 Miguel Y9: say why the mod is not loaded --------------------------------------------------------------------------------

const { modOffReason } = require('../host/cc-mod-settings');

test('Miguel Y9: modOffReason names the cause, and is null when the mod loads', () => {
  const ok = { enabled: true, version: [2, 1, 304], dir: 'C:/m', exists: () => true };
  assert.strictEqual(modOffReason(ok), null);
  assert.match(modOffReason({ ...ok, enabled: false }), /switched off/);
  assert.match(modOffReason({ ...ok, version: null }), /version could not be read/);
  assert.match(modOffReason({ ...ok, version: [2, 1, 289] }), /2\.1\.289.*2\.1\.290/);
  assert.match(modOffReason({ ...ok, version: parseCliVersion('2.1.290-beta.1') }), /2\.1\.290-beta.*2\.1\.290|prerelease/);
  assert.match(modOffReason({ ...ok, exists: () => false }), /directory/);
});

test('Miguel Y9: a forced stand-in binary is not blamed for an unreadable version', () => {
  assert.strictEqual(modOffReason({ enabled: true, version: null, dir: 'C:/m', exists: () => true, forced: true }), null);
});

test('Miguel Y9: modOffReason agrees with modPluginDirFor: a reason exactly when there is no directory', () => {
  for (const enabled of [true, false]) for (const version of [null, [2, 1, 289], [2, 1, 290], [2, 2, 0]]) for (const present of [true, false]) for (const forced of [true, false]) {
    const f = { enabled, version, dir: 'C:/m', exists: () => present, forced };
    assert.strictEqual(modOffReason(f) === null, modPluginDirFor(f) !== null, JSON.stringify(f));
  }
});
