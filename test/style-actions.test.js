'use strict';
/**
 * Every Style-tab action the renderer sends has a handler in the host
 * (Miguel, PR #54 #1).
 *
 * The host's `style` branch ends in a bare `return` for an action it doesn't
 * know, so a renderer button whose action the host never learned does NOTHING
 * -- no refusal, no log, and every unit test passes, because the modules are
 * fine and only the wiring is missing. Same shape as control.test.js's "every
 * type host.js dispatches is on the control allow-list".
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const RENDERER = read('app', 'renderer.js');
const HOST = read('host', 'host.js');

function sentActions() {
  return new Set([...RENDERER.matchAll(/sendStyle\([^)]*?action: '([a-z-]+)'/g)].map((m) => m[1]));
}

function handledActions() {
  const start = HOST.indexOf("if (msg.type === 'style')");
  assert.ok(start !== -1, "host.js must have a 'style' branch for this check to mean anything");
  return new Set([...HOST.slice(start).matchAll(/msg\.action === '([a-z-]+)'/g)].map((m) => m[1]));
}

test('every style action the renderer sends is handled by the host', () => {
  const sent = sentActions();
  assert.ok(sent.size >= 4, `the scan found the renderer's actions: ${[...sent]}`);
  const handled = handledActions();
  const orphans = [...sent].filter((a) => !handled.has(a));
  assert.deepStrictEqual(orphans, [], `sent but never handled: ${orphans.join(', ')}`);
});

test('the "Random colours" button is drawn and sends reroll-look', () => {
  assert.match(RENDERER, /<button type="button" id="style-reroll"[^>]*>Random colours<\/button>/);
  assert.match(RENDERER,
    /getElementById\('style-reroll'\)[\s\S]{0,200}sendStyle\('colours', \{ action: 'reroll-look' \}\)/);
  assert.ok(sentActions().has('reroll-look'));
});
