'use strict';
/**
 * BACKLOG #6's wiring in host/host.js (module-level, spawns a pty, so it is
 * source-checked -- the decision itself is readContext, tested in
 * test/context-window.test.js). Repo-scanning: NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('host.js: a Status document sets the context on EVERY document, even one without a model', () => {
  const start = HOST.indexOf("if (ev.event === 'Status')");
  assert.ok(start !== -1);
  const body = HOST.slice(start, HOST.indexOf('return;', start));
  assert.match(body, /setContext\(readContext\(ev\.payload\)\)/);
  assert.ok(body.indexOf('setContext') < body.indexOf('status.model'),
    'the context is set before the model check, so a doc without a model cannot leave a stale fill');
});

test('host.js: the context is broadcast on change and carried in the hello handshake', () => {
  assert.match(HOST, /broadcastControl\(\{ type: 'context', context: lastContext/);
  assert.match(HOST, /^\s*context: lastContext,/m);
});
