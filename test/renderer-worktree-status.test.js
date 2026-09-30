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
