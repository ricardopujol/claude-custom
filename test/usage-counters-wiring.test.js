'use strict';
/**
 * Source assertions for the usage counters' wiring (the host, Electron main and the renderer can't be loaded by a unit test).
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { CONTROL_TYPES, parseControlFrame } = require('../host/control');
const { isValidKey } = require('../host/usage-counters');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const RENDERER = read('app', 'renderer.js');
const HOST = read('host', 'host.js');

test('a usage frame is a KNOWN control type, or it would be typed into the pty as JSON', () => {
  assert.ok(CONTROL_TYPES.has('usage'));
  assert.deepStrictEqual(parseControlFrame(JSON.stringify({ type: 'usage', key: 'git:opened' })), { type: 'usage', key: 'git:opened' });
});

test('the host counts a usage frame and answers nothing', () => {
  assert.match(HOST, /const usageCounters = createUsageCounters\(\{ store \}\);/);
  assert.match(HOST, /msg\.type === 'usage'\) \{\s*usageCounters\.bump\(msg\.key\);[^\n]*\n\s*return;/);
});

test('every key the code bumps is valid', () => {
  const keys = new Set();
  for (const src of [RENDERER, HOST, read('app', 'tab-shell.js')]) {
    for (const m of src.matchAll(/(?:usage|usageCounters\.bump)\('([a-z0-9:-]+)'\)/g)) keys.add(m[1]);
  }
  assert.ok(keys.size >= 14, `found only ${[...keys].join(', ')}`);
  for (const k of keys) assert.ok(isValidKey(k), k);
});

test('the renderer counts a panel per show and the games report their name', () => {
  assert.match(RENDERER, /for \(const id of fx\.newlyShown\) \{ usage\('panel:' \+ id\); onModuleShown\(id\); \}/);
  assert.match(RENDERER, /onStart: \(game\) => usage\('game:' \+ game \+ ':start'\)/);
});

test('every dock panel id makes a valid key', () => {
  const ids = [...read('app', 'side-tabs.js').matchAll(/\{ id: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(ids.length > 5);
  for (const id of ids) assert.ok(isValidKey('panel:' + id), id);
});
