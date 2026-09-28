'use strict';
/**
 * The renderer sends the DESIRED favourite state, and rolls back a failed
 * save (Dexter, PR #60 review, F6/F7).
 *
 * SOURCE assertions, same reasoning as test/renderer-dispatch.test.js:
 * app/renderer.js needs a real DOM and cannot be `require()`d into a unit
 * test. Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');

test('F6: the renderer sends the desired state through favourites.set, never a bare toggle', () => {
  assert.match(SRC, /window\.harness\.favourites\.set\(kind, id, on\)/,
    'toggleModelFavourite must call favourites.set with the state it computed, not .toggle()');
  assert.doesNotMatch(SRC, /harness\.favourites\.toggle/,
    'the old toggle-based call must not remain alongside the new one');
});

test('F7: a failed save (answers null, or throws) rolls the optimistic star back', () => {
  const start = SRC.indexOf('function toggleModelFavourite');
  assert.ok(start !== -1, 'precondition: toggleModelFavourite must still exist');
  const body = SRC.slice(start, SRC.indexOf('\n}', start));
  assert.match(body, /modelFavourites = f \? normalizeFavourites\(f\) : before;/,
    'a null/failed save must roll modelFavourites back to its pre-click value, not keep the optimistic guess');
  assert.match(body, /\.catch\(\(\) => \{\s*modelFavourites = before;/,
    'a rejected favourites.set() promise must also roll back, not just a resolved-null one');
});
