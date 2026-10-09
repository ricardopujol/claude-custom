'use strict';
/**
 * BACKLOG #76: the roster header controls and the renderer wiring, source-sliced
 * (renderer.js can't be required). The drawing itself is checked in a real window.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const HTML = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');
const JS = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');

test('the header has the Role/Name toggle and the search button, and the module loads before renderer.js', () => {
  assert.match(HTML, /id="roster-names-toggle"/);
  assert.match(HTML, /data-roster-names="role"/);
  assert.match(HTML, /data-roster-names="name"/);
  assert.match(HTML, /id="roster-search-btn"/);
  assert.match(HTML, /id="roster-search-row" hidden/);
  assert.ok(HTML.indexOf('./roster-search-display.js') !== -1);
  assert.ok(HTML.indexOf('./roster-search-display.js') < HTML.indexOf('./renderer.js'));
});

test('both tabs draw their names through agentNameHtml, so neither can skip the toggle', () => {
  assert.match(JS, /agentNameHtml\(row\.agent, entry,/);
  assert.match(JS, /agentNameHtml\(r\.agent, entry,/);
  assert.match(JS, /agentFnHtml\(entry\)/);
});

test('the function line is clamped to two lines with the full text in the title', () => {
  assert.match(HTML, /-webkit-line-clamp:\s*2/);
  assert.match(JS, /class="agent-fn" title="\$\{escapeHtml\(entry\.fn\)\}"/);
});

test('Esc in the search field closes it and clears the query', () => {
  assert.match(JS, /e\.key === 'Escape'[\s\S]{0,80}setRosterSearch\(false\)/);
  assert.match(JS, /rosterQuery = '';/);
});

test('an empty search result uses the shared message and escapes it', () => {
  assert.match(JS, /escapeHtml\(window\.rosterSearchDisplay\.emptyMessage\(activeRosterTab, rosterQuery\)\)/);
});

test('both tabs filter by the same query', () => {
  assert.match(JS, /inactive\.filter\(rosterMatches\)/);
  assert.match(JS, /visible\.filter\(\(r\) => rosterMatches\(r\.agent\)\)/);
});

test('the toggle is saved through main, not localStorage', () => {
  assert.match(JS, /window\.harness\.avatar\.setRosterNames\(mode\)/);
  assert.match(JS, /window\.harness\.avatar\.onRosterNames\(applyRosterNames\)/);
});

// --- PR #141 review fixes ------------------------------------------------------

test('Miguel 1: the small name wraps to its own line instead of ellipsising', () => {
  assert.match(JS, /class="name-big"/);
  assert.match(HTML, /\.agent \.name \{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
  assert.match(HTML, /\.agent \.name \.name-big \{[^}]*text-overflow:\s*ellipsis/);
});

test('Miguel 5, 6: Esc returns focus to the search button; the emoji buttons have aria-labels', () => {
  assert.match(JS, /rosterSearchBtnEl\.focus\(\)/);
  assert.match(HTML, /id="roster-search-btn"[^>]*aria-label="Search the agents in this tab"/);
  assert.match(HTML, /id="images-toggle"[^>]*aria-label="/);
});

test('F2: an Active search counts hidden matches and offers the existing reveal', () => {
  assert.match(JS, /hiddenMatchMessage\(/);
  assert.match(JS, /data-roster-reveal/);
  assert.match(JS, /closest\('\[data-roster-reveal\]'\)/);
  // the "try the other tab" message is only for a search with no hidden match either
  assert.match(JS, /hiddenMatches\.length > 0/);
});

test('F2: the show-hidden button says how many hidden agents match the search', () => {
  assert.match(JS, /\$\{hiddenMatches\.length\} match/);
});

test('#2: a refused names save snaps the toggle back to the saved value', () => {
  assert.match(JS, /Refused \(the record was locked\)[\s\S]{0,120}getRosterNames\(\)\.then\(applyRosterNames\)/);
});
