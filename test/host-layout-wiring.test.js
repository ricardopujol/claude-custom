'use strict';
/**
 * host.js's half of a tab's own layout (layout pass L1, S6): source assertions
 * in the style of test/host-session-wiring.test.js, because host.js can't be
 * loaded by a unit test. The behaviour runs end to end in
 * L1's probe (verify/probe-dock-zones.js, since replaced by probe-dock-tree.js; check 5: the override survives a reattach).
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

function blockFrom(marker) {
  const start = HOST.indexOf(marker);
  assert.ok(start !== -1, `host.js must contain ${marker}`);
  return HOST.slice(start, HOST.indexOf('\n    }', start));
}

test('the host remembers a tab\'s own layout in memory only, starting with none', () => {
  assert.match(HOST, /\nlet layoutOverride = null;/);
  assert.doesNotMatch(HOST, /store\.\w+\([^)]*layoutOverride/, 'never persisted: it dies with the session');
});

test('every attaching window is told the tab\'s own layout in its hello', () => {
  const hello = HOST.slice(HOST.indexOf("type: 'hello',"), HOST.indexOf('});', HOST.indexOf("type: 'hello',")));
  assert.match(hello, /\n\s+layoutOverride,\r?\n/);   // \r?: a CRLF checkout
});

test('a layout-override is checked, kept, and broadcast to every window on this host', () => {
  const block = blockFrom("if (msg.type === 'layout-override') {");
  assert.match(block, /const r = acceptOverride\(msg\.layout\);/);
  assert.match(block, /if \(!r\.ok\) \{[^}]*return;/);
  assert.match(block, /layoutOverride = r\.value;/);
  assert.match(block, /broadcastControl\(\{ type: 'layout-override', layout: layoutOverride \}\);/);
  assert.match(HOST, /const \{ acceptOverride \} = require\('\.\/layout-override'\);/);
});
