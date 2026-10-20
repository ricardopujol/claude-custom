'use strict';
/**
 * host/profiles.js: the machine-wide account profile store (BACKLOG #119 A1) and the per-tab choice memory.
 * A profile is { id, name, configDir, colour }; the built-in `default` has no configDir (the CLI's own dir).
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../host/profiles');
const { tmpDir } = require('./tmp-dir');

const HOME = path.join(path.parse(os.homedir()).root, 'Users', 'someone');
const tmp = () => tmpDir('profiles-');
const prof = (over = {}) => ({ id: 'work', name: 'Work', configDir: path.join(HOME, '.claude-profiles', 'work'), colour: '#4c8bf5', ...over });
const storeOf = (...profiles) => ({ version: 1, profiles });

test('the built-in default is always listed first and has no configDir', () => {
  const list = P.listProfiles(storeOf(prof()));
  assert.strictEqual(list[0].id, 'default');
  assert.strictEqual(list[0].configDir, null);
  assert.deepStrictEqual(list.map(p => p.id), ['default', 'work']);
  assert.deepStrictEqual(P.listProfiles(null).map(p => p.id), ['default']);
});

test('configDirFor: default and unknown ids answer null (CLAUDE_CONFIG_DIR left alone), a known id its folder', () => {
  const store = storeOf(prof());
  assert.strictEqual(P.configDirFor(store, 'default'), null);
  assert.strictEqual(P.configDirFor(store, 'ghost'), null);
  assert.strictEqual(P.configDirFor(store, undefined), null);
  assert.strictEqual(P.configDirFor(store, 'work'), prof().configDir);
});

test('validateProfile: names what is wrong, null when fine', () => {
  assert.strictEqual(P.validateProfile(prof()), null);
  for (const bad of [
    null, 'x', [], prof({ id: 'default' }), prof({ id: '' }), prof({ id: 'Has Space' }), prof({ id: 5 }),
    prof({ name: '' }), prof({ name: '   ' }), prof({ name: 7 }), prof({ name: 'x'.repeat(41) }),
    prof({ configDir: '' }), prof({ configDir: null }), prof({ configDir: 'relative\\dir' }),
    prof({ colour: 'red' }), prof({ colour: '#12345' }), prof({ colour: null }),
  ]) {
    assert.strictEqual(typeof P.validateProfile(bad), 'string', JSON.stringify(bad));
  }
});

test('parseStore: missing, bad and ok are different answers; a bad file is never read as empty', () => {
  assert.strictEqual(P.parseStore(null).state, 'missing');
  assert.strictEqual(P.parseStore('{nope').state, 'bad');
  assert.strictEqual(P.parseStore('[]').state, 'bad');
  assert.strictEqual(P.parseStore(JSON.stringify({ version: 2, profiles: [] })).state, 'bad');
  assert.strictEqual(P.parseStore(JSON.stringify({ version: 1 })).state, 'bad');
  const ok = P.parseStore(JSON.stringify(storeOf(prof())));
  assert.strictEqual(ok.state, 'ok');
  assert.deepStrictEqual(ok.store.profiles, [prof()]);
});

test('parseStore drops an invalid entry and a duplicate id or folder, keeps the rest', () => {
  const a = prof();
  const dupId = prof({ name: 'Again', configDir: path.join(HOME, 'other') });
  const dupDir = prof({ id: 'two', configDir: a.configDir.toUpperCase() });
  const junk = { id: 'x' };
  const fine = prof({ id: 'play', name: 'Play', configDir: path.join(HOME, 'play') });
  const r = P.parseStore(JSON.stringify(storeOf(a, dupId, junk, dupDir, fine)));
  assert.deepStrictEqual(r.store.profiles.map(p => p.id), ['work', 'play']);
});

test('write then read round-trips and leaves no temp file', () => {
  const dir = tmp();
  const file = path.join(dir, 'profiles.json');
  assert.strictEqual(P.readProfiles(file).state, 'missing');
  P.writeProfiles(file, storeOf(prof()));
  assert.deepStrictEqual(fs.readdirSync(dir), ['profiles.json']);
  const r = P.readProfiles(file);
  assert.strictEqual(r.state, 'ok');
  assert.deepStrictEqual(r.store.profiles, [prof()]);
});

test('writeProfiles refuses an invalid store and writes nothing', () => {
  const dir = tmp();
  const file = path.join(dir, 'profiles.json');
  assert.throws(() => P.writeProfiles(file, storeOf(prof({ colour: 'nope' }))), /colour/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('readProfiles on an unreadable (garbage) file says bad and does not touch it', () => {
  const dir = tmp();
  const file = path.join(dir, 'profiles.json');
  fs.writeFileSync(file, '{garbage');
  assert.strictEqual(P.readProfiles(file).state, 'bad');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{garbage');
});

test('addProfile: the folder defaults to <home>/.claude-profiles/<id>, the id comes from the name', () => {
  const r = P.addProfile(storeOf(), { name: 'Client Work!', colour: '#4caf6a' }, { home: HOME });
  assert.strictEqual(r.error, undefined);
  const added = r.store.profiles[0];
  assert.strictEqual(added.id, 'client-work');
  assert.strictEqual(added.name, 'Client Work!');
  assert.strictEqual(added.configDir, path.join(HOME, '.claude-profiles', 'client-work'));
  assert.strictEqual(r.profile.id, 'client-work');
});

test('addProfile: ids stay unique (a name that slugs to a taken id gets a suffix) and never the reserved default', () => {
  let store = storeOf();
  for (let i = 0; i < 3; i++) store = P.addProfile(store, { name: 'Work', colour: '#4caf6a' }, { home: HOME }).store;
  assert.deepStrictEqual(store.profiles.map(p => p.id), ['work', 'work-2', 'work-3']);
  const d = P.addProfile(storeOf(), { name: 'Default', colour: '#4caf6a' }, { home: HOME });
  assert.notStrictEqual(d.profile.id, 'default');
  const symbols = P.addProfile(storeOf(), { name: '!!!', colour: '#4caf6a' }, { home: HOME });
  assert.match(symbols.profile.id, /^[a-z0-9][a-z0-9-]*$/);
});

test('addProfile refuses a bad name or colour, and a folder another profile or the default already uses', () => {
  const store = storeOf(prof());
  assert.match(P.addProfile(store, { name: ' ', colour: '#4caf6a' }, { home: HOME }).error, /name/);
  assert.match(P.addProfile(store, { name: 'N', colour: 'green' }, { home: HOME }).error, /colour/);
  assert.match(P.addProfile(store, { name: 'N', colour: '#4caf6a', configDir: prof().configDir.toUpperCase() }, { home: HOME }).error, /already/);
  assert.match(P.addProfile(store, { name: 'N', colour: '#4caf6a', configDir: path.join(HOME, '.claude') }, { home: HOME }).error, /default/);
  assert.match(P.addProfile(store, { name: 'N', colour: '#4caf6a', configDir: 'rel' }, { home: HOME }).error, /absolute|folder/);
});

test('renameProfile changes only the name; the default and unknown ids refuse', () => {
  const store = storeOf(prof());
  const r = P.renameProfile(store, 'work', '  Client  ');
  assert.strictEqual(r.store.profiles[0].name, 'Client');
  assert.strictEqual(r.store.profiles[0].configDir, prof().configDir);
  assert.ok(P.renameProfile(store, 'default', 'X').error);
  assert.ok(P.renameProfile(store, 'ghost', 'X').error);
  assert.ok(P.renameProfile(store, 'work', '').error);
});

test('removeProfile refuses while a tab uses it, refuses the default, and never names a folder to delete', () => {
  const store = storeOf(prof(), prof({ id: 'play', name: 'Play', configDir: path.join(HOME, 'play') }));
  assert.match(P.removeProfile(store, 'work', new Set(['work'])).error, /in use|using/);
  assert.ok(P.removeProfile(store, 'default', new Set()).error);
  assert.ok(P.removeProfile(store, 'ghost', new Set()).error);
  const r = P.removeProfile(store, 'work', new Set(['play']));
  assert.deepStrictEqual(r.store.profiles.map(p => p.id), ['play']);
  assert.strictEqual(r.removed.configDir, prof().configDir);
});

test('choice memory: the tab\'s own remembered profile wins, then the project\'s last used, else default', () => {
  const store = storeOf(prof(), prof({ id: 'play', name: 'Play', configDir: path.join(HOME, 'play') }));
  let c = P.emptyChoices();
  assert.strictEqual(P.chooseFor(c, store, { worktree: 'c:\\p\\dev', project: 'c:\\p' }), 'default');
  c = P.remember(c, { worktree: 'c:\\p\\dev', project: 'c:\\p' }, 'work');
  assert.strictEqual(P.chooseFor(c, store, { worktree: 'c:\\p\\dev', project: 'c:\\p' }), 'work');
  // a sibling worktree with no choice of its own inherits the project's last used
  assert.strictEqual(P.chooseFor(c, store, { worktree: 'c:\\p\\feat-a', project: 'c:\\p' }), 'work');
  c = P.remember(c, { worktree: 'c:\\p\\feat-a', project: 'c:\\p' }, 'play');
  assert.strictEqual(P.chooseFor(c, store, { worktree: 'c:\\p\\feat-a', project: 'c:\\p' }), 'play');
  assert.strictEqual(P.chooseFor(c, store, { worktree: 'c:\\p\\dev', project: 'c:\\p' }), 'work');
  assert.strictEqual(P.chooseFor(c, store, { worktree: 'c:\\other\\dev', project: 'c:\\other' }), 'default');
});

test('choice memory: a remembered id that was removed falls back to default, never to a dangling id', () => {
  let c = P.remember(P.emptyChoices(), { worktree: 'c:\\p\\dev', project: 'c:\\p' }, 'gone');
  assert.strictEqual(P.chooseFor(c, storeOf(prof()), { worktree: 'c:\\p\\dev', project: 'c:\\p' }), 'default');
});

test('choices file round-trips; a bad file reads as bad, not as empty', () => {
  const dir = tmp();
  const file = path.join(dir, 'profile-choices.json');
  assert.strictEqual(P.readChoices(file).state, 'missing');
  const c = P.remember(P.emptyChoices(), { worktree: 'c:\\p\\dev', project: 'c:\\p' }, 'work');
  P.writeChoices(file, c);
  assert.deepStrictEqual(P.readChoices(file).choices, c);
  fs.writeFileSync(file, '[[');
  assert.strictEqual(P.readChoices(file).state, 'bad');
});

test('parseChoices keeps only string ids, so a hand-edited file cannot inject a non-string', () => {
  const r = P.parseChoices(JSON.stringify({ version: 1, byWorktree: { a: 'x', b: 5, c: null }, byProject: { p: 'y', q: {} } }));
  assert.deepStrictEqual(r.choices.byWorktree, { a: 'x' });
  assert.deepStrictEqual(r.choices.byProject, { p: 'y' });
});

// --- properties --------------------------------------------------------------------------------------------------------
const hexArb = fc.integer({ min: 0, max: 0xffffff }).map(n => `#${n.toString(16).padStart(6, '0')}`);
const nameArb = fc.string({ minLength: 1, maxLength: 40 }).filter(s => s.trim().length > 0 && s.trim().length <= 40);

test('property: any profile addProfile accepts round-trips through the file unchanged', () => {
  fc.assert(fc.property(fc.array(fc.record({ name: nameArb, colour: hexArb }), { maxLength: 6 }), (specs) => {
    let store = { version: 1, profiles: [] };
    for (const s of specs) {
      const r = P.addProfile(store, s, { home: HOME });
      assert.strictEqual(r.error, undefined, r.error);
      store = r.store;
    }
    const again = P.parseStore(JSON.stringify(store));
    assert.strictEqual(again.state, 'ok');
    assert.deepStrictEqual(again.store, store);
    assert.strictEqual(new Set(store.profiles.map(p => p.id)).size, store.profiles.length);
    assert.strictEqual(new Set(store.profiles.map(p => p.configDir.toLowerCase())).size, store.profiles.length);
    for (const p of store.profiles) assert.strictEqual(P.validateProfile(p), null);
  }), { numRuns: 200 });
});

test('property: parseStore never throws and only ever returns valid profiles, whatever the file holds', () => {
  fc.assert(fc.property(fc.oneof(fc.string(), fc.json(), fc.constant(null)), (text) => {
    const r = P.parseStore(text);
    assert.ok(['ok', 'missing', 'bad'].includes(r.state));
    if (r.state === 'ok') for (const p of r.store.profiles) assert.strictEqual(P.validateProfile(p), null);
  }), { numRuns: 300 });
});
