'use strict';
/**
 * BACKLOG #43: what the shortcuts sheet draws (app/shortcuts-display.js), from the key table.
 * The open/close/focus wiring is in app/renderer.js and is measured in a real window by verify/probe-shortcuts-page.js.
 */
const test = require('node:test');
const assert = require('node:assert');

const { sheetBodyHtml } = require('../app/shortcuts-display');
const { ROWS, GROUPS } = require('../app/shortcut-table');

test('with no query the body has every group heading, in order, and a row for every table row', () => {
  const html = sheetBodyHtml('');
  let last = -1;
  for (const g of GROUPS) {
    const i = html.indexOf(`>${g}</h3>`);
    assert.ok(i > last, `${g} heading missing or out of order`);
    last = i;
  }
  assert.strictEqual((html.match(/class="sc-row"/g) || []).length, ROWS.length);
  for (const r of ROWS) assert.ok(html.includes(`>${r.name}</span>`), r.name);
});

test('each key is its own <kbd>, so the header\'s styling applies', () => {
  const html = sheetBodyHtml('ctrl+shift+d');
  assert.match(html, /<kbd>Ctrl<\/kbd>\+<kbd>Shift<\/kbd>\+<kbd>D<\/kbd>/);
});

test('a key the CLI owns is marked Claude Code; one the app owns is not', () => {
  const rows = (html) => html.split('class="sc-row"').slice(1);
  const esc = rows(sheetBodyHtml('interrupt claude'));
  assert.ok(esc.length >= 1);
  assert.ok(esc.every(r => /class="sc-cli"[^>]*>Claude Code</.test(r)));
  const next = rows(sheetBodyHtml('next tab'));
  assert.ok(next.length >= 1);
  assert.ok(next.every(r => !/sc-cli/.test(r)));
});

test('the search narrows the sheet to the rows and groups that match', () => {
  const html = sheetBodyHtml('f1');
  assert.ok((html.match(/class="sc-row"/g) || []).length < ROWS.length);
  assert.ok(!html.includes('>Tabs</h3>'));
  assert.ok(html.includes('>This page</h3>'));
});

test('no match says so, and echoes the query escaped (it is typed text)', () => {
  const html = sheetBodyHtml('<img src=x onerror=1>');
  assert.ok(!html.includes('<img'), 'the query must be escaped');
  assert.match(html, /No shortcut matches/);
  assert.match(html, /&lt;img/);
  assert.ok(!/class="sc-row"/.test(html));
});

test('non-string queries are the empty query, never a throw', () => {
  for (const q of [undefined, null, 5, {}]) assert.strictEqual(sheetBodyHtml(q), sheetBodyHtml(''));
});
