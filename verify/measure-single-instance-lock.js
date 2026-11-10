'use strict';
/**
 * MEASURE (re-runnable): does Electron 33's app.requestSingleInstanceLock(additionalData) scope the lock per PROJECT?
 * (lane feat/one-window-per-project, mechanism choice, DESIGN_TABS_SESSIONS.md 3.3 option b)
 *
 *   node scripts/with-heavy-lock.js node verify/measure-single-instance-lock.js      (exit 0 = measured; prints the verdict)
 *
 * Three tiny Electron apps (no window, a temp main.js, never this app's code):
 *   A  the first one, user data X, additionalData {project:'A'}                    -> holds the lock
 *   B  user data X (the real app's one shared user data), additionalData {project:'B'}
 *   C  a different user data dir, additionalData {project:'C'}
 * If the lock were per project, B would get the lock (a different project). It is per user-data dir: B is refused and A is told
 * about B. So option (b) would turn the second PROJECT's window away too, unless every project had its own user data
 * (its own cache, cookies, localStorage, settings) -- a change far bigger than this lane. Option (a) needs a host; the window's
 * own pipe (host/window-focus.js) needs neither.
 */
const fs = require('fs');
const path = require('path');
const { spawnElectron } = require('./lib/launch-electron');
const { tmpDir } = require('../test/tmp-dir');

const ROOT = path.join(__dirname, '..');
const tmp = tmpDir('cc-measure-lock-');
const appDir = path.join(tmp, 'app');
fs.mkdirSync(appDir);
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'lock-measure', main: 'main.js' }));
fs.writeFileSync(path.join(appDir, 'main.js'), [
  "const { app } = require('electron');",
  "const got = app.requestSingleInstanceLock({ project: process.env.M_PROJECT });",
  "console.log('LOCK ' + got);",
  "app.on('second-instance', (e, argv, cwd, extra) => console.log('SECOND ' + JSON.stringify(extra)));",
  "app.whenReady().then(() => setTimeout(() => app.exit(0), Number(process.env.M_HOLD)));",
].join('\n'));

const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function launch(userData, project, hold) {
  const env = { ...process.env, M_PROJECT: project, M_HOLD: String(hold) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnElectron(electron, [appDir, `--user-data-dir=${userData}`], { cwd: appDir, env }, { keepEnv: ['M_PROJECT', 'M_HOLD'] });
  const r = { child, out: '' };
  child.stdout.on('data', d => { r.out += d; });
  child.stderr.on('data', d => { r.out += d; });
  r.exited = new Promise(res => child.on('exit', res));
  return r;
}

(async () => {
  const x = path.join(tmp, 'x');
  const a = launch(x, 'A', 9000);
  await sleep(4000);
  const b = launch(x, 'B', 4000);
  const c = launch(path.join(tmp, 'y'), 'C', 4000);
  await Promise.all([a.exited, b.exited, c.exited]);   // each ends itself (app.exit after its hold)
  const line = (r, re) => (r.out.match(re) || ['(none)'])[0];
  console.log('A:', line(a, /LOCK \w+/), '|', line(a, /SECOND .*/), '   (the first; was told about B?)');
  console.log('B:', line(b, /LOCK \w+/), '   (same user data, another PROJECT)');
  console.log('C:', line(c, /LOCK \w+/), '   (another user data dir)');
  const perProject = /LOCK true/.test(b.out);
  console.log(perProject ? 'VERDICT: the lock is per project' : 'VERDICT: the lock is per user-data dir, NOT per project -> option (b) refuses other projects\' windows too');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
