'use strict';
/**
 * BACKLOG #27's wiring in host/host.js (module-level, spawns a pty, so it is
 * source-checked -- the decisions themselves are status-relay's quiet() and
 * hook-session's readStatusFields, tested in test/status-relay.test.js and
 * test/status-fields.test.js). Repo-scanning: NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('host.js: every Status document sets the status fields, before the model check', () => {
  const start = HOST.indexOf("if (ev.event === 'Status')");
  assert.ok(start !== -1);
  const body = HOST.slice(start, HOST.indexOf('return;', start));
  assert.match(body, /setStatusFields\(readStatusFields\(ev\.payload\)\)/);
  assert.ok(body.indexOf('setStatusFields') < body.indexOf('status.model'),
    'a document without a model must clear the fields (null), not leave the last ones standing');
});

test('host.js: the status fields are broadcast on change and carried in the hello', () => {
  assert.match(HOST,
    /function setStatusFields\(fields\)[\s\S]*?broadcastControl\(\{ type: 'statusFields', fields: lastStatusFields/);
  assert.match(HOST, /^\s*statusFields: lastStatusFields,/m);
});

test('host.js: the relay gets the chrome toggle file, under the install state dir', () => {
  assert.match(HOST, /quietWhen: path\.join\(HARNESS_DIR, 'state', 'chrome-global\.json'\)/);
});
