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

test('host.js: the relay gets the chrome toggle file, under the install state dir', () => {
  assert.match(HOST, /quietWhen: path\.join\(HARNESS_DIR, 'state', 'chrome-global\.json'\)/);
});
