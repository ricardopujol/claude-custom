'use strict';
/**
 * A rail's names are fitted only while the rail is on screen (app/dock-tree-display.js fitRailNames), so whatever hides the rails
 * must also draw the dock again when they come back, or a rail that lost its fit while hidden keeps 11 px names (#179 Dexter r2 F1,
 * r3). Source assertions in the style of test/renderer-games-wiring.test.js: renderer.js needs a real DOM.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const RENDERER = strip(fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8'));

const bodyOf = (name) => {
  const at = RENDERER.indexOf(`function ${name}(`);
  assert.ok(at !== -1, `${name} exists`);
  const open = RENDERER.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < RENDERER.length; i++) {
    if (RENDERER[i] === '{') depth++;
    else if (RENDERER[i] === '}' && --depth === 0) return RENDERER.slice(open, i + 1);
  }
  throw new Error(`${name} never closes`);
};

test('a focus-mode change draws the dock again, so the rails that were hidden are fitted when they show', () => {
  assert.match(bodyOf('applyFocusMode'), /\brenderLayout\(\)/);
});

test('a page that becomes visible fits its rails again (a background tab misses the focus-mode push)', () => {
  assert.match(RENDERER, /addEventListener\('visibilitychange'[\s\S]{0,200}?refitRails/);
});
