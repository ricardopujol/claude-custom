'use strict';
/**
 * The renderer's avatar wiring (BACKLOG C #3, #13, #18), asserted on the SOURCE
 * because app/renderer.js needs a real DOM and cannot be require()d (same
 * reasoning as test/renderer-favourites-wiring.test.js). The behaviour itself
 * is measured in a real window by verify/probe-avatar-roster.js; these pin the
 * lines that probe found necessary, so a refactor cannot quietly drop them.
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');

function body(start) {
  const i = SRC.indexOf(start);
  assert.ok(i !== -1, `renderer.js must still contain ${start}`);
  return SRC.slice(i, SRC.indexOf('\n}', i));
}

test('every roster paint goes through setRosterHtml: nothing else assigns #agents innerHTML', () => {
  const sites = SRC.match(/agentsEl\.innerHTML\s*=/g) || [];
  assert.strictEqual(sites.length, 0, 'only setRosterHtml may replace the roster, via replaceChildren');
  assert.strictEqual((SRC.match(/agentsEl\.replaceChildren/g) || []).length, 1);
});

test('setRosterHtml keeps a live video whose key is unchanged instead of recreating it (Dexter F1)', () => {
  const b = body('function setRosterHtml');
  assert.match(b, /portraitMedia\.planVideoReuse/);
  assert.match(b, /fresh\.replaceWith\(old\)/, 'the live node must replace the staged copy');
  assert.ok(b.indexOf('fresh.replaceWith(old)') < b.indexOf('agentsEl.replaceChildren'),
    'the swap must happen before the roster is replaced, in the same task');
});

test('setRosterHtml unloads only what is still in the old roster AFTER the reuse swap, and BEFORE the replace', () => {
  const b = body('function setRosterHtml');
  const unload = b.indexOf('portraitMedia.unloadVideo');
  assert.ok(unload !== -1, 'old videos must be stopped and unloaded');
  assert.ok(b.indexOf('fresh.replaceWith(old)') < unload, 'reused nodes must have left the old roster first');
  assert.ok(unload < b.indexOf('agentsEl.replaceChildren'), 'unloading after the swap would find nothing to unload');
});

test('setRosterHtml pauses a fresh video at once (a hidden window never delivers an observer callback)', () => {
  const b = body('function setRosterHtml');
  assert.ok(b.indexOf('applyFaceVideo(v)') > b.indexOf('agentsEl.replaceChildren'),
    'without it the autoplay attribute starts every video in a hidden window');
});

test('play/pause is decided by portraitMedia.visibilityAction from the observer AND document visibility', () => {
  const b = body('function applyFaceVideo');
  assert.match(b, /portraitMedia\.visibilityAction\(onScreen, document\.visibilityState === 'visible'\)/);
  assert.match(SRC, /document\.addEventListener\('visibilitychange'/);
  assert.match(SRC, /new IntersectionObserver\([\s\S]*?\{ root: agentsEl \}/, 'observed against the roster scroll container');
});

test('the face pencil sends the same portrait-set message a drop sends, and is not the card click', () => {
  const i = SRC.indexOf("closest('.face-edit')");
  assert.ok(i !== -1, 'a delegated handler for .face-edit must exist');
  const handler = SRC.slice(i, SRC.indexOf('}, true);', i));
  assert.match(handler, /stopImmediatePropagation\(\)/, 'must not also trigger a card click');
  assert.match(handler, /type: 'portrait', action: 'set', agent, state, path/);
  assert.match(handler, /window\.harness\.avatar\.pick\(\)/);
});

test('the pencil is only drawn when the picker bridge exists', () => {
  assert.match(body('function faceEditHtml'), /window\.harness\.avatar/);
});

test('the toggle sends the DESIRED state, never a blind flip inside main', () => {
  assert.match(SRC, /setImagesEnabled\(!agentImagesEnabled\)|setAgentImages\(!agentImagesEnabled\)/);
  assert.match(SRC, /window\.harness\.avatar\.setImagesEnabled\(enabled\)/);
  assert.match(SRC, /window\.harness\.avatar\.onImagesEnabled\(applyAgentImages\)/);
});

test('an unknown toggle loads nothing: it starts null when the bridge exists, true when there is none', () => {
  assert.match(SRC, /let agentImagesEnabled = \(window\.harness && window\.harness\.avatar\) \? null : true;/);
});

test('the roster-tab handlers ignore the images-toggle button that now lives in the same nav', () => {
  const loops = SRC.match(/#roster-subtabs button\[data-roster-tab\]/g) || [];
  assert.strictEqual(loops.length, 2);
  assert.doesNotMatch(SRC, /#roster-subtabs button'\)/);
});

test('the page loads portrait-media-display.js before renderer.js, and has the toggle button', () => {
  assert.ok(HTML.indexOf('portrait-media-display.js') !== -1);
  assert.ok(HTML.indexOf('portrait-media-display.js') < HTML.indexOf('./renderer.js'));
  assert.match(HTML, /id="images-toggle"/);
});

test('the global drop zone stops propagation so a drop does not also type its path into the terminal', () => {
  const b = body('function bindAvatarSection');
  const drop = b.slice(b.indexOf("zone.addEventListener('drop'"));
  assert.match(drop, /e\.stopPropagation\(\)/);
  assert.match(drop, /sendGlobalPortrait\('set-global', path\)/);
});
