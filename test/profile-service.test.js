'use strict';
/**
 * app/profile-service.js: main's side of account profiles (BACKLOG #119 A1). Every effect is injected: the shell, the confirm dialog,
 * "open this folder", the broadcast to the pages. The files are real, in a temp dir.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createProfileService } = require('../app/profile-service');
const P = require('../host/profiles');
const { tmpDir } = require('./tmp-dir');

const HOME = path.join(os.tmpdir(), 'cc-profile-home');
const mkTmp = () => tmpDir('cc-profsvc-');

function make({ confirm = true, tabs = [] } = {}) {
  const dir = mkTmp();
  const h = { dir, broadcasts: 0, opened: [], confirms: [], changes: [], refreshes: 0, mkdirs: [], used: new Set() };
  const tabsByView = new Map(tabs);        // [[view, { key, started, profileId }]]
  const shell = {
    tabForSender: (s) => tabsByView.get(s) || null,
    changeProfile: async (key, id) => { h.changes.push([key, id]); return { ok: true, restarted: true }; },
    profilesInUse: () => h.used,
    refresh: () => { h.refreshes++; },
  };
  h.svc = createProfileService({
    dir, home: HOME, shell: () => shell,
    confirm: async (text) => { h.confirms.push(text); return confirm; },
    openPath: async (p) => { h.opened.push(p); return ''; },
    mkdir: (p) => { h.mkdirs.push(p); },
    broadcast: () => { h.broadcasts++; },
    projectKeyOf: () => 'c:\\proj',
    log: () => {},
  });
  return h;
}

const addWork = (h) => h.svc.add({ name: 'Work', colour: '#4c8bf5' });

test('a fresh service lists only the default, and writes nothing until a profile is added', () => {
  const h = make();
  const s = h.svc.stateFor(null);
  assert.deepStrictEqual(s.profiles.map(p => p.id), ['default']);
  assert.deepStrictEqual(fs.readdirSync(h.dir), []);
});

test('add stores the profile on disk with the default folder, broadcasts, and returns the new list', () => {
  const h = make();
  const r = addWork(h);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.profiles.map(p => p.id), ['default', 'work']);
  assert.strictEqual(r.profiles[1].configDir, path.join(HOME, '.claude-profiles', 'work'));
  assert.strictEqual(P.readProfiles(P.profilesFile(h.dir)).store.profiles[0].id, 'work');
  assert.strictEqual(h.broadcasts, 1);
  assert.strictEqual(h.refreshes, 1);
});

test('add with a bad spec reports why and writes nothing', () => {
  const h = make();
  const r = h.svc.add({ name: '', colour: '#4c8bf5' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /name/);
  assert.deepStrictEqual(fs.readdirSync(h.dir), []);
  assert.strictEqual(h.broadcasts, 0);
});

test('a profiles file main could not read is never written over', () => {
  const h = make();
  fs.writeFileSync(P.profilesFile(h.dir), '{garbage');
  const r = addWork(h);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /read/i);
  assert.strictEqual(fs.readFileSync(P.profilesFile(h.dir), 'utf8'), '{garbage');
});

test('rename changes the name; remove refuses while a tab uses it, then forgets the entry and never touches the folder', () => {
  const h = make();
  addWork(h);
  assert.strictEqual(h.svc.rename({ id: 'work', name: 'Client' }).profiles[1].name, 'Client');
  h.used.add('work');
  const refused = h.svc.remove({ id: 'work' });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /tab/i);
  h.used.clear();
  const folder = path.join(HOME, '.claude-profiles', 'work');
  const ok = h.svc.remove({ id: 'work' });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.profiles.map(p => p.id), ['default']);
  assert.deepStrictEqual(h.mkdirs.filter(p => p === folder), [], 'no folder is made or removed by remove');
});

test('stateFor reports the tab\'s own profile and which profiles are in use', () => {
  const view = {};
  const h = make({ tabs: [[view, { key: 'c:\\proj\\dev', started: true, profileId: 'work' }]] });
  addWork(h);
  h.used.add('work');
  const s = h.svc.stateFor(view);
  assert.strictEqual(s.current, 'work');
  assert.deepStrictEqual(s.inUse, ['work']);
  assert.strictEqual(h.svc.stateFor({}).current, null, 'a stranger has no current profile');
});

test('spawnEnvFor: a stored profile gives its folder (and makes it); the default and unknown ids give null', () => {
  const h = make();
  addWork(h);
  const w = h.svc.spawnEnvFor({ profileId: 'work' });
  assert.deepStrictEqual(w, { configDir: path.join(HOME, '.claude-profiles', 'work'), profileId: 'work' });
  assert.deepStrictEqual(h.mkdirs, [w.configDir], 'the folder is created empty for the CLI to fill');
  assert.deepStrictEqual(h.svc.spawnEnvFor({ profileId: 'default' }), { configDir: null, profileId: 'default' });
  assert.deepStrictEqual(h.svc.spawnEnvFor({ profileId: 'ghost' }), { configDir: null, profileId: 'default' });
  assert.deepStrictEqual(h.svc.spawnEnvFor({ profileId: null }), { configDir: null, profileId: null });
});

test('choose / remember: a hand pick is remembered per tab and as the project\'s last used, on disk', () => {
  const h = make();
  addWork(h);
  const tab = { key: 'c:\\proj\\feat-a' };
  assert.strictEqual(h.svc.choose(tab), 'default');
  h.svc.remember(tab, 'work');
  assert.strictEqual(h.svc.choose(tab), 'work');
  assert.strictEqual(h.svc.choose({ key: 'c:\\proj\\feat-b' }), 'work', 'a new tab of the project opens under the last used');
  assert.strictEqual(P.readChoices(P.choicesFile(h.dir)).choices.byProject['c:\\proj'], 'work');
});

test('choose falls back to the default when the store or the choices file cannot be read', () => {
  const h = make();
  fs.writeFileSync(P.profilesFile(h.dir), '{garbage');
  fs.writeFileSync(P.choicesFile(h.dir), '[[');
  assert.strictEqual(h.svc.choose({ key: 'c:\\proj\\dev' }), 'default');
});

test('resolve gives { id, name, colour } or null', () => {
  const h = make();
  addWork(h);
  assert.deepStrictEqual(h.svc.resolve('work'), { id: 'work', name: 'Work', colour: '#4c8bf5' });
  assert.deepStrictEqual(h.svc.resolve('default'), { id: 'default', name: 'Default', colour: null });
  assert.strictEqual(h.svc.resolve('ghost'), null);
  assert.strictEqual(h.svc.resolve(5), null);
});

test('switchTo with no session just sets it; with a live session it asks first and does nothing on Cancel', async () => {
  const idle = {}; const live = {};
  const h = make({ tabs: [
    [idle, { key: 'c:\\proj\\a', started: false, profileId: null }],
    [live, { key: 'c:\\proj\\b', started: true, profileId: 'default' }],
  ], confirm: false });
  addWork(h);
  assert.deepStrictEqual(await h.svc.switchTo(idle, 'work'), { ok: true, restarted: true });
  assert.deepStrictEqual(h.changes, [['c:\\proj\\a', 'work']]);
  assert.strictEqual(h.confirms.length, 0, 'no session, no question');
  const r = await h.svc.switchTo(live, 'work');
  assert.deepStrictEqual(r, { ok: false, cancelled: true });
  assert.deepStrictEqual(h.confirms, ['Restart this session as Work? The current session keeps its transcript.']);
  assert.strictEqual(h.changes.length, 1, 'cancelled: the shell was not asked to switch');
});

test('switchTo on Yes asks the shell; on the same profile or an unknown one it does not ask or switch', async () => {
  const live = {};
  const h = make({ tabs: [[live, { key: 'c:\\proj\\b', started: true, profileId: 'default' }]] });
  addWork(h);
  assert.strictEqual((await h.svc.switchTo(live, 'work')).ok, true);
  assert.deepStrictEqual(h.changes, [['c:\\proj\\b', 'work']]);
  assert.deepStrictEqual(await h.svc.switchTo(live, 'default'), { ok: true, restarted: false });
  assert.strictEqual((await h.svc.switchTo(live, 'ghost')).ok, false);
  assert.strictEqual((await h.svc.switchTo({}, 'work')).ok, false, 'a sender that is not a tab');
  assert.strictEqual(h.changes.length, 1);
});

test('openFolder makes the folder if it is not there yet, then opens it; the default and unknown ids refuse', async () => {
  const h = make();
  addWork(h);
  const r = await h.svc.openFolder({ id: 'work' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.opened, [path.join(HOME, '.claude-profiles', 'work')]);
  assert.strictEqual(h.mkdirs.length, 1);
  assert.strictEqual((await h.svc.openFolder({ id: 'default' })).ok, false);
  assert.strictEqual((await h.svc.openFolder({ id: 'ghost' })).ok, false);
});

test('switchTo on a tab whose session already ended asks nothing: there is no session to lose', async () => {
  const gone = {};
  const h = make({ tabs: [[gone, { key: 'c:\proj\a', started: true, ended: true, profileId: 'default' }]], confirm: false });
  addWork(h);
  const r = await h.svc.switchTo(gone, 'work');
  assert.deepStrictEqual(r, { ok: true, restarted: true });
  assert.strictEqual(h.confirms.length, 0);
  assert.deepStrictEqual(h.changes, [['c:\proj\a', 'work']]);
});
