'use strict';
/**
 * How claude-custom.exe reads its command line (host/exe-entry.js), every branch, with no window. Paths use forward slashes
 * and are resolved the way the code resolves them, so the test reads the same on any machine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { USAGE, REEXEC, versionText, decideEntry, carryOut, startedAsNode, nodeModePlan, appLaunchArgs, electronLaunch } = require('../host/exe-entry');

const R = (p) => path.resolve(p);
const INSTALL = R('C:/Users/x/AppData/Local/Programs/claude-custom');
const HOME = R('C:/Users/x');
const dirs = (...list) => { const set = new Set(list.map(R)); return (p) => { if (!set.has(R(p))) throw new Error('ENOENT'); return { isDirectory: () => true }; }; };
const base = { cwd: R('C:/work'), installDir: INSTALL, home: HOME, packaged: true, pkg: { version: '0.0.1' }, env: {} };
const decide = (args, over = {}) => decideEntry({ ...base, args, stat: dirs('C:/work/proj'), ...over });

test('versionText: one stable line, the same shape from both entry points, and an honest unknown', () => {
  assert.equal(versionText({ version: '0.0.1' }), 'claude-custom 0.0.1');
  for (const bad of [null, undefined, {}, { version: 5 }, { version: '' }]) assert.equal(versionText(bad), 'claude-custom (version unknown)');
  assert.match(versionText(require('../package.json')), /^claude-custom \d+\.\d+\.\d+$/);
});

test('--version and -v print the line; --help and -h print the usage; help beats version; both work outside an installed build too', () => {
  assert.deepEqual(decide(['--version']), { action: 'version', text: 'claude-custom 0.0.1' });
  assert.deepEqual(decide(['-v']), { action: 'version', text: 'claude-custom 0.0.1' });
  assert.deepEqual(decide(['x', '--help']), { action: 'help', text: USAGE });
  assert.deepEqual(decide(['-h']), { action: 'help', text: USAGE });
  assert.equal(decide(['--version', '--help']).action, 'help');
  assert.equal(decide(['--version'], { packaged: false }).action, 'version');
  assert.equal(decide(['--help'], { packaged: false }).action, 'help');
});

test('--stop is refused, never turned into "open a window here", wherever it is in the line', () => {
  for (const args of [['--stop'], ['C:/work/proj', '--stop'], ['--stop', 'C:/work/proj']]) {
    const d = decide(args);
    assert.equal(d.action, 'refuse', JSON.stringify(args));
    assert.match(d.text, /--stop/);
    assert.equal(d.cwd, undefined);
  }
});

test('a folder argument opens that folder, resolved against where it was started', () => {
  assert.deepEqual(decide(['C:/work/proj']), { action: 'open', cwd: R('C:/work/proj') });
  assert.deepEqual(decide(['proj']), { action: 'open', cwd: R('C:/work/proj') });
});

test('a mistyped folder is refused in one line naming it; a file, two folders, and a bad second argument are refused too', () => {
  const typo = decide(['C:/work/porj']);
  assert.equal(typo.action, 'refuse');
  assert.equal(typo.text, `no such folder: ${R('C:/work/porj')}`);
  assert.equal(decide(['notes.txt', 'C:/work/proj']).action, 'refuse');
  assert.match(decide(['C:/work/proj', 'C:/work/proj']).text, /one folder at a time \(got 2\)/);
});

test('a folder argument beats an inherited CLAUDE_CUSTOM_CWD, and options other than the three are ignored', () => {
  const env = { CLAUDE_CUSTOM_CWD: R('C:/old/tab') };
  assert.deepEqual(decide(['C:/work/proj'], { env }), { action: 'open', cwd: R('C:/work/proj') });
  assert.deepEqual(decide(['--inspect', '--user-data-dir=x', 'C:/work/proj']), { action: 'open', cwd: R('C:/work/proj') });
});

test("no folder: the launcher's CLAUDE_CUSTOM_CWD, else the folder it was started in", () => {
  assert.deepEqual(decide([], { env: { CLAUDE_CUSTOM_CWD: R('C:/old/tab') } }), { action: 'open', cwd: R('C:/old/tab') });
  assert.deepEqual(decide([], { env: { CLAUDE_CUSTOM_CWD: '' } }), { action: 'open', cwd: R('C:/work') });
  assert.deepEqual(decide([]), { action: 'open', cwd: R('C:/work') });
});

test('started in its own install folder (the Start menu): the home folder; a sibling sharing the prefix is not inside it', () => {
  assert.deepEqual(decide([], { cwd: INSTALL }), { action: 'open', cwd: HOME });
  assert.deepEqual(decide([], { cwd: path.join(INSTALL, 'resources') }), { action: 'open', cwd: HOME });
  assert.deepEqual(decide([], { cwd: INSTALL + '-projects' }), { action: 'open', cwd: INSTALL + '-projects' });
});

test('outside an installed build only version and help apply: a checkout opens CLAUDE_CUSTOM_CWD or the cwd, nothing is refused', () => {
  assert.deepEqual(decide(['.', '--stop', 'nope'], { packaged: false }), { action: 'open', cwd: R('C:/work') });
  assert.deepEqual(decide([], { packaged: false, env: { CLAUDE_CUSTOM_CWD: R('C:/p') } }), { action: 'open', cwd: R('C:/p') });
});

test('carryOut: version and help exit 0 only when the line was written; a failed write is exit 1', () => {
  for (const action of ['version', 'help']) {
    const ok = [];
    const bad = [];
    assert.equal(carryOut({ action, text: 'T' }, { write: (fd, t) => { ok.push([fd, t]); return true; }, exit: (c) => ok.push(c) }), true);
    assert.deepEqual(ok, [[1, 'T\n'], 0]);
    carryOut({ action, text: 'T' }, { write: () => false, exit: (c) => bad.push(c) });
    assert.deepEqual(bad, [1]);
  }
});

test('carryOut: a refusal goes to stderr and exits 1, even if the write fails; open is left to the caller', () => {
  const log = [];
  assert.equal(carryOut({ action: 'refuse', text: 'no' }, { write: (fd, t) => { log.push([fd, t]); return false; }, exit: (c) => log.push(c) }), true);
  assert.deepEqual(log, [[2, 'no\n'], 1]);
  assert.equal(carryOut({ action: 'open', cwd: 'x' }, { write: () => { throw new Error('no'); }, exit: () => { throw new Error('no'); } }), false);
});

test('startedAsNode: any non-empty ELECTRON_RUN_AS_NODE; empty, unset or no env is not', () => {
  assert.equal(startedAsNode({ ELECTRON_RUN_AS_NODE: '1' }), true);
  assert.equal(startedAsNode({ ELECTRON_RUN_AS_NODE: '' }), false);
  assert.equal(startedAsNode({}), false);
  assert.equal(startedAsNode(undefined), false);
});

test('electronLaunch: a checkout starts its own electron on the install folder; an installed build starts this exe with no arguments', () => {
  const dev = electronLaunch({ installDir: 'C:/i', execPath: 'C:/i/claude-custom.exe', load: () => 'C:/i/node_modules/electron/dist/electron.exe', isElectron: false });
  assert.deepEqual(dev, { exe: 'C:/i/node_modules/electron/dist/electron.exe', args: ['C:/i'], installed: false });
  const asked = [];
  const packaged = electronLaunch({ installDir: 'C:/i', execPath: 'C:/i/claude-custom.exe', load: (p) => { asked.push(p); throw new Error('MODULE_NOT_FOUND'); }, isElectron: true });
  assert.deepEqual(packaged, { exe: 'C:/i/claude-custom.exe', args: [], installed: true });
  assert.equal(asked[0], path.join('C:/i', 'node_modules', 'electron'));
  assert.equal(electronLaunch({ installDir: 'C:/i', execPath: 'e', load: () => ({}), isElectron: true }).installed, true, 'a module that is not a path is not an electron');
});

test('electronLaunch: plain Node with no working electron is an error that names the cause, never a bare node REPL', () => {
  assert.throws(() => electronLaunch({ installDir: 'C:/i', execPath: 'C:/node/node.exe', isElectron: false, load: () => { throw new Error('Electron failed to install correctly'); } }),
    /Electron failed to install correctly[\s\S]*npm ci/);
  assert.throws(() => electronLaunch({ installDir: 'C:/i', execPath: 'C:/node/node.exe', isElectron: false, load: () => ({}) }), /isn't available/);
});

// The strip's Open (app/main.js spawnWindow) in the installed build and in a checkout: its exact argv, fed to the entry decision.
const APP = R('C:/Users/x/AppData/Local/Programs/claude-custom/resources/app');
const PROJ = R('C:/work/proj');

test('the strip\'s Open in an INSTALLED build passes no folder argument, so the row\'s folder (from attachEnv) is the one opened', () => {
  const argv = appLaunchArgs({ packaged: true, installDir: APP });
  assert.deepEqual(argv, []);
  const d = decide(argv, { env: { CLAUDE_CUSTOM_CWD: PROJ, CLAUDE_CUSTOM_PORT: '7001' }, appDirs: [APP], stat: dirs('C:/work/proj') });
  assert.deepEqual(d, { action: 'open', cwd: PROJ });
});

test('even the app folder as the one argument (what an older spawner passed) is not a project: the row\'s folder still wins', () => {
  const d = decide([APP], { env: { CLAUDE_CUSTOM_CWD: PROJ }, appDirs: [APP], stat: dirs(APP, 'C:/work/proj') });
  assert.deepEqual(d, { action: 'open', cwd: PROJ });
  assert.deepEqual(decide([APP.toUpperCase()], { env: { CLAUDE_CUSTOM_CWD: PROJ }, appDirs: [APP], stat: dirs(APP) }), { action: 'open', cwd: PROJ }, 'Windows paths compare without case');
  assert.equal(decide([APP, PROJ], { appDirs: [APP], stat: dirs(APP, 'C:/work/proj') }).cwd, PROJ, 'a real folder beside it still counts');
});

test('the strip\'s Open in a CHECKOUT passes the app folder, which is not a project either', () => {
  const argv = appLaunchArgs({ packaged: false, installDir: APP });
  assert.deepEqual(argv, [APP]);
  const d = decide(argv, { packaged: false, env: { CLAUDE_CUSTOM_CWD: PROJ }, appDirs: [APP] });
  assert.deepEqual(d, { action: 'open', cwd: PROJ });
});

test('nodeModePlan: not node mode runs; node mode in any spelling re-runs once without it; the re-run still in node mode gives up', () => {
  assert.deepEqual(nodeModePlan({ PATH: 'p' }), { action: 'run' });
  for (const name of ['ELECTRON_RUN_AS_NODE', 'electron_run_as_node', 'Electron_Run_As_Node']) {
    const plan = nodeModePlan({ [name]: '1', PATH: 'p' });
    assert.equal(plan.action, 'rerun', name);
    assert.deepEqual(Object.keys(plan.env).filter(k => k.toUpperCase() === 'ELECTRON_RUN_AS_NODE'), [], name);
    assert.equal(plan.env.PATH, 'p');
    assert.equal(plan.env[REEXEC], '1');
    assert.equal(nodeModePlan(plan.env).action, 'run', 'the re-run env is no longer node mode');
  }
  const again = nodeModePlan({ ELECTRON_RUN_AS_NODE: '1', [REEXEC]: '1' });
  assert.equal(again.action, 'giveup');
  assert.match(again.text, /still running as plain Node/);
});

test('startedAsNode reads any spelling, and ignores an empty value', () => {
  assert.equal(startedAsNode({ electron_run_as_node: '1' }), true);
  assert.equal(startedAsNode({ electron_run_as_node: '' }), false);
});
