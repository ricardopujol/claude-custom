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
  assert.match(body, /setContext\(contextSource\.fromRelay\(readContext\(ev\.payload\)\)\)/);
  assert.ok(body.indexOf('setContext') < body.indexOf('status.model'),
    'the context is set before the model check, so a doc without a model cannot leave a stale fill');
});

test('host.js: the context is broadcast on change and carried in the hello handshake', () => {
  assert.match(HOST, /broadcastControl\(\{ type: 'context', context: lastContext/);
  assert.match(HOST, /^\s*context: lastContext,/m);
});

test('host.js: SessionStart with source clear or compact resets the context to unknown (Dexter F3)', () => {
  const start = HOST.indexOf("ev.event === 'SessionStart'");
  assert.ok(start !== -1);
  const guard = HOST.slice(start, HOST.indexOf("ev.event === 'SessionStart' && ev.payload && ev.payload.session_id"));
  assert.match(guard, /source === 'clear'/);
  assert.match(guard, /source === 'compact'/);
  assert.match(guard, /setContext\(null\)/);
  // setContext(null) broadcasts { type: 'context', context: null } on a change.
  assert.match(HOST, /function setContext\(ctx\)[\s\S]*?broadcastControl\(\{ type: 'context', context: lastContext/);
});

test('host.js: a plain startup or resume does NOT clear the fill', () => {
  const start = HOST.indexOf("ev.event === 'SessionStart'");
  const guard = HOST.slice(start, HOST.indexOf("ev.event === 'SessionStart' && ev.payload && ev.payload.session_id"));
  assert.doesNotMatch(guard, /'startup'|'resume'/);
});
