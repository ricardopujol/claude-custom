'use strict';
/**
 * BACKLOG #11 (clickable choice menus) works because the CLI turns on mouse
 * tracking and xterm.js forwards clicks to it as SGR reports; the CLI selects
 * the row itself (verify/probe-choice-menu.js). Nothing was built for it, so
 * the only way to lose it is for renderer.js to start eating mouse events
 * before xterm sees them.
 *
 * SOURCE assertions, same reasoning as test/renderer-dispatch.test.js:
 * app/renderer.js needs a real DOM. Repo-scanning, so deliberately NOT in
 * Stryker's command. A pin, not proof: the real check is the hand-check in
 * the PR that added this.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const MOUSE_EVENT = String.raw`['"](?:mouse|pointer|click|dblclick|auxclick|contextmenu|wheel)\w*['"]`;

test('no mouse/pointer listener is registered in the CAPTURE phase', () => {
  // A capture listener on document or window runs BEFORE xterm's own handler,
  // so a stopPropagation there would silently kill every click report.
  const re = new RegExp(String.raw`addEventListener\(\s*${MOUSE_EVENT}\s*,[\s\S]*?\}\s*,\s*(?:true|\{[^}]*capture\s*:\s*true)`, 'g');
  const hits = [];
  for (const m of SRC.matchAll(re)) {
    // The lazy span can run past the end of its own call into a later
    // capture-phase keydown listener; only count it if no other
    // addEventListener starts inside the match.
    if ((m[0].match(/addEventListener\(/g) || []).length === 1) hits.push(m[0].slice(0, 60));
  }
  assert.deepStrictEqual(hits, [], 'a capture-phase mouse listener can starve xterm of clicks');
});

test('renderer.js never binds mouse handlers on the xterm element or its container', () => {
  assert.doesNotMatch(SRC, /\bterm\.element\.addEventListener\(\s*['"](?:mouse|pointer|click|wheel)/,
    'term.element is xterm; a handler there that stops propagation eats the click');
  assert.doesNotMatch(SRC, /getElementById\(\s*['"]terminal['"]\s*\)\.addEventListener\(\s*['"](?:mouse|pointer|click|wheel)/,
    'the terminal container must be left to xterm');
});

test('no handler on a mouse event calls stopPropagation or stopImmediatePropagation', () => {
  const offenders = [];
  const re = new RegExp(String.raw`addEventListener\(\s*(${MOUSE_EVENT})\s*,`, 'g');
  for (const m of SRC.matchAll(re)) {
    const body = SRC.slice(m.index, m.index + 600);
    const next = body.indexOf('addEventListener(', 20);
    const own = next === -1 ? body : body.slice(0, next);
    if (/stop(?:Immediate)?Propagation\(/.test(own)) offenders.push(m[1]);
  }
  assert.deepStrictEqual(offenders, []);
});

test('the terminal is never told to swallow mouse tracking', () => {
  assert.doesNotMatch(SRC, /mouseTrackingMode|disableStdin|\?100[0-6][lh]/,
    'xterm must be left to honour the CLI\'s mouse-tracking request');
});
