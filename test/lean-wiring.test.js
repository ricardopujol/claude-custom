'use strict';
/**
 * Lean mode's wiring (BACKLOG #62), read from the source like test/renderer-dock-wiring.test.js: the pieces are tested
 * on their own (lean-state, lean-bridge, lean-display); these pin that they are CONNECTED, which no unit test sees and
 * only a real window proves (verify/probe-lean.js does).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const MAIN = strip(read('app/main.js'));
const PRELOAD = strip(read('app/preload.js'));
const RENDERER = strip(read('app/renderer.js'));
const HTML = read('app/renderer.html');

test('main registers the lean handlers for tab views and the strip, and pushes to both', () => {
  assert.match(MAIN, /registerLeanHandlers\(\{[\s\S]*?isView: isTabView[\s\S]*?isStrip: \(sender\) => fromStrip\(\{ sender \}\)/);
  assert.match(MAIN, /pushToViews\(LEAN_PUSH, state\)/);
  assert.match(MAIN, /win\.webContents\.send\(LEAN_PUSH, state\)/);
});

test('main re-sends a lean state to a page that loads (or reloads) while the window is lean', () => {
  assert.match(MAIN, /wc\.send\(LEAN_PUSH, leanBridge\.view\(\)\)/);
  assert.match(MAIN, /win\.webContents\.send\(LEAN_PUSH, leanBridge\.view\(\)\)/);
});

test('a tab view going away drops its night by the id taken when it was made, even if the webContents is already destroyed (Miguel M2)', () => {
  assert.match(MAIN, /view\.leanOwnerId = leanOwnerId/);
  assert.match(MAIN, /wc\.once\('destroyed', \(\) => \{ if \(leanBridge\) leanBridge\.dropOwner\(leanOwnerId\); \}\)/);
  const drop = MAIN.slice(MAIN.indexOf('function destroyTabView'), MAIN.indexOf('// --- pushing the model out'));
  assert.match(drop, /leanBridge\.dropOwner\(view\.leanOwnerId\)/);
  assert.doesNotMatch(drop, /isDestroyed\(\)\) leanBridge/, 'the drop is not behind an isDestroyed guard');
});

test('the nights sent Back to normal are kept across a restart in the install-wide record (Dexter F2)', () => {
  assert.match(MAIN, /createLean\(\{\s*dismissed: Array\.isArray\(leanKept\) \? leanKept : \[\]/);
  assert.match(MAIN, /leanDismissed: unionDismissed\(/);
});

test('the tab preload exposes lean get / set / night / onChange on the channels main answers', () => {
  for (const ch of ['lean:get', 'lean:set', 'lean:night', 'lean-state']) assert.ok(PRELOAD.includes(`'${ch}'`), ch);
  assert.match(PRELOAD, /lean:\s*\{[\s\S]*get:[\s\S]*set:[\s\S]*night:[\s\S]*onChange:/);
});

test('the dock shows no panel while lean except LEAN_KEEPS (Schedules): renderLayout takes leanShown, so every other panel\'s hide effect runs', () => {
  assert.match(RENDERER, /const now = leanDisplay\.leanShown\(plan\.shown, leanOn\)/);
});

test('lean\'s unmount and remount are QUIET and leave the keyboard with the terminal, never the vault (Dexter F1)', () => {
  assert.match(RENDERER, /renderEffects\(shownModules, now, \{ userAction, quiet \}\)/);
  assert.match(RENDERER, /leanSuspender\.register\('dock', \{ suspend: \(\) => renderLayout\(\{ quiet: true \}\), resume: \(\) => renderLayout\(\{ quiet: true \}\) \}\)/);
  const apply = RENDERER.slice(RENDERER.indexOf('function applyLean'), RENDERER.indexOf('if (leanBridge) {'));
  assert.match(apply, /leanSuspender\.set\(on\)[\s\S]*term\.focus\(\);\s*\}/);
  assert.doesNotMatch(apply, /if \(on\) term\.focus/);
});

test('Ctrl+B while lean folds nothing (Dexter F6)', () => {
  assert.match(RENDERER, /if \(focusOn && focusBridge\) focusBridge\.set\(false\); else if \(!leanOn\) toggleAllZones\(\);/);
});

test('the cooldown countdown runs on resume, through the shared step (Dexter F7)', () => {
  assert.match(RENDERER, /cooldownState = leanDisplay\.advanceCooldowns\(cooldownState, Date\.now\(\)\)/);
  assert.match(RENDERER, /resume: \(\) => \{ paintBar\(\); if \(lastQuotaPayload\) renderQuota\(\); stepCooldowns\(\); renderCooldowns\(\); \}/);
});

test('the host is told when the window is lean, and again after a reattach, so its summary job can wait (Dexter F5)', () => {
  assert.match(RENDERER, /leanSuspender\.register\('summary-job', \{ suspend: tellHostLean, resume: tellHostLean \}\)/);
  assert.match(RENDERER, /JSON\.stringify\(\{ type: 'lean', on: leanOn \}\)/);
  assert.match(RENDERER, /applyBedtime\(msg\.bedtime\);\s*if \(leanOn\) tellHostLean\(\);/);
});

test('the roster panel\'s face videos are unloaded while lean, not merely hidden (Miguel S5)', () => {
  const pair = RENDERER.slice(RENDERER.indexOf("leanSuspender.register('roster'"), RENDERER.indexOf("leanSuspender.register('summary-job'"));
  assert.match(pair, /paintAgents\(''\)/, 'the one path that replaces the roster (setRosterHtml), which also unloads its videos');
});

test('the page no longer draws portraits over the terminal: the working agents go to main for the strip (option C)', () => {
  assert.doesNotMatch(RENDERER, /lean-faces|paintStillCanvas|paintStillFromVideo|stillFaceHtml/);
  assert.match(RENDERER, /leanBridge\.faces\(list\)/);
  assert.match(RENDERER, /leanDisplay\.workingFaces\(\[\.\.\.roster\.values\(\)\], \{ limit: 24 \}\)/);
  assert.match(RENDERER, /const list = leanOn\s*\?/, 'not lean: an empty list');
  assert.doesNotMatch(HTML, /id="lean-faces"|\.lean-face/);
});

test('a night is reported to main only on the host\'s word: a dropped socket does not end it', () => {
  assert.match(RENDERER, /applyBedtime\(null, \{ fromHost: false \}\)/);
  assert.match(RENDERER, /if \(fromHost\) reportLeanNight\(\)/);
  assert.match(RENDERER, /window\.harness\.lean\.night\(at\)/);
});

test('the minute-ticks skip while lean, so nothing polls for a hidden header', () => {
  assert.match(RENDERER, /if \(!leanOn && \(bar\.prompt/);
  assert.match(RENDERER, /setInterval\(\(\) => \{ if \(!leanOn\) stepCooldowns\(\); \}, 15000\)/);
  assert.match(RENDERER, /if \(!leanOn && lastQuotaPayload\) renderQuota\(\)/);
});

test('the roster panel is not drawn while lean; the working agents go to the still strip', () => {
  assert.match(RENDERER, /function renderRoster\(\) \{[^}]*if \(leanOn\) \{ paintLeanFaces\(\); return; \}/s);
});

test('the terminal renderer swap and the background stills are registered pairs, and every pair is resumed by one registry', () => {
  for (const name of ['dock', 'ticks', 'roster', 'terminal-renderer', 'background']) {
    assert.match(RENDERER, new RegExp(`leanSuspender\\.register\\('${name}'`), name);
  }
  assert.match(RENDERER, /leanSuspender\.set\(on\)/);
  assert.match(RENDERER, /lean: leanOn,/, 'the video play rule is fed lean');
});

test('applyBackground never sets a CSS background itself: the image goes through paintBackgroundImage (a first frame while lean) (Miguel S6)', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function applyBackground('), RENDERER.indexOf('function clearBackgroundStill'));
  assert.ok(fn.length > 200, 'the slice found the function');
  assert.ok(!fn.includes('backgroundImage'), 'applyBackground does not touch backgroundImage');
  assert.match(fn, /paintBackgroundImage\(media\.url\)/);
  assert.match(RENDERER, /leanDisplay\.mayAnimate\(url\)/);
});

test('the page keeps the terminal and the strip\'s marks: lean hides panels and chrome, never the terminal, the background or the theme', () => {
  const rules = HTML.match(/body\.lean [^{]*\{[^}]*\}/g).join('\n');
  assert.match(rules, /body\.lean header/);
  assert.match(rules, /body\.lean \.zone/);
  assert.doesNotMatch(rules, /body\.lean #termwrap\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(rules, /#bg\b/);
  assert.match(HTML, /<script src="\.\/lean-display\.js"><\/script>/);
  assert.ok(HTML.indexOf('lean-display.js') < HTML.indexOf('src="./renderer.js"'));
});

test('Dexter N3: main writes the union of the stored list and its own', () => {
  assert.match(MAIN, /leanDismissed: unionDismissed\(prev && prev\.leanDismissed, list\)/);
});

test('Dexter N1: the host is told about lean ONLY when its hello lists the type (an older host would type the frame into the session)', () => {
  assert.match(RENDERER, /hostControls = Array\.isArray\(msg\.controls\) \? msg\.controls : \[\]/);
  const lf = RENDERER.replace(/\r\n/g, '\n');
  const at = lf.indexOf('function tellHostLean()');
  const fn = lf.slice(at, lf.indexOf('\n}\n', at) + 2);
  const send = (hostControls, open) => {
    const sent = [];
    const ws = { readyState: 1, send: (d) => sent.push(d) };
    new Function('ws', 'WebSocket', 'leanDisplay', 'hostControls', 'leanOn', fn + '; tellHostLean();')(
      open ? ws : null, { OPEN: 1 }, require('../app/lean-display'), hostControls, true);
    return sent;
  };
  assert.deepStrictEqual(send(['resize', 'input'], true), [], 'a hello without lean: nothing is sent');
  assert.deepStrictEqual(send(null, true), [], 'no hello yet: nothing is sent');
  assert.deepStrictEqual(send(['resize', 'lean'], true), ['{"type":"lean","on":true}']);
  assert.deepStrictEqual(send(['lean'], false), [], 'a closed socket sends nothing');
  // the hello's own re-send comes after it has read the controls
  const hello = RENDERER.indexOf('hostControls = Array.isArray(msg.controls)');
  assert.ok(hello !== -1 && hello < RENDERER.indexOf('if (leanOn) tellHostLean();'));
});

test('Dexter N2: the still background is drawn into a real destination box sized by stillSize, not at a default size', () => {
  assert.match(RENDERER, /leanDisplay\.stillSize\(img\.naturalWidth, img\.naturalHeight, window\.innerWidth, window\.innerHeight, /);
  assert.match(RENDERER, /drawImage\(img, 0, 0, c\.width, c\.height\)/);
});

test('Ricardo\'s video rule: the video and image layers are fed leanHeld() (lean, and not focused-with-no-night), and focus and night changes re-decide it', () => {
  assert.match(RENDERER, /lean: leanHeld\(\),/);
  assert.match(RENDERER, /leanDisplay\.holdStill\(\{ lean: leanOn, focused: windowFocused, night: leanNight \}\)/);
  assert.match(RENDERER, /bgImageHeld = leanHeld\(\) && leanDisplay\.mayAnimate\(url\)/);
  assert.match(RENDERER, /if \(token !== bgStillToken \|\| !leanHeld\(\)\) return;/);
  // a focus change re-decides, from main's own word
  assert.match(RENDERER, /windowFocused = focused === true;\s*syncLeanMotion\(\);/);
  // a night change with lean unchanged re-decides too
  assert.match(RENDERER, /if \(on === leanOn\) \{ if \(nightChanged\) syncLeanMotion\(\); return; \}/);
  assert.match(RENDERER, /leanSuspender\.register\('background', \{ suspend: syncLeanMotion, resume: syncLeanMotion \}\)/);
});

test('the lean portraits strip stays still whatever the focus or night (the rule is for backgrounds)', () => {
  const faces = RENDERER.slice(RENDERER.indexOf('function paintLeanFaces'), RENDERER.indexOf('function applyLean'));
  assert.ok(faces.length > 100);
  assert.doesNotMatch(faces, /leanHeld|windowFocused|leanNight/);
});

test('Dexter r3 #1: a crashed renderer drops its lean owner (night and faces) like a closed view does', () => {
  const at = MAIN.indexOf("wc.on('render-process-gone'");
  assert.ok(at !== -1);
  const handler = MAIN.slice(at, MAIN.indexOf('});', at));
  assert.match(handler, /leanBridge\.dropOwner\(leanOwnerId\)/);
});
