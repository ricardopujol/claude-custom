'use strict';
/**
 * PR 2 (worktree tabs): the wiring in app/renderer.js, app/renderer.html and
 * app/preload.js. The decisions are pure and tested elsewhere
 * (tab-status.test.js, worktree-status-display.test.js, go-to-session.test.js);
 * these pin that the browser script USES them. Source assertions in the style
 * of test/renderer-worktree-status.test.js -- renderer.js cannot be required.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const JS = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(APP, 'preload.js'), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

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

test('renderer.html loads tab-status.js before renderer.js, after the worktree display', () => {
  const a = HTML.indexOf('<script src="./worktree-status-display.js"></script>');
  const b = HTML.indexOf('<script src="./tab-status.js"></script>');
  const c = HTML.indexOf('<script src="./renderer.js"></script>');
  assert.ok(a !== -1 && b > a && c > b);
});

test('the page learns where it lives from the tabmode query and hands it to the overlay', () => {
  assert.match(JS, /const TABMODE = params\.get\('tabmode'\) \|\| ''/);
  assert.match(fnBody('renderLock'), /worktreeStatus\.lockOverlay\(lock, Date\.now\(\), \{ tabmode: TABMODE \}\)/);
});

test('the blocked pane paints Go to that session from canGoTo and the close button from closeLabel', () => {
  const body = fnBody('renderLock');
  assert.match(body, /overlay\.canGoTo/);
  assert.match(body, /overlay\.closeLabel/);
  assert.match(HTML, /id="lock-go-to"[^>]*\bhidden\b/, 'Go to that session starts hidden');
  assert.match(HTML, /id="lock-goto-note"/);
});

test('the close button ends the TAB through the bridge; window.close() is only the no-bridge fallback', () => {
  const src = strip(JS);
  assert.doesNotMatch(src, /'lock-close'\)\.addEventListener\('click', \(\) => window\.close\(\)\)/);
  const at = src.indexOf("getElementById('lock-close').addEventListener");
  const handler = src.slice(at, src.indexOf('});', at));
  assert.match(handler, /window\.harness\.closeTab\(\)/);
  assert.match(handler, /else window\.close\(\)/);
});

test('Go to that session sends the lock\'s holder to main and shows an explanation', () => {
  const src = strip(JS);
  const at = src.indexOf("getElementById('lock-go-to').addEventListener");
  assert.ok(at !== -1);
  const handler = src.slice(at, src.indexOf('\n});', at));
  assert.match(handler, /window\.harness\.goToSession\(tabLock\.holder\)/);
  assert.match(handler, /r\.kind === 'explain'/);
  assert.match(handler, /lock-goto-note/);
});

test('a host raise goes to main; only the bridge decides what raising means', () => {
  assert.match(branch('raise'), /window\.harness\.raise\(\)/);
});

test('the status goes through tab-status.js and is deduplicated with sameStatus', () => {
  const body = fnBody('reportTabStatus');
  assert.match(body, /window\.tabStatus\.tabStatus\(/);
  assert.match(body, /healthMarker: worktreeStatus\.healthMarker/);
  assert.match(body, /window\.tabStatus\.sameStatus\(lastReportedTabStatus, status\)/);
  assert.match(body, /window\.harness\.tabStatus\(status\)/);
});

test('every input of the status reports it: mood, attention, the lock and the health', () => {
  assert.match(branch('mood'), /reportTabStatus\(\)/);
  assert.match(branch('attention'), /tabPendingUrgent = true/);
  assert.match(branch('attention'), /reportTabStatus\(\)/);
  assert.match(fnBody('renderLock'), /reportTabStatus\(\)/);
  assert.match(fnBody('renderBranchHealth'), /reportTabStatus\(\)/);
  assert.match(branch('hello'), /reportTabStatus\(\)/);
});

test('only an URGENT attention message marks the tab as needing input', () => {
  assert.match(branch('attention'), /msg\.urgent === true/);
});

test('being selected clears the pending flag and re-reports', () => {
  assert.match(JS, /window\.harness\.onTabSelected\(\(\) => \{ tabPendingUrgent = false; reportTabStatus\(\); \}\)/);
});

test('the shell\'s override menu item clicks the Open anyway button: one switch, not two', () => {
  assert.match(JS, /window\.harness\.onLockOverride\(\(\) => document\.getElementById\('lock-open-anyway'\)\.click\(\)\)/);
});

test('the preload exposes exactly the tab bridge on the tab:* channels, replace-don\'t-accumulate', () => {
  const p = strip(PRELOAD);
  assert.match(p, /tabStatus: \(status\) => ipcRenderer\.send\('tab:status', status\)/);
  assert.match(p, /closeTab: \(\) => ipcRenderer\.send\('tab:close'\)/);
  assert.match(p, /goToSession: \(holder\) => ipcRenderer\.invoke\('tab:goTo', holder\)/);
  assert.match(p, /raise: \(\) => ipcRenderer\.send\('tab:raise'\)/);
  assert.match(p, /onTabSelected: \(fn\) => \(ipcRenderer\.removeAllListeners\('tab-selected'\)/);
  assert.match(p, /onLockOverride: \(fn\) => \(ipcRenderer\.removeAllListeners\('lock-override'\)/);
});

// --- fix/terminal-links (2026-10-01) ------------------------------------------------

test('a link clicked in the terminal goes to main through the bridge: no confirm, no window.open', () => {
  const opts = JS.slice(JS.indexOf('const term = new Terminal({'), JS.indexOf('\n});', JS.indexOf('const term = new Terminal({')));
  assert.match(opts, /linkHandler: \{/, 'xterm\'s default handler confirm()s, then window.open()s a blank page');
  assert.match(opts, /activate: \(_event, uri\) => openTerminalLink\(uri\)/);
  const body = fnBody('openTerminalLink');
  assert.match(body, /window\.harness\.openExternal\(uri\)/);
  assert.doesNotMatch(body, /confirm\(|window\.open\(/);
});

test('the bridge sends a link to main on its own channel', () => {
  assert.match(strip(PRELOAD), /openExternal: \(url\) => ipcRenderer\.send\('tab:openExternal', url\)/);
});
