'use strict';
/**
 * PR 1b's wiring in app/renderer.js and app/renderer.html (Extension X1/X4).
 * The decisions are pure and tested in test/worktree-status-display.test.js;
 * these pin that the browser script USES them. Source assertions in the style
 * of test/renderer-context-fill.test.js -- renderer.js cannot be required.
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

const tag = id => {
  const m = new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`).exec(HTML);
  assert.ok(m, `renderer.html must have #${id}`);
  return m[0];
};

test('renderer.html loads the module before renderer.js', () => {
  const a = HTML.indexOf('<script src="./worktree-status-display.js"></script>');
  const b = HTML.indexOf('<script src="./renderer.js"></script>');
  assert.ok(a !== -1 && b !== -1 && a < b);
});

test('the overlay, the banner and the header marks exist, and all start hidden', () => {
  for (const id of ['lock-overlay', 'terminal-banner', 'wt-health', 'wt-lock']) {
    assert.match(tag(id), /\bhidden\b/, `#${id} must start hidden`);
  }
  for (const id of ['lock-overlay-title', 'lock-overlay-detail', 'lock-open-anyway', 'lock-close',
    'terminal-banner-text', 'terminal-banner-dismiss']) tag(id);
});

test('the health and lock marks sit in the header beside the project title', () => {
  const header = HTML.slice(HTML.indexOf('<header>'), HTML.indexOf('</header>'));
  const title = header.indexOf('id="title"');
  assert.ok(title !== -1 && header.indexOf('id="wt-health"') > title && header.indexOf('id="wt-lock"') > title);
});

test('the overlay sits over the terminal, not in the side panel', () => {
  const wrap = HTML.indexOf('<div id="termwrap">');
  const overlay = HTML.indexOf('id="lock-overlay"');
  const roster = HTML.indexOf('<aside id="roster">');
  assert.ok(wrap !== -1 && overlay > wrap && overlay < roster);
});

test('hello paints all three from the handshake', () => {
  const hello = branch('hello');
  assert.match(hello, /renderLock\(msg\.lock\)/);
  assert.match(hello, /renderTerminalSessions\(msg\.terminalSessions\)/);
  assert.match(hello, /renderBranchHealth\(msg\.branchHealth\)/);
});

test('each live message repaints its part', () => {
  assert.match(branch('lock'), /renderLock\(msg\.lock\)/);
  assert.match(branch('terminal-sessions'), /renderTerminalSessions\(msg\)/);
  assert.match(branch('branch-health'), /renderBranchHealth\(msg\.health\)/);
});

test('the paint goes through worktreeStatus, not a second copy of its rules', () => {
  assert.match(fnBody('renderLock'), /worktreeStatus\.lockOverlay\(/);
  assert.match(fnBody('renderLock'), /worktreeStatus\.lockBadge\(/);
  assert.match(fnBody('renderTerminalSessions'), /worktreeStatus\.terminalBanner\(/);
  assert.match(fnBody('renderBranchHealth'), /worktreeStatus\.healthMarker\(/);
});

test('Open anyway sends the lock-override frame, and nothing else does', () => {
  const sends = JS.match(/type: 'lock-override'/g) || [];
  assert.strictEqual(sends.length, 1, 'exactly one place sends lock-override');
  const at = JS.indexOf("type: 'lock-override'");
  const handler = JS.slice(JS.lastIndexOf('lock-open-anyway', at), at);
  assert.ok(handler.length > 0 && handler.length < 400, 'it is the Open anyway button that sends it');
});

test('a dismissed banner stays dismissed only for the same set of sessions', () => {
  const body = fnBody('renderTerminalSessions');
  assert.match(body, /\.key/);
  assert.match(body, /dismissedTerminalKey/);
});

test('Stop that session: its own hidden button sends lock-stop-holder, and nothing else does', () => {
  assert.match(tag('lock-stop'), /\bhidden\b/, '#lock-stop must start hidden');
  const sends = JS.match(/type: 'lock-stop-holder'/g) || [];
  assert.strictEqual(sends.length, 1, 'exactly one place sends lock-stop-holder');
  // The send sits inside the Stop button's own click listener: no other
  // listener is registered between the two (Miguel S6: a structural check,
  // not a character budget).
  const at = JS.indexOf("type: 'lock-stop-holder'");
  const opener = "stopButton.addEventListener('click'";
  const listener = JS.lastIndexOf(opener, at);
  assert.ok(listener !== -1, "the send is in the Stop button's click listener");
  assert.ok(!JS.slice(listener + opener.length, at).includes('addEventListener('), 'and in no other listener');
  assert.match(JS, /const stopButton = document\.getElementById\('lock-stop'\)/);
});

test('Stop takes two clicks: the first warns, the second sends (Dexter F3, Miguel I4)', () => {
  const at = JS.indexOf("stopButton.addEventListener('click'");
  const src = JS.replace(/\r\n/g, '\n');
  const from = src.indexOf("stopButton.addEventListener('click'");
  const handler = src.slice(from, src.indexOf('\n});', from));
  assert.ok(at !== -1 && handler.length > 0);
  const warn = handler.indexOf('worktreeStatus.stopWarning(');
  const sendAt = handler.indexOf("type: 'lock-stop-holder'");
  assert.ok(warn !== -1 && sendAt !== -1 && warn < sendAt, 'the warning comes before the send');
  assert.match(handler.slice(warn, sendAt), /return;/, 'the first click returns after warning');
  assert.match(handler, /stopButton\.disabled = true/, 'disabled while the stop runs (Miguel S3)');
  // The holder the PANE showed goes with it (Dexter F6).
  assert.match(handler, /holder: \{ pid: tabLock\.holder\.pid, startedAt: tabLock\.holder\.startedAt \}/);
});

test('renderLock shows Stop only when the overlay offers it, and a repaint disarms it', () => {
  const body = fnBody('renderLock');
  assert.match(body, /getElementById\('lock-stop'\)\.hidden = !overlay\.canStop/);
  assert.match(body, /disarmStop\(\)/);
});

test("the host's answer -- or its 'busy' -- is shown under the buttons and re-enables Stop", () => {
  const b = branch('lock-note');
  assert.match(b, /lock-goto-note/);
  assert.match(b, /msg\.text/);
  assert.match(b, /disarmStop\(\)/);
});
