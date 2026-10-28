'use strict';
/**
 * BACKLOG #42 + #43: the header and the shortcuts sheet are wired in app/renderer.html and app/renderer.js.
 * The decisions are tested in test/shortcut-table.test.js, test/shortcuts-display.test.js, test/usage-display.test.js and
 * test/quota-display.test.js; these pin that the browser scripts USE them. Source assertions, in the style of
 * test/renderer-top-bar.test.js: renderer.js cannot be required. The real window is measured by verify/probe-header-fit.js
 * and verify/probe-shortcuts-page.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const JS = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');

const header = HTML.slice(HTML.indexOf('<header'), HTML.indexOf('</header>'));

test('#42: the two keyboard hints are gone from the header; one "?" button stands in for them', () => {
  assert.ok(!/class="hint"/.test(header), 'no .hint span is left in the header');
  assert.ok(!/panels <kbd>/.test(header) && !/diagnostics <kbd>/.test(header));
  const btn = header.match(/<button[^>]*id="shortcuts-btn"[^>]*>([^<]*)<\/button>/);
  assert.ok(btn, 'a #shortcuts-btn button');
  assert.strictEqual(btn[1].trim(), '?');
  assert.match(btn[0], /class="hdr-btn"/);
  assert.match(btn[0], /title="[^"]*F1[^"]*"/, 'its tooltip names the key');
  assert.match(btn[0], /aria-label="[^"]+"/);
  assert.match(btn[0], /aria-controls="shortcuts-sheet"/);
  assert.match(btn[0], /aria-expanded="false"/);
});

test('#42: the removed #side-hint is not looked up any more (a null.addEventListener would abort the renderer)', () => {
  assert.ok(!JS.includes("getElementById('side-hint')"));
});

test('#42: usage reads "62M tok" and quota "41% · 18:00" in the header, the long form stays in the tooltips', () => {
  const usage = JS.slice(JS.indexOf('function renderUsage('), JS.indexOf('// --- plan quota'));
  assert.match(usage, /tokText\(/);
  // The long forms are built once (sessionTitle, projectTitle) and both groups' hovers carry both (Miguel r2 N1).
  assert.match(usage, /const sessionTitle = title\(`This session/);
  assert.match(usage, /const projectTitle = title\(`Every session on this folder/);
  assert.match(usage, /title="\$\{escapeHtml\(`\$\{sessionTitle\}\\n\$\{projectTitle\}`\)\}"/);
  const quota = JS.slice(JS.indexOf('function renderQuota('), JS.indexOf('// The countdown in every tooltip'));
  assert.match(quota, /m\.short/);
  assert.match(quota, /title="\$\{escapeHtml\(m\.title\)\}"/);
});

test('#43: the scripts load in order, before renderer.js, and the sheet has a search box and a dialog role', () => {
  const at = (s) => HTML.indexOf(`<script src="./${s}"`);
  assert.ok(at('shortcut-table.js') > 0 && at('shortcuts-display.js') > at('shortcut-table.js'));
  assert.ok(at('shortcuts-display.js') < at('renderer.js'));
  const sheet = HTML.slice(HTML.indexOf('id="shortcuts-sheet"'));
  assert.match(sheet, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(sheet, /id="shortcuts-search"/);
  assert.match(sheet, /id="shortcuts-body"/);
  assert.match(HTML, /<div[^>]*id="shortcuts-sheet"[^>]*\bhidden\b/);
});

test('#43: F1 reaches the page through window.toggleShortcutsPage (main calls it), Esc closes, focus goes back', () => {
  assert.match(JS, /window\.toggleShortcutsPage\s*=/);
  assert.ok(JS.includes("e.key === 'Escape' && shortcutsOpen"), 'Esc closes while open');
  assert.match(JS, /shortcutsReturnFocus/);
  assert.match(JS, /sheetBodyHtml\(/);
  assert.match(JS, /getElementById\('shortcuts-btn'\)/);
  assert.match(JS, /shortcutsBtnEl\.addEventListener\('click', window\.toggleShortcutsPage\)/);
});

test('#43: a page header with the sheet open keeps the "?" button reachable (the sheet starts below the header)', () => {
  assert.match(JS, /querySelector\('header'\)[\s\S]{0,400}getBoundingClientRect\(\)\.bottom/);
});

test('#42: a long usage or quota NOTE (a failed read says why, in words) shrinks before the "?" and the layout buttons are pushed off', () => {
  // The two hints used to be the header's shrink-first items (flex 0 1000). They are a button now, which never shrinks, so
  // usage and quota (whose notes can be a whole sentence) are the last-resort shrinkers: far lighter than the folder and the
  // CLI status fields, which give way first, but able to clip instead of pushing the buttons past the window edge.
  for (const id of ['usage', 'quota']) {
    const rule = (HTML.match(new RegExp('#' + id + '\\s*\\{[^}]*\\}')) || [''])[0];
    assert.match(rule, /flex:\s*0\s+0?\.\d+\s+auto/, `#${id} may shrink, last`);
    assert.match(rule, /min-width:\s*0/, id);
    assert.match(rule, /overflow:\s*hidden/, id);
  }
});

test('PR #156 #1: while the sheet is open Tab is trapped in it and the page under the header is inert', () => {
  assert.match(JS, /nextFocusIndex\(/);
  assert.match(JS, /getElementById\('body'\)\.inert = true/);
  assert.match(JS, /getElementById\('body'\)\.inert = false/);
  assert.match(JS, /e\.key === 'Tab' && shortcutsOpen/);
});

test('PR #156 #2: the sheet\'s top follows the header (resize, focus mode) while it is open', () => {
  assert.match(JS, /new ResizeObserver\(\(\) => \{ if \(shortcutsOpen\) placeShortcuts\(\); \}\)\.observe\(/);
});

test('PR #156 #4: the Window menu has Show / hide panels, so the click the old hint offered still has a home', () => {
  const open = JS.slice(JS.indexOf('function openLayoutMenu('), JS.indexOf("document.getElementById('layout-btn').addEventListener('click'"));
  assert.match(open, /Show \/ hide panels/);
  assert.match(open, /toggleAllZones\(\)/);
});

test('PR #156 #5: the dead "#usage .sub" rule is gone (nothing draws a .sub any more)', () => {
  assert.ok(!/#usage \.sub\b/.test(HTML));
});
