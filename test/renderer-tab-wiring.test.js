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
  assert.match(branch('attention'), /pend\('urgent'\)/);
  assert.match(branch('attention'), /reportTabStatus\(\)/);
  assert.match(fnBody('renderLock'), /reportTabStatus\(\)/);
  assert.match(fnBody('renderBranchHealth'), /reportTabStatus\(\)/);
  assert.match(branch('hello'), /reportTabStatus\(\)/);
});

test('only an URGENT attention message marks the tab as needing input', () => {
  assert.match(branch('attention'), /msg\.urgent === true/);
});

test('being selected is a look: the pending flags clear and the page re-reports', () => {
  assert.match(JS, /window\.harness\.onTabSelected\(\(\) => \{ pend\('looked'\); reportTabStatus\(\); \}\)/);
});

test('#31: only urgent === true / === false attention marks the tab; a finished turn answers an urgent one', () => {
  const b = branch('attention');
  assert.match(b, /if \(msg\.urgent === true\) \{ pend\('urgent'\); reportTabStatus\(\); \}/);
  assert.match(b, /else if \(msg\.urgent === false\) \{ pend\('finished'\); reportTabStatus\(\); \}/);
  assert.match(fnBody('reportTabStatus'), /pendingUrgent: tabPending\.urgent/);
  assert.match(fnBody('reportTabStatus'), /pendingFinished: tabPending\.finished/);
  assert.match(fnBody('pend'), /window\.tabStatus\.pendingAfter\(tabPending, event\)/);
});

test('#31 (Dexter F5): a turn STARTING (not a session still working) ends a pending finished', () => {
  const body = fnBody('reportTabStatus');
  assert.match(body, /if \(anyWorking && !wasWorking\) pend\('working'\);\s*wasWorking = anyWorking;/);
});



test('the shell\'s override menu item clicks the Open anyway button: one switch, not two', () => {
  assert.match(JS, /window\.harness\.onLockOverride\(\(\) => document\.getElementById\('lock-open-anyway'\)\.click\(\)\)/);
});

test('the preload exposes exactly the tab bridge on the tab:* channels, replace-don\'t-accumulate', () => {
  const p = strip(PRELOAD);
  assert.match(p, /tabStatus: \(status\) => ipcRenderer\.send\('tab:status', status\)/);
  assert.match(p, /closeTab: \(\) => ipcRenderer\.send\('tab:close'\)/);
  assert.match(p, /goToSession: \(holder\) => ipcRenderer\.invoke\('tab:goTo', holder\)/);
  // the Git panel's *Jump to its tab* (documentation/PLAN_GIT_TREE.md Task 10)
  assert.match(p, /selectFolder: \(folder\) => ipcRenderer\.invoke\('tab:selectFolder', folder\)/);
  // the Git drawer's tab states and *Type /merged* (Enhancement #46)
  assert.match(p, /tabStates: \(folders\) => ipcRenderer\.invoke\('tab:states', folders\)/);
  assert.match(p, /typeMerged: \(folder, branch\) => ipcRenderer\.invoke\('tab:typeMerged', folder, branch\)/);
  assert.match(p, /raise: \(\) => ipcRenderer\.send\('tab:raise'\)/);
  // PR #93 Dexter F3: main asks THIS page to type a command into its own box, and hears back
  assert.match(p, /onTypeCommand: \(fn\) => \(ipcRenderer\.removeAllListeners\('type-command'\)/);
  assert.match(p, /typed: \(reply\) => ipcRenderer\.send\('tab:typed', reply\)/);
  assert.match(p, /onTabSelected: \(fn\) => \(ipcRenderer\.removeAllListeners\('tab-selected'\)/);
  assert.match(p, /onLockOverride: \(fn\) => \(ipcRenderer\.removeAllListeners\('lock-override'\)/);
});

// --- fix/terminal-links (2026-10-01) ------------------------------------------------

test('a link clicked in the terminal goes to main through the bridge: no confirm, no window.open', () => {
  const opts = JS.slice(JS.indexOf('const term = new Terminal({'), JS.indexOf('\n});', JS.indexOf('const term = new Terminal({')));
  assert.match(opts, /linkHandler: \{/, 'xterm\'s default handler confirm()s, then window.open()s a blank page');
  assert.match(opts, /activate: \(event, uri\) => openTerminalLink\(event, uri\)/);
  const body = fnBody('openTerminalLink');
  assert.match(body, /window\.harness\.openExternal\(uri\)/);
  assert.doesNotMatch(body, /confirm\(|window\.open\(/);
});

test('PR #81 Dexter F2: only a single left click opens it, once (through linkClick.shouldOpen)', () => {
  const body = fnBody('openTerminalLink');
  assert.match(body, /linkClick\.shouldOpen\(event, uri, lastLinkOpened, Date\.now\(\)\)/);
  assert.match(body, /lastLinkOpened = r\.last;/);
  assert.match(body, /if \(!r\.open/);
});

test('PR #81 Dexter F1 (Ricardo: plain click + show target): hovering a link shows where it really goes', () => {
  const opts = JS.slice(JS.indexOf('const term = new Terminal({'), JS.indexOf('\n});', JS.indexOf('const term = new Terminal({')));
  assert.match(opts, /hover: \(_event, uri\) => showLinkTarget\(linkClick\.targetText\(uri\)\)/);
  assert.match(opts, /leave: \(\) => showLinkTarget\(null\)/);
  const show = fnBody('showLinkTarget');
  assert.match(show, /textContent = /, 'a URL is text, never markup');
  assert.doesNotMatch(show, /innerHTML/);
  assert.match(HTML, /<div id="link-target"[^>]*\bhidden\b/);
});

test('PR #81 Dexter F5: a link main refused says so, instead of doing nothing visible', () => {
  const body = fnBody('openTerminalLink');
  assert.match(body, /opened === false\) flashLinkTarget\(linkClick\.refusedText\(uri\)\)/);
});

test('renderer.html loads link-click.js before renderer.js', () => {
  const a = HTML.indexOf('<script src="./link-click.js"></script>');
  const b = HTML.indexOf('<script src="./renderer.js"></script>');
  assert.ok(a !== -1 && b > a);
});

test('the bridge asks main to open a link, and hears whether it did', () => {
  assert.match(strip(PRELOAD), /openExternal: \(url\) => ipcRenderer\.invoke\('tab:openExternal', url\)/);
});

// --- PR #93 Dexter F3 / Miguel I2: Type /merged types through the target page, the top bar's way ------------

test('a command main asks this page to type goes through typeCommand, and its answer goes back to main', () => {
  assert.match(JS, /window\.harness\.onTypeCommand\(/);
  const body = fnBody('typeCommand');
  assert.match(body, /planTyping\(\{/, 'the screen is judged first: a dialog, a multi-line draft or no box gets nothing typed');
  assert.match(body, /typeAndCheck\(/);
});

test('typeAndCheck clears the line, types, and reads the box back: one copy for the top bar and Type /merged', () => {
  const body = fnBody('typeAndCheck');
  assert.match(body, /commandTyped\(screenLines\(\), command/);
  assert.match(body, /typingKeys\(command, enterInsert\)/);
  assert.match(fnBody('typePlanned'), /typeAndCheck\(/, 'the top bar types the same way');
  assert.match(fnBody('requestSwitch'), /typePlanned\(/, 'the top bar types the same way');
  assert.doesNotMatch(fnBody('requestSwitch'), /input\('\\x15'\)/, 'no second copy of the key sequence');
});

// --- PR #93 Dexter R2-1: Type /merged never presses Enter ------------------------------------------------

test('the Type /merged path in the page types and reads back, and contains no Enter at all', () => {
  const page = fnBody('typeCommand');
  const typing = fnBody('typeAndCheck');
  const handler = JS.slice(JS.indexOf('window.harness.onTypeCommand('), JS.indexOf('});', JS.indexOf('window.harness.onTypeCommand(')));
  for (const [name, body] of [['typeCommand', page], ['typeAndCheck', typing], ['the onTypeCommand handler', handler]]) {
    // the source text of a CR in any spelling (the file's own CRLF line ends are real CRs, not this)
    assert.doesNotMatch(body, /\\r|\\x0d|\\u000d|\\015|typePlanned\(/i, `${name} must never press Enter`);
  }
  assert.match(page, /typeAndCheck\(/);
  assert.match(page, /term\.focus\(\)/, "the terminal is focused, so the person's Enter lands there");
  assert.match(typing, /commandTyped\(screenLines\(\), command/, 'the box is still read back');
});

test("only the top bar's own switch presses Enter, after typeAndCheck's read-back", () => {
  const enter = fnBody('typePlanned');
  assert.match(enter, /typeAndCheck\(enterInsert, command, \(r\) => \{\s*if \(r\.ok\) input\('\\r'\);/);
  assert.match(fnBody('requestSwitch'), /typePlanned\(/);
});

test('#37: the bridge asks main which paths exist, and asks it to open one', () => {
  assert.match(strip(PRELOAD), /checkPaths: \(lists\) => ipcRenderer\.invoke\('tab:checkPaths', lists\)/);
  assert.match(strip(PRELOAD), /openPath: \(p\) => ipcRenderer\.invoke\('tab:openPath', p\)/);
});

test('#37: a file-link provider asks main, and a click goes through shouldOpen then openPath', () => {
  const order = (name) => HTML.indexOf(`<script src="./${name}"></script>`);
  for (const f of ['terminal-rows.js', 'file-path-parse.js']) {
    assert.ok(order(f) !== -1 && order(f) < order('renderer.js'), `${f} loads before renderer.js`);
  }
  const s = strip(JS);
  assert.match(s, /term\.registerLinkProvider\(/);
  assert.match(s, /window\.harness\.checkPaths\(/);
  assert.match(s, /terminalRows\.block\(bufferRow, /);
  assert.match(s, /filePathParse\.pickLinks\(/);
  const body = fnBody('openFileLink');
  assert.match(body, /linkClick\.shouldOpen\(event, `file:\$\{p\}`, lastLinkOpened, Date\.now\(\)\)/);
  assert.match(body, /window\.harness\.openPath\(p\)/);
  assert.match(body, /flashLinkTarget\(linkClick\.fileRefusedText\(/);
  assert.match(strip(fnBody('toXtermLink')), /showLinkTarget\(linkClick\.fileTargetText\(/);
  // PR #92 Miguel I2/I5: only the hovered row's candidates, and the range math is the tested one.
  assert.match(s, /filePathParse\.findCandidates\(b\.text, b\.breaks, \{ within: terminalRows\.rowSpan\(b, lineNumber - 1\) \}\)/);
  assert.match(strip(fnBody('toXtermLink')), /const range = terminalRows\.linkRange\(b, start, end\);/);
  // Miguel S4: a throw on a hover answers "no links", never an unhandled error.
  assert.match(s, /provideLinks\(lineNumber, callback\) \{\s*try \{/);
});
