'use strict';
/**
 * Jiandu Home's wiring in app/main.js (plan documentation/PLAN_PROJECT_HUB.md H-PR2): source shapes only. The behaviour is the modules'
 * (test/home-controller.test.js, test/home-window.test.js) and the real window's (verify/probe-home.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const { mainOnly } = require('./main-source');

const MAIN = mainOnly({ strip: true });
const body = (head) => {
  const at = MAIN.indexOf(head);
  assert.ok(at !== -1, `main has ${head}`);
  return MAIN.slice(at, MAIN.indexOf('\n}\n', at));
};

test('both Home channels answer only the Home window\'s own page, and a refused act is logged', () => {
  const ipc = body('function registerHomeIpc() {');
  assert.match(ipc, /ipcMain\.on\('home:ready', \(e\) => \{ if \(homeWindow\.isSender\(e\.sender\)\) homeWindow\.send\(homeController\.model\(\)\); \}\);/);
  assert.match(ipc, /ipcMain\.on\('home:act', \(e, msg\) => \{\s*if \(!homeWindow\.isSender\(e\.sender\)\) return;\s*const r = homeController\.act\(msg\);/);
  assert.match(ipc, /if \(!r\.ok\) console\.log\(/);
  assert.strictEqual((MAIN.match(/ipcMain\.(?:on|handle)\('home:/g) || []).length, 2, 'two channels, no more');
});

test('Home reads 50 Claude Code projects (the brief\'s default) through the off-thread reader', () => {
  assert.match(MAIN, /const HOME_RECENTS = 50;/);
  assert.match(MAIN, /readRecents: \(\) => readRecentsOffThread\(\{ projectsDir: readSeams\(process\.env\)\.projectsDir \|\| undefined, limit: HOME_RECENTS \}\),/);
});

test('every open from Home takes the one open path (the queue), shown; the tray and the app pipe show Home', () => {
  assert.match(MAIN, /open: \(cwd\) => \{ openProject\(\{ cwd, show: 'shown' \}\)\.catch\(\(\) => \{\}\); \},/);
  assert.match(MAIN, /actions: \{\s*showHome: \(\) => showHome\(\),\s*focusWindow:/);
  assert.match(MAIN, /function showHome\(\{ hidden = false \} = \{\}\) \{\s*homeWindow\.show\(\{ hidden \}\);\s*homeController\.refresh\(\)\.catch\(\(\) => \{\}\);\s*\}/);
});

test('Show in Explorer goes through app/file-link.js (#37: a folder opens; nothing handed to the OS is ever run)', () => {
  assert.match(MAIN, /showInExplorer: \(root\) => \{\s*fileLink\.open\(root, root, fileFs, shell\)\.then\(/);
});

test('Miguel B1: the Home window guards its navigation and denies every window open (a page that navigates keeps its bridge)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'home-window.js'), 'utf8');
  assert.match(src, /require\('\.\/nav-guard'\)/);
  assert.match(src, /guardNavigation\(w\.webContents, /);
  assert.match(src, /w\.webContents\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\);/);
});

test('PR #263 Dexter 2: Home\'s session end is the project window\'s: quitting, and the crash record clean', () => {
  assert.match(MAIN, /onSessionEnd: \(\) => \{ quitting = true; markRecordClean\(\); \},/);
});

test('Home\'s close follows the project window\'s rule (H5): it hides only with minimise-on-close, a tray, and no quit under way', () => {
  assert.match(MAIN, /hidesOnClose: \(\) => hidesOnClose\(\{ settings: readTraySettings\(uiStore\), trayExists: !!trayController && trayController\.state\(\)\.exists, quitting \}\),/);
});
