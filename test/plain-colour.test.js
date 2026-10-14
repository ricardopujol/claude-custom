'use strict';
/** BACKLOG #92 + Dexter 1 (PR #175): Plain colour keeps the terminal's text readable, the way the terminal background does without a picture. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bg = require('../app/bg-media-display');
const { applyLook, contrastRatio, DEFAULT_LOOK, MIN_CONTRAST } = require('../host/look');

const THEME = { chrome: { bg: '#11131a', panel: '#171a23', border: '#262b38', text: '#c7cede', dim: '#6d7689', accent: '#d08c4a' }, terminal: { background: '#11131a', foreground: '#c7cede' } };

test('plainColourOf takes the terminal background the look resolved, then the chrome background, then nothing', () => {
  assert.strictEqual(bg.plainColourOf({ terminal: { background: '#ABCDEF' }, chrome: { bg: '#000000' } }), '#abcdef');
  assert.strictEqual(bg.plainColourOf({ terminal: { background: 'rgba(0,0,0,0)' }, chrome: { bg: '#102030' } }), '#102030');
  for (const bad of [null, undefined, {}, { terminal: {}, chrome: {} }, 'x', { terminal: { background: 5 } }]) assert.strictEqual(bg.plainColourOf(bad), null, JSON.stringify(bad));
});

test("Dexter's case: an app colour equal to the CLI's text (#c7cede on #c7cede) is painted readable in Plain colour", () => {
  const themed = applyLook(THEME, { ...DEFAULT_LOOK, appColor: '#c7cede', backgroundMode: 'colour', darkness: 0 });
  const paint = bg.plainColourOf(themed);
  assert.ok(paint, 'there is a colour to paint');
  assert.notStrictEqual(paint, '#c7cede', 'the raw app colour would hide the text (1:1)');
  assert.ok(contrastRatio('#c7cede', paint) >= MIN_CONTRAST, `contrast ${contrastRatio('#c7cede', paint).toFixed(2)}`);
});

test('an app colour that already reads is painted as it is (the guard only moves what would hide the text)', () => {
  assert.strictEqual(bg.plainColourOf(applyLook(THEME, { ...DEFAULT_LOOK, appColor: '#204060' })), '#204060');
});

test('the page paints the colour from plainColourOf and the stylesheet uses it behind #bg', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  assert.match(js, /bgMedia\.plainColourOf\(theme\)/);
  assert.match(js, /setProperty\('--plain-colour'/);
  assert.match(html, /body\.has-plain-colour #bg \{ background-color: var\(--plain-colour, var\(--bg\)\); \}/);
});
