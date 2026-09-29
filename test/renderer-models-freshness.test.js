'use strict';
/**
 * The Models tab keeps asking, not just once per window (Dexter/Miguel, PR
 * #60 review round 1, F2/I1/F3; round 2, N3).
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

// Dexter, PR #60 round 2: the round-1 version of this check matched the
// literal line ANYWHERE in the file, so moving it into dead code or an
// unrelated function would still satisfy it. Scoped to setTab's own body.
function setTabBody() {
  const start = SRC.indexOf('function setTab(tab) {');
  assert.ok(start !== -1, 'precondition: setTab must still exist');
  return SRC.slice(start, SRC.indexOf('\n}', start));
}

test('F2/I1: the Models tab asks EVERY time it opens, not only the first time ever', () => {
  // The old guard `if (tab === 'models' && !catalogueMeta) requestModels(false);`
  // stopped re-checking forever after the first answer -- a window kept open
  // past one FRESH_MS window never refreshed its own "just now" label again.
  const body = setTabBody();
  assert.doesNotMatch(body, /tab === 'models' && !catalogueMeta/,
    'the tab-open request must not be gated on "never answered before"');
  assert.match(body, /if \(tab === 'models'\) requestModels\(false\);/,
    'setTab itself must ask every open -- host/openrouter.js\'s loadCatalogue decides freshness cheaply');
});

function onopenBody() {
  const start = SRC.indexOf('ws.onopen = () => {');
  assert.ok(start !== -1, 'precondition: onopen must still exist');
  return SRC.slice(start, SRC.indexOf('\n  };', start));
}

test('F3: a Refresh click (or tab open) that lands while the socket is reconnecting is resumed on open', () => {
  // requestModels()'s ws.send throws while CONNECTING and is swallowed --
  // without this, the button stays disabled "Refreshing..." forever, since
  // nothing else re-asks once the socket comes up.
  const body = onopenBody();
  assert.match(body, /const seq = requestModels\(modelsRefreshPending\);/,
    'onopen must resume a models request, carrying forward a stuck Refresh (force) rather than downgrading it');
});

test('N3: the onopen resume is not gated on the Models tab being the ACTIVE one', () => {
  // Dexter, PR #60 round 2, N3: `modelsRefreshPending` is WINDOW state, not
  // tab state. A Refresh click made just before switching to Fog, followed by
  // the socket reconnecting while Fog is still showing, must still resume --
  // gating the resume on `activeTab === 'models'` alone left it stuck until
  // the user happened to switch back.
  const body = onopenBody();
  assert.match(body, /if \(activeTab === 'models' \|\| modelsRefreshPending\)/,
    'the resume condition must fire regardless of the active tab when a Refresh is pending');
});
