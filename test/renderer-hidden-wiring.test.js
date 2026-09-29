'use strict';
/**
 * BACKLOG #14 wiring pins. app/renderer.js needs a real DOM, so these are
 * SOURCE assertions (same reasoning as test/renderer-dispatch.test.js) and
 * repo-scanning, so deliberately not in Stryker's command. They pin the joints
 * a unit test of the pure module cannot see; the real check is the hand-check
 * in the PR.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const SRC = read('app', 'renderer.js');
const HTML = read('app', 'renderer.html');

test('the display module loads as a script, after roster-tabs-display', () => {
  const a = HTML.indexOf('./roster-tabs-display.js');
  const b = HTML.indexOf('./hidden-agents-display.js');
  assert.ok(a !== -1 && b > a);
});

test('the persisted set arrives in hello and is replaced by hidden frames', () => {
  assert.match(SRC, /hiddenAgentNames = Array\.isArray\(msg\.hidden\) \? msg\.hidden : \[\]/g);
  assert.match(SRC, /msg\.type === 'hidden'/);
  assert.match(read('host', 'host.js'), /hidden: hiddenAtAttach\(\),/);
});

test('the hide button is its own element, never inside .face and never a card click', () => {
  const html = SRC.slice(SRC.indexOf('function hideButtonHtml'), SRC.indexOf('function hideButtonHtml') + 700);
  assert.match(html, /<button type="button" class="agent-hide"/);
  const card = SRC.slice(SRC.indexOf("paintAgents(shown.map"), SRC.indexOf("paintAgents(shown.map") + 500);
  // the button is emitted before the face div, i.e. a sibling of it, not a child
  assert.ok(card.indexOf('hideButtonHtml(r)') < card.indexOf('<div class="face"'));
  assert.doesNotMatch(SRC, /\.agent'\)\.addEventListener\('click'/);
});

test('a click sends a roster control frame and the type is on the allow-list', () => {
  assert.match(SRC, /JSON\.stringify\(\{ type: 'roster', action, agent \}\)/);
  assert.ok(require('../host/control').CONTROL_TYPES.has('roster'));
});

test('Dexter F1: #agents markup is written in exactly one place, behind repaintNeeded', () => {
  const writes = SRC.match(/agentsEl\.innerHTML\s*=/g) || [];
  assert.strictEqual(writes.length, 1, 'every roster paint must go through paintAgents');
  const fn = SRC.slice(SRC.indexOf('function paintAgents'), SRC.indexOf('function paintAgents') + 200);
  assert.match(fn, /repaintNeeded\(lastAgentsHtml, html\)[\s\S]*agentsEl\.innerHTML = html/);
});

test('Dexter F5: the click handler asks rosterActionFromClick and sends what it returns', () => {
  const i = SRC.indexOf("agentsEl.addEventListener('click'");
  assert.ok(i !== -1);
  const body = SRC.slice(i, i + 250);
  assert.match(body, /rosterActionFromClick\(e\.target\)/);
  assert.match(body, /sendRosterAction\(act\.action, act\.agent\)/);
});

test('the toggle only ever shows on the Active tab', () => {
  assert.match(SRC, /showBtnEl\.hidden = true;/);
  assert.match(SRC, /showBtnEl\.hidden = nHidden === 0;/);
});
