'use strict';
/**
 * The Models tab keeps asking, not just once per window (Dexter/Miguel, PR
 * #60 review, F2/I1/F3).
 *
 * SOURCE assertions, same reasoning as test/renderer-dispatch.test.js:
 * app/renderer.js needs a real DOM and cannot be `require()`d into a unit
 * test. Repo-scanning, so deliberately NOT in Stryker's command (its subject
 * is the file's shape, not an expression a mutator can reach).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');

test('F2/I1: the Models tab asks EVERY time it opens, not only the first time ever', () => {
  // The old guard `if (tab === 'models' && !catalogueMeta) requestModels(false);`
  // stopped re-checking forever after the first answer -- a window kept open
  // past one FRESH_MS window never refreshed its own "just now" label again.
  assert.doesNotMatch(SRC, /tab === 'models' && !catalogueMeta/,
    'the tab-open request must not be gated on "never answered before"');
  assert.match(SRC, /if \(tab === 'models'\) requestModels\(false\);/,
    'every Models-tab open must ask -- host/openrouter.js\'s loadCatalogue decides freshness cheaply');
});

test('F3: a Refresh click (or tab open) that lands while the socket is reconnecting is resumed on open', () => {
  // requestModels()'s ws.send throws while CONNECTING and is swallowed --
  // without this, the button stays disabled "Refreshing..." forever, since
  // nothing else re-asks once the socket comes up.
  const onopenStart = SRC.indexOf('ws.onopen = () => {');
  assert.ok(onopenStart !== -1, 'precondition: onopen must still exist');
  const onopenBody = SRC.slice(onopenStart, SRC.indexOf('\n  };', onopenStart));
  assert.match(onopenBody, /if \(activeTab === 'models'\) requestModels\(modelsRefreshPending\)/,
    'onopen must resume a models request, carrying forward a stuck Refresh (force) rather than downgrading it');
});
