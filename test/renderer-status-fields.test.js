'use strict';
/**
 * Layout pass L2's wiring in app/renderer.js and app/renderer.html: the status
 * fields in the tab header (#27) and the Window section's two toggles (#27,
 * #28). The decisions are pure and tested in test/status-fields-display.test.js
 * and test/style-display.test.js; these pin that the browser script USES them.
 * Source assertions in the style of test/renderer-context-fill.test.js --
 * renderer.js cannot be required.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const JS = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');

function branch(type) {
  const start = JS.indexOf(`if (msg.type === '${type}')`);
  assert.ok(start !== -1, `renderer.js must handle ${type}`);
  const next = JS.indexOf('if (msg.type ===', start + 10);
  return JS.slice(start, next === -1 ? undefined : next);
}
function fnBody(name) {
  const start = JS.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} must exist`);
  return JS.slice(start, JS.indexOf('\n}', start));
}

test('the header has a status-fields span after the top bar, hidden until there is something to show', () => {
  const header = HTML.slice(HTML.indexOf('<header'), HTML.indexOf('</header>'));
  assert.match(header, /<span id="status-fields"[^>]*\bhidden\b/);
  assert.ok(header.indexOf('id="top-bar"') < header.indexOf('id="status-fields"'));
});

test('Miguel L2 Y1: the fields give way first in a crowded header (shrink, clip with an ellipsis)', () => {
  const rule = (HTML.match(/#status-fields\s*\{[^}]*\}/) || [''])[0];
  assert.match(rule, /min-width:\s*0/);
  assert.match(rule, /overflow:\s*hidden/);
  assert.match(rule, /text-overflow:\s*ellipsis/);
  assert.match(rule, /flex-shrink:\s*[1-9]/);
  // ...but only after the keyboard hints: alone, it shrank to 0px in a 1200px window (measured).
  const hint = (HTML.match(/header \.hint\s*\{[^}]*\}/) || [''])[0];
  assert.match(hint, /flex:\s*0\s+1000\s+auto/);
  assert.match(hint, /min-width:\s*0/);
});

test('renderer.html loads the module before renderer.js', () => {
  const a = HTML.indexOf('<script src="./status-fields-display.js"></script>');
  const b = HTML.indexOf('<script src="./renderer.js"></script>');
  assert.ok(a !== -1 && b !== -1 && a < b);
});

test('renderStatusFields draws statusFieldsView (the rule is behaviour-tested there, Miguel L2 G1)', () => {
  const body = fnBody('renderStatusFields');
  assert.match(body, /statusFieldsView\(lastStatusFields, chromeSettings\.statusInHeader\)/);
  assert.match(body, /\.textContent = view\.text/);
  assert.match(body, /\.hidden = !view\.shown/);
});

test('a live statusFields message and the hello both render the fields', () => {
  assert.match(branch('statusFields'), /renderStatusFields\(msg\.fields\)/);
  assert.match(branch('hello'), /renderStatusFields\(msg\.statusFields\)/);
});

test('main\'s chrome settings are read once and followed, and re-render the fields', () => {
  assert.match(JS, /window\.harness\.chrome\.onChange\(applyChromeSettings\)/);
  assert.match(JS, /^\s*refreshChromeSettings\(\);/m, 'the first read goes through the retrying reader');
  const apply = fnBody('applyChromeSettings');
  assert.match(apply, /reduceChromeSettings\(/);
  assert.match(apply, /renderStatusFields\(/);
});

test('Dexter L2 #1: an unknown answer (null, or a failed read) is asked again, never taken as OFF', () => {
  const body = fnBody('refreshChromeSettings');
  assert.match(body, /chrome\.get\(\)/);
  assert.match(body, /setTimeout\(refreshChromeSettings/, 'a null answer schedules another read');
  assert.doesNotMatch(body, /statusInHeader:\s*false/);
});

test('the Window section draws both toggles and sends the DESIRED state', () => {
  assert.match(JS, /id="style-status-in-header"/);
  assert.match(JS, /id="style-frameless"/);
  assert.match(JS, /setStatusInHeader\(\w+\.checked\)/);
  assert.match(JS, /setFrameless\(\w+\.checked\)/);
});
