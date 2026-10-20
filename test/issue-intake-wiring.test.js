'use strict';
/**
 * app/main.js and "start a lane from an issue" (BACKLOG #119 A6), pinned as source text (main.js requires Electron and
 * can't be loaded here). The decisions are tested in test/issues.test.js, issue-lane.test.js and tab-shell-issues.test.js;
 * these pin the wiring that keeps the rules that cost something: every new channel answers the strip page alone, the issue
 * number is validated before it reaches the shell, gh is never run through a shell, and a link leaves the app by the one gate.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const MAIN = strip(read('app', 'main.js'));

function callText(src, at) {
  const open = src.indexOf('(', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced call at ${at}`);
}
const channel = (name) => {
  const at = MAIN.search(new RegExp(`ipcMain\\.(on|handle)\\(\\s*'${name}'`));
  assert.ok(at !== -1, `${name} must be registered`);
  return callText(MAIN, at);
};

test('the three new strip channels exist and answer the strip page alone', () => {
  for (const name of ['strip:issues', 'strip:pickerOpen', 'strip:pickerClose']) {
    assert.match(channel(name), /fromStrip\(e\)/, name);
  }
});

test('strip:issues is a handle (the page awaits it) and reads through the service, with the request left to host/issues.js', () => {
  assert.match(MAIN, /ipcMain\.handle\('strip:issues'/);
  assert.match(channel('strip:issues'), /answerIssuesRequest\(issueService, HOST_PROJECT\.dev, req\)/);
});

test('strip:create passes the issue number on only after issueArg has read it', () => {
  const c = channel('strip:create');
  assert.match(c, /typeof branch !== 'string' \|\| branch\.length > 200\) return/, 'the old branch guard is untouched');
  assert.match(c, /tabShell\.createWorktree\(branch, issueArg\(issue\)\)/);
});

test('the picker steps the selected tab\'s page aside, and its panel with it', () => {
  const at = MAIN.indexOf('function applySelection(');
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.match(body, /const pickerOpen = !!\(snapshot\.create && snapshot\.create\.picker === true\)/);
  assert.match(body, /const shows = tab\.key === snapshot\.selectedKey && !pickerOpen;/);
  assert.match(body, /tab\.view\.setVisible\(shows\)/);
  assert.match(body, /canvasViews\.setOwnerVisible\(tab\.view\.webContents, shows\)/);
});

test('the shell is given the brief writer and the branch-to-issue reader, made from one service', () => {
  const at = MAIN.indexOf('tabShell = createShell({');
  const call = callText(MAIN, at);
  assert.match(call, /issues: \{\s*brief: createLaneBriefWriter\(\{ cwd: HOST_PROJECT\.dev, service: issueService, ops: briefOps \}\),/);
  assert.match(call, /forBranch: \(branch\) => issueForBranch\(branch, issueService\.cached\(HOST_PROJECT\.dev\)\)/);
  assert.match(MAIN, /issueService = createIssueService\(\);/);
});

test('Open issue is in the tab\'s right-click menu, and its link leaves the app only through openInBrowser', () => {
  const at = MAIN.indexOf("ipcMain.on('strip:contextMenu'");
  const menu = MAIN.slice(at, MAIN.indexOf("ipcMain.on('strip:plus'", at));
  assert.match(menu, /tabShell\.issueOf\(key\)/);
  assert.match(menu, /label: `Open issue #\$\{issue\.number\}/);
  assert.match(menu, /menuText\(issue\.title\)/, 'a title is somebody else\'s string: it goes through menuText');
  const open = MAIN.slice(MAIN.indexOf('async function openIssue('), MAIN.indexOf('function createTabView('));
  assert.match(open, /resolveIssueUrl\(issueService, HOST_PROJECT\.dev, issue\)/);
  assert.match(open, /return openInBrowser\(url, 'issue'\)/);
  assert.doesNotMatch(open, /openExternal/);
});

test('the startup read of the issue list is not done under the probe driver, and never blocks the window', () => {
  assert.match(MAIN, /if \(MODE === 'tabs' && !PROBE_PORT\) setTimeout\(\(\) => \{ issueService\.list\(HOST_PROJECT\.dev\)\.catch\(\(\) => \{\}\); \}, 20_000\)\.unref\(\);/);
});

test('gh is run with an argv array and no shell, and the issue text never reaches the command line', () => {
  const issues = strip(read('host', 'issues.js'));
  assert.match(issues, /execFile\(c\.file, \[\.\.\.c\.prefix, \.\.\.args\]/);
  assert.doesNotMatch(issues, /(?<![.\w])exec\(|shell:\s*true|execSync|spawnSync|(?<![.\w])spawn\(/);
  const lane = strip(read('host', 'issue-lane.js'));
  assert.doesNotMatch(lane, /child_process|\bexec|spawn/);
});

test('the brief script is run like the contract scripts: no shell, never killed', () => {
  const ops = strip(read('host', 'worktree-ops.js'));
  const at = ops.indexOf('async briefPath(');
  const body = ops.slice(at, ops.indexOf('\n    },', at));
  assert.match(body, /runScript\(\{ script, timeoutMs: TIMEOUT_MS\.create, spawn, args: \[psArg\('Path', wt\)\] \}\)/);
  assert.doesNotMatch(body, /\.kill\(/);
});

test('the preload bridge carries the issue number as a plain argument, and the three new calls', () => {
  const pre = strip(read('app', 'preload-strip.js'));
  assert.match(pre, /create: \(branch, issue\) => ipcRenderer\.send\('strip:create', branch, issue\)/);
  assert.match(pre, /issues: \(req\) => ipcRenderer\.invoke\('strip:issues', req\)/);
  assert.match(pre, /pickerOpen: \(\) => ipcRenderer\.send\('strip:pickerOpen'\)/);
  assert.match(pre, /pickerClose: \(\) => ipcRenderer\.send\('strip:pickerClose'\)/);
});
