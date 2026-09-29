'use strict';
/**
 * The favourites section obeys the same DOM row cap as the grouped section
 * (Miguel, PR #60 review, S2).
 *
 * SOURCE assertion, same reasoning as test/renderer-dispatch.test.js:
 * app/renderer.js needs a real DOM and cannot be `require()`d into a unit
 * test. Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');

test('S2: the favourites render loop checks the LIMIT, same as the provider loop', () => {
  const start = SRC.indexOf('for (const m of favRows)');
  assert.ok(start !== -1, 'precondition: the favourites render loop must still exist');
  const body = SRC.slice(start, SRC.indexOf('\n  }', start + 1) + 4);
  assert.match(body, /if \(drawn >= LIMIT\) break;/,
    'the favourites loop must break at LIMIT exactly like the provider-grouped loop does');
});
