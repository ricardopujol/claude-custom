'use strict';
/**
 * Dexter F3 (PR #64) wiring, asserted on source because host/host.js and
 * app/main.js boot real processes. The behaviour is in test/global-watch.test.js
 * and test/avatar-toggle-watch.test.js. Repo-scanning: not in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const HOST = read('host', 'host.js');
const MAIN = read('app', 'main.js');
const RENDERER = read('app', 'renderer.js');

test('the host watches the shared _global folder and repaints every face on a change', () => {
  const i = HOST.indexOf("watchGlobalDir(path.join(GLOBAL_PORTRAIT_DIR, '_global')");
  assert.ok(i !== -1, 'host.js must start the watcher on the user-wide GLOBAL_PORTRAIT_DIR/_global');
  const call = HOST.slice(i, HOST.indexOf('repaintAllPortraits();', i) + 30);
  assert.match(call, /repaintAllPortraits\(\)/);
  assert.match(call, /globalPortraitInfo\(\)/);
  assert.match(call, /quiet: true/);
});

test('the renderer updates the Style row for a quiet change but does not announce it', () => {
  const i = RENDERER.indexOf("msg.type === 'portrait' && msg.global");
  const b = RENDERER.slice(i, RENDERER.indexOf('return;\n  }', i));
  assert.ok(b.indexOf('reduceAvatars') < b.indexOf('msg.quiet'));
  assert.ok(b.indexOf('msg.quiet') < b.indexOf('flourish('));
});

test('Electron main follows the toggle store file that other windows write', () => {
  assert.match(MAIN, /watchImagesEnabled\(\{[\s\S]*?store: uiStore[\s\S]*?\$\{AVATAR_KEY\}\.json/);
});

test('the host reads, watches and writes the default picture in the user-wide folder, not UPLOADS_DIR', () => {
  assert.match(HOST, /const GLOBAL_PORTRAIT_DIR = userGlobalDir\(/);
  assert.match(HOST, /portraitFor\(agent, state, \{[^}]*globalDir: GLOBAL_PORTRAIT_DIR/);
  assert.match(HOST, /adoptOnStart\(\{\s*userDir: GLOBAL_PORTRAIT_DIR/);
  assert.match(HOST, /migrationCandidates\(\{ env: process\.env, uploadsDir: UPLOADS_DIR/);
  assert.match(HOST, /uploadsDir: GLOBAL_PORTRAIT_DIR,\s*stat:[^\n]*\n\s*resolve: \(\) => \(globalPortrait\(GLOBAL_PORTRAIT_DIR\)/);
  assert.doesNotMatch(HOST, /globalPortrait\(UPLOADS_DIR\)/);
});
