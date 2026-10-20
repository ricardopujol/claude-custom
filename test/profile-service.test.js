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

function make({ confirm = true, tabs = [], hostProfiles, inheritedConfigDir } = {}) {
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
    random: () => '000000',
    hostProfiles, inheritedConfigDir,
  });
  return h;
}

// the service is given a fixed random so the new profile's id is known: slug 'work' + this
const WORK = 'work-000000';
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
  assert.deepStrictEqual(r.profiles.map(p => p.id), ['default', WORK]);
  assert.strictEqual(r.profiles[1].configDir, path.join(HOME, '.claude-profiles', WORK));
  assert.strictEqual(P.readProfiles(P.profilesFile(h.dir)).store.profiles[0].id, WORK);
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
  assert.strictEqual(h.svc.rename({ id: WORK, name: 'Client' }).profiles[1].name, 'Client');
  h.used.add(WORK);
  const refused = h.svc.remove({ id: WORK });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /tab/i);
  h.used.clear();
  const folder = path.join(HOME, '.claude-profiles', WORK);
  const ok = h.svc.remove({ id: WORK });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.profiles.map(p => p.id), ['default']);
  assert.deepStrictEqual(h.mkdirs.filter(p => p === folder), [], 'no folder is made or removed by remove');
});

test('stateFor reports the tab\'s own profile and which profiles are in use', () => {
  const view = {};
  const h = make({ tabs: [[view, { key: 'c:\\proj\\dev', started: true, profileId: WORK }]] });
  addWork(h);
  h.used.add(WORK);
  const s = h.svc.stateFor(view);
  assert.strictEqual(s.current, WORK);
  assert.deepStrictEqual(s.inUse, [WORK]);
  assert.strictEqual(h.svc.stateFor({}).current, null, 'a stranger has no current profile');
});

test('spawnEnvFor: a stored profile gives its folder (and makes it); the default and unknown ids give null', () => {
  const h = make();
  addWork(h);
  const w = h.svc.spawnEnvFor({ profileId: WORK });
  assert.deepStrictEqual(w, { configDir: path.join(HOME, '.claude-profiles', WORK), profileId: WORK });
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
  h.svc.remember(tab, WORK);
  assert.strictEqual(h.svc.choose(tab), WORK);
  assert.strictEqual(h.svc.choose({ key: 'c:\\proj\\feat-b' }), WORK, 'a new tab of the project opens under the last used');
  assert.strictEqual(P.readChoices(P.choicesFile(h.dir)).choices.byProject['c:\\proj'], WORK);
});

test('an unreadable choices file falls back to the default, but an unreadable PROFILES file refuses to guess (Dexter 4)', () => {
  const h = make();
  fs.writeFileSync(P.choicesFile(h.dir), '[[');
  assert.strictEqual(h.svc.choose({ key: 'c:\proj\dev' }), 'default');
  fs.writeFileSync(P.profilesFile(h.dir), '{garbage');
  assert.throws(() => h.svc.choose({ key: 'c:\proj\dev' }), /couldn't read your profiles file/);
});

test('a tab that should run as a stored profile is NOT started on the default when the profiles file is unreadable (Dexter 4, Miguel Y5)', () => {
  const h = make();
  addWork(h);
  fs.writeFileSync(P.profilesFile(h.dir), '{garbage');
  assert.throws(() => h.svc.spawnEnvFor({ profileId: WORK }), /couldn't read your profiles file/);
  assert.deepStrictEqual(h.mkdirs, [], 'and no folder is made');
  // the default needs no store at all
  assert.deepStrictEqual(h.svc.spawnEnvFor({ profileId: 'default' }), { configDir: null, profileId: 'default' });
});

test('"in use" is machine-wide: a running host of another window, read from its identity file, blocks Remove (Dexter 7, Miguel Y3)', () => {
  const h = make({ hostProfiles: () => [WORK, 5, null] });
  addWork(h);
  assert.deepStrictEqual(h.svc.stateFor(null).inUse, [WORK]);
  const r = h.svc.remove({ id: WORK });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /using|tab|session/i);
  assert.deepStrictEqual(P.readProfiles(P.profilesFile(h.dir)).store.profiles.map(p => p.id), [WORK], 'still stored');
});

test('a hostProfiles reader that throws does not hide the tabs of this window', () => {
  const h = make({ hostProfiles: () => { throw new Error('unreadable'); } });
  addWork(h);
  h.used.add(WORK);
  assert.deepStrictEqual(h.svc.stateFor(null).inUse, [WORK]);
});

test('the account the app was launched with counts as the default: a profile cannot point at it (Dexter 9, Miguel Y2)', () => {
  const launched = path.join(HOME, 'launched-account');
  const h = make({ inheritedConfigDir: launched });
  const r = h.svc.add({ name: 'Dup', colour: '#4c8bf5', configDir: launched });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /default/);
});

test('removing a profile and adding the same name again gives a new id and a NEW folder (Dexter 8)', () => {
  const ids = ['111111', '222222'];
  const h = make();
  const svc = require('../app/profile-service').createProfileService({ dir: h.dir, home: HOME, shell: () => ({ profilesInUse: () => new Set(), tabForSender: () => null, refresh() {} }), confirm: async () => true, openPath: async () => '', mkdir() {}, broadcast() {}, projectKeyOf: () => 'p', log() {}, random: () => ids.shift() });
  const first = svc.add({ name: 'Work', colour: '#4c8bf5' }).profile;
  svc.remove({ id: first.id });
  const second = svc.add({ name: 'Work', colour: '#4c8bf5' }).profile;
  assert.notStrictEqual(second.id, first.id);
  assert.notStrictEqual(second.configDir, first.configDir);
});

test('resolve gives { id, name, colour } or null', () => {
  const h = make();
  addWork(h);
  assert.deepStrictEqual(h.svc.resolve(WORK), { id: WORK, name: 'Work', colour: '#4c8bf5' });
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
  assert.deepStrictEqual(await h.svc.switchTo(idle, WORK), { ok: true, restarted: true });
  assert.deepStrictEqual(h.changes, [['c:\\proj\\a', WORK]]);
  assert.strictEqual(h.confirms.length, 0, 'no session, no question');
  const r = await h.svc.switchTo(live, WORK);
  assert.deepStrictEqual(r, { ok: false, cancelled: true });
  assert.deepStrictEqual(h.confirms, ['Restart this session as Work? The current session keeps its transcript.']);
  assert.strictEqual(h.changes.length, 1, 'cancelled: the shell was not asked to switch');
});

test('switchTo on Yes asks the shell; on the same profile or an unknown one it does not ask or switch', async () => {
  const live = {};
  const h = make({ tabs: [[live, { key: 'c:\\proj\\b', started: true, profileId: 'default' }]] });
  addWork(h);
  assert.strictEqual((await h.svc.switchTo(live, WORK)).ok, true);
  assert.deepStrictEqual(h.changes, [['c:\\proj\\b', WORK]]);
  assert.deepStrictEqual(await h.svc.switchTo(live, 'default'), { ok: true, restarted: false });
  assert.strictEqual((await h.svc.switchTo(live, 'ghost')).ok, false);
  assert.strictEqual((await h.svc.switchTo({}, WORK)).ok, false, 'a sender that is not a tab');
  assert.strictEqual(h.changes.length, 1);
});

test('openFolder makes the folder if it is not there yet, then opens it; the default and unknown ids refuse', async () => {
  const h = make();
  addWork(h);
  const r = await h.svc.openFolder({ id: WORK });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.opened, [path.join(HOME, '.claude-profiles', WORK)]);
  assert.strictEqual(h.mkdirs.length, 1);
  assert.strictEqual((await h.svc.openFolder({ id: 'default' })).ok, false);
  assert.strictEqual((await h.svc.openFolder({ id: 'ghost' })).ok, false);
});

test('switchTo on a tab whose session already ended asks nothing: there is no session to lose', async () => {
  const gone = {};
  const h = make({ tabs: [[gone, { key: 'c:\proj\a', started: true, ended: true, profileId: 'default' }]], confirm: false });
  addWork(h);
  const r = await h.svc.switchTo(gone, WORK);
  assert.deepStrictEqual(r, { ok: true, restarted: true });
  assert.strictEqual(h.confirms.length, 0);
  assert.deepStrictEqual(h.changes, [['c:\proj\a', WORK]]);
});

test('N3: Remove asks the host reader for STRICT proof; the advisory list does not (it would cost a process per refresh)', () => {
  const asks = [];
  const h = make({ hostProfiles: (o) => { asks.push(!!(o && o.strict)); return []; } });
  addWork(h);
  h.svc.stateFor(null);
  h.svc.remove({ id: WORK });
  assert.strictEqual(asks.filter(x => x === true).length, 1, 'exactly one strict ask: the Removes');
});

test('N3: a profile whose only "host" fails the strict proof (pid reused) can be removed', () => {
  const h = make({ hostProfiles: (o) => (o && o.strict ? [] : [WORK]) });
  addWork(h);
  assert.deepStrictEqual(h.svc.stateFor(null).inUse, [WORK], 'advisory: still shown as in use');
  assert.strictEqual(h.svc.remove({ id: WORK }).ok, true);
});
