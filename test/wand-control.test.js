'use strict';
/**
 * host/wand-control.js: the host's side of the wand's protocol (BACKLOG #51), over the REAL store in a
 * temp dir wherever the file matters, and a hand-made one where a failure has to be forced.
 *
 *   hello         carries `wand: payload()`
 *   wand-add / wand-update / wand-delete / wand-move / wand-skills     client -> host
 *   wand          the answer, BROADCAST to every window
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('./tmp-dir');
const { createStore } = require('../host/store');
const { createWandControl, STORE_KEY } = require('../host/wand-control');
const wand = require('../host/wand');

const SKILLS = { skills: [
  { name: 'bedtime', description: 'Overnight.', source: 'user' },
  { name: 'checkpoint', description: 'Wrap up.', source: 'user' },
  { name: 'merged', description: 'After a merge.', source: 'user' },
  { name: 'brainstorming', description: 'Ideas.', source: 'user' },
], skipped: [] };

function setup(over = {}) {
  const dir = tmpDir('cc-wc-');
  const store = createStore({ dir });
  let found = over.skills || SKILLS;
  const control = createWandControl({ store, readSkills: () => found, ...over.control });
  return { dir, store, control, file: path.join(dir, `${STORE_KEY}.json`), setSkills: (s) => { found = s; } };
}

test('the store key is "wand": .harness/state/wand.json', () => {
  assert.strictEqual(STORE_KEY, 'wand');
});

test('payload: a missing file is the default set, status missing, with the skill list; nothing is written', () => {
  const { control, file } = setup();
  const p = control.payload();
  assert.strictEqual(p.status, 'missing');
  assert.deepStrictEqual(p.favourites, wand.defaultFavourites());
  assert.strictEqual(p.unavailable, null);
  assert.deepStrictEqual(p.skills, SKILLS.skills);
  assert.ok(!fs.existsSync(file), 'looking is not writing');
});

test('payload: a corrupt file is unavailable with the reason and NO favourites, and the file is left alone', () => {
  const { control, file } = setup();
  fs.writeFileSync(file, '{ this is not json');
  const p = control.payload();
  assert.strictEqual(p.status, 'unavailable');
  assert.strictEqual(p.favourites, null);
  assert.match(p.unavailable, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ this is not json');
});

test('an edit on a corrupt file is REFUSED and never writes over it', () => {
  const { control, file } = setup();
  fs.writeFileSync(file, '{ this is not json');
  const f = control.handle({ type: 'wand-add', emoji: '🚀', skill: 'checkpoint' });
  assert.strictEqual(f.type, 'wand');
  assert.strictEqual(f.ok, false);
  assert.match(f.reason, /nothing was changed/i);
  assert.strictEqual(f.status, 'unavailable');
  assert.strictEqual(f.favourites, null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ this is not json');
});

test('an UNREADABLE file (not just corrupt) is refused the same way', () => {
  const store = {
    readState: () => ({ status: 'unreadable', value: null, error: Object.assign(new Error('locked'), { code: 'EBUSY' }) }),
    write: () => { throw new Error('must not write'); },
  };
  const control = createWandControl({ store, readSkills: () => SKILLS });
  const f = control.handle({ type: 'wand-delete', id: 'f1' });
  assert.strictEqual(f.ok, false);
  assert.match(f.unavailable, /EBUSY/);
  assert.strictEqual(f.favourites, null);
});

test('add: writes the WHOLE set (defaults included, on first edit) and answers with it', () => {
  const { control, file } = setup();
  const f = control.handle({ type: 'wand-add', emoji: '🚀', skill: 'checkpoint', args: 'now' });
  assert.strictEqual(f.ok, true);
  assert.strictEqual(f.reason, null);
  assert.strictEqual(f.status, 'ok');
  assert.strictEqual(f.favourites.length, 5);
  assert.deepStrictEqual(f.favourites[4], { id: 'f5', emoji: '🚀', skill: 'checkpoint', args: 'now' });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.version, 1);
  assert.deepStrictEqual(onDisk.favourites, f.favourites);
  assert.strictEqual(f.quiet, undefined, 'an answer is never quiet: a refusal must stay visible');
});

test('update / delete / move each write and answer; the file is what the frame says', () => {
  const { control, file } = setup();
  let f = control.handle({ type: 'wand-update', id: 'f2', patch: { emoji: '🚀', args: 'x' } });
  assert.strictEqual(f.ok, true);
  assert.deepStrictEqual(f.favourites[1], { id: 'f2', emoji: '🚀', skill: 'checkpoint', args: 'x' });
  f = control.handle({ type: 'wand-delete', id: 'f1' });
  assert.deepStrictEqual(f.favourites.map(x => x.id), ['f2', 'f3', 'f4']);
  f = control.handle({ type: 'wand-move', id: 'f4', target: 'f2' });
  assert.deepStrictEqual(f.favourites.map(x => x.id), ['f4', 'f2', 'f3']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).favourites.map(x => x.id), ['f4', 'f2', 'f3']);
});

test('deleting the last favourite writes a real empty list, which is OK and not unavailable', () => {
  const { control, file } = setup();
  for (const id of ['f1', 'f2', 'f3', 'f4']) control.handle({ type: 'wand-delete', id });
  const p = control.payload();
  assert.strictEqual(p.status, 'ok');
  assert.deepStrictEqual(p.favourites, []);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, favourites: [] });
});

test('a refusal (bad emoji, unknown id, bad index) carries the reason and the TRUE favourites, writes nothing', () => {
  const { control, file } = setup();
  control.handle({ type: 'wand-add', emoji: '🚀', skill: 'merged' });
  const before = fs.readFileSync(file, 'utf8');
  for (const msg of [
    { type: 'wand-add', emoji: 'rocket', skill: 'merged' },
    { type: 'wand-update', id: 'nope', patch: { emoji: '🚀' } },
    { type: 'wand-update', id: 'f1', patch: { skill: 'a b' } },
    { type: 'wand-delete', id: 'nope' },
    { type: 'wand-move', id: 'f1', target: 'nope' },
  ]) {
    const f = control.handle(msg);
    assert.strictEqual(f.ok, false, JSON.stringify(msg));
    assert.ok(f.reason && f.reason.length > 0);
    assert.strictEqual(f.favourites.length, 5);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'file untouched');
  }
});

test('junk messages never throw and are refused', () => {
  const { control } = setup();
  for (const msg of [undefined, null, 5, 'x', {}, { type: 'wand-add' }, { type: 'wand-update' }, { type: 'wand-update', id: 'f1', patch: 5 },
    { type: 'wand-move', id: 'f1' }, { type: 'wand-other' }, { type: 'wand-add', emoji: {}, skill: [] }]) {
    let f;
    assert.doesNotThrow(() => { f = control.handle(msg); }, JSON.stringify(msg));
    assert.strictEqual(f.type, 'wand');
    assert.strictEqual(f.ok, false, JSON.stringify(msg));
  }
});

test('the file is re-read on every message, never cached: another host\'s edit is not erased by ours', () => {
  const { control, store } = setup();
  control.handle({ type: 'wand-add', emoji: '🚀', skill: 'merged' });
  // another host adds one while this host's windows are idle
  const other = createWandControl({ store, readSkills: () => SKILLS });
  other.handle({ type: 'wand-add', emoji: '🎯', skill: 'bedtime' });
  const f = control.handle({ type: 'wand-add', emoji: '🧪', skill: 'checkpoint' });
  assert.deepStrictEqual(f.favourites.map(x => x.emoji), ['🌙', '✅', '🔀', '💡', '🚀', '🎯', '🧪']);
});

test('a failed write is a refusal that says so, the list unchanged, and no stray temp file', () => {
  const { dir, store } = setup();
  const failing = { ...store, write: () => { throw new Error('disk full'); } };
  const control = createWandControl({ store: failing, readSkills: () => SKILLS });
  const f = control.handle({ type: 'wand-add', emoji: '🚀', skill: 'merged' });
  assert.strictEqual(f.ok, false);
  assert.match(f.reason, /disk full/);
  assert.strictEqual(f.favourites.length, 4, 'the frame is the truth: nothing was added');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp')), []);
});

test('a lock that could not be taken is a refusal, not a crash', () => {
  const { store } = setup();
  const locked = { ...store, withLock: () => { throw new Error('lock deadline'); } };
  const control = createWandControl({ store: locked, readSkills: () => SKILLS });
  const f = control.handle({ type: 'wand-add', emoji: '🚀', skill: 'merged' });
  assert.strictEqual(f.ok, false);
  assert.match(f.reason, /lock deadline/);
});

test('the read-modify-write happens INSIDE the lock', () => {
  const { store } = setup();
  const events = [];
  const spy = {
    ...store,
    readState: (...a) => { events.push('read'); return store.readState(...a); },
    write: (...a) => { events.push('write'); return store.write(...a); },
    withLock: (name, fn) => { events.push('lock'); const r = store.withLock(name, fn); events.push('unlock'); return r; },
  };
  const control = createWandControl({ store: spy, readSkills: () => SKILLS });
  events.length = 0;
  control.handle({ type: 'wand-add', emoji: '🚀', skill: 'merged' });
  const lockAt = events.indexOf('lock');
  const unlockAt = events.indexOf('unlock');
  const writeAt = events.indexOf('write');
  assert.ok(lockAt !== -1 && writeAt > lockAt && writeAt < unlockAt, events.join(','));
  assert.ok(events.indexOf('read', lockAt) !== -1 && events.indexOf('read', lockAt) < writeAt, 'it re-reads once it holds the lock');
});

test('a store without readState or withLock (a plain double) still works', () => {
  const mem = new Map();
  const store = { read: (k, fb) => (mem.has(k) ? mem.get(k) : fb), write: (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); return v; } };
  const control = createWandControl({ store, readSkills: () => SKILLS });
  assert.strictEqual(control.payload().status, 'missing');
  const f = control.handle({ type: 'wand-add', emoji: '🚀', skill: 'merged' });
  assert.strictEqual(f.ok, true);
  assert.strictEqual(control.payload().favourites.length, 5);
});

// --- skills --------------------------------------------------------------------------------------

test('wand-skills rescans and answers with the fresh list; payload() reads it once and caches it', () => {
  let scans = 0;
  const store = createStore({ dir: tmpDir('cc-wc-') });
  const control = createWandControl({ store, readSkills: () => { scans++; return SKILLS; } });
  control.payload(); control.payload(); control.payload();
  assert.strictEqual(scans, 1, 'a hello is not a rescan');
  const f = control.handle({ type: 'wand-skills' });
  assert.strictEqual(scans, 2);
  assert.strictEqual(f.ok, true);
  assert.deepStrictEqual(f.skills, SKILLS.skills);
});

test('skillsChanged: a quiet frame only when the list really changed', () => {
  const { control, setSkills } = setup();
  control.payload();
  assert.strictEqual(control.skillsChanged(), null, 'same list: nothing to say');
  setSkills({ skills: [...SKILLS.skills, { name: 'new-one', description: '', source: 'user' }], skipped: [] });
  const f = control.skillsChanged();
  assert.strictEqual(f.quiet, true);
  assert.strictEqual(f.ok, true);
  assert.ok(f.skills.some(s => s.name === 'new-one'));
  assert.strictEqual(control.skillsChanged(), null, 'said once');
});

test('a throwing skill reader is an empty list with a reason, not a dead wand', () => {
  const store = createStore({ dir: tmpDir('cc-wc-') });
  const control = createWandControl({ store, readSkills: () => { throw new Error('EACCES'); } });
  const p = control.payload();
  assert.deepStrictEqual(p.skills, []);
  assert.match(p.skillsError, /EACCES/);
  assert.strictEqual(p.status, 'missing', 'the favourites still show');
});

test('a skill list that could not be read is NOT "no skills": it says so, so nothing looks missing', () => {
  const store = createStore({ dir: tmpDir('cc-wc-') });
  const control = createWandControl({ store, readSkills: () => { throw new Error('boom'); } });
  assert.strictEqual(control.payload().skillsError, 'boom');
  const ok = createWandControl({ store, readSkills: () => SKILLS });
  assert.strictEqual(ok.payload().skillsError, null);
});

// --- another host wrote ------------------------------------------------------------------------------

test('changed(): null when nothing the windows show is wrong; a QUIET frame when another host wrote', () => {
  const { control, store } = setup();
  control.payload();
  assert.strictEqual(control.changed(), null);
  const other = createWandControl({ store, readSkills: () => SKILLS });
  other.handle({ type: 'wand-add', emoji: '🚀', skill: 'merged' });
  const f = control.changed();
  assert.strictEqual(f.type, 'wand');
  assert.strictEqual(f.quiet, true, 'an echo must never touch a refusal on screen');
  assert.strictEqual(f.favourites.length, 5);
  assert.strictEqual(control.changed(), null, 'said once');
});

test('changed(): our OWN write is not announced back as news', () => {
  const { control } = setup();
  control.payload();
  control.handle({ type: 'wand-add', emoji: '🚀', skill: 'merged' });
  assert.strictEqual(control.changed(), null);
});

test('changed(): a file that went corrupt IS announced (quiet), a transiently unreadable one is not', () => {
  const { control, file } = setup();
  control.handle({ type: 'wand-add', emoji: '🚀', skill: 'merged' });
  fs.writeFileSync(file, 'garbage');
  const f = control.changed();
  assert.strictEqual(f.quiet, true);
  assert.strictEqual(f.status, 'unavailable');
  assert.strictEqual(f.favourites, null);

  const store = { readState: () => ({ status: 'unreadable', error: { code: 'EBUSY' } }), write() {} };
  const busy = createWandControl({ store, readSkills: () => SKILLS });
  assert.strictEqual(busy.changed(), null, 'a rename in flight must not flash "wand unavailable"');
});

test('hello is not news: payload() does not mark the windows as told', () => {
  const { control, store } = setup();
  const other = createWandControl({ store, readSkills: () => SKILLS });
  other.handle({ type: 'wand-add', emoji: '🚀', skill: 'merged' });
  control.payload();                       // a window attaching learns it...
  assert.ok(control.changed(), '...but the windows already open have not');
});

test('changed() never throws, even when the store does', () => {
  const store = { readState: () => { throw new Error('x'); }, write() {} };
  const control = createWandControl({ store, readSkills: () => SKILLS });
  assert.doesNotThrow(() => control.changed());
});

test('createWandControl needs a store, and says so', () => {
  assert.throws(() => createWandControl({}), /store is required/);
  assert.throws(() => createWandControl(), /store is required/);
  assert.throws(() => createWandControl({ store: {} }), /readSkills is required/);
});

// --- Dexter D1: the control turns unread sources into skillsError ---------------------------------

test('D1: when discovery could not look at something, skillsError says so and nothing may be called missing', () => {
  const store = createStore({ dir: tmpDir('cc-wc-') });
  const control = createWandControl({ store, readSkills: () => ({ skills: [], skipped: [], unread: [{ file: 'C:/h/.claude/skills', reason: 'could not read (EPERM)' }, { file: 'x', reason: 'could not read (EBUSY)' }] }) });
  const p = control.payload();
  assert.match(p.skillsError, /skills/);
  assert.match(p.skillsError, /EPERM/);
  assert.match(p.skillsError, /1 more/);
  const none = createWandControl({ store, readSkills: () => ({ skills: [], skipped: [], unread: [] }) });
  assert.strictEqual(none.payload().skillsError, null);
});

// --- Miguel S4: a skill that is fixed and breaks again is logged again ------------------------------

test('S4: a skipped skill is logged once per breakage: fixed, then broken again, it is logged again', () => {
  const lines = [];
  let skipped = [{ file: 'a/SKILL.md', reason: 'SKILL.md has no name in its frontmatter' }];
  const store = createStore({ dir: tmpDir('cc-wc-') });
  const control = createWandControl({ store, log: l => lines.push(l), readSkills: () => ({ skills: [], skipped, unread: [] }) });
  control.payload();
  control.handle({ type: 'wand-skills' });
  assert.strictEqual(lines.length, 1, 'the same breakage is not repeated by a rescan');
  skipped = [];
  control.handle({ type: 'wand-skills' });
  skipped = [{ file: 'a/SKILL.md', reason: 'SKILL.md has no name in its frontmatter' }];
  control.handle({ type: 'wand-skills' });
  assert.strictEqual(lines.length, 2, 'broken again: said again');
  assert.match(lines[0], /\[wand\] skipped a\/SKILL\.md/);
});

test('S4: unread sources are logged too, once per breakage', () => {
  const lines = [];
  const store = createStore({ dir: tmpDir('cc-wc-') });
  const control = createWandControl({ store, log: l => lines.push(l), readSkills: () => ({ skills: [], skipped: [], unread: [{ file: 'p', reason: 'could not read (EPERM)' }] }) });
  control.payload(); control.handle({ type: 'wand-skills' });
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /could not read p/);
});

// --- Dexter D2 / Miguel I1: what the wand could not read is never erased by an edit -----------------------

test('D2/I1: while the file holds favourites that did not load, EVERY edit is refused and the file is untouched', () => {
  const { control, file } = setup();
  const raw = JSON.stringify({ version: 1, favourites: [
    { id: 'a', emoji: '\u{1F642}\u{1F642}', skill: 'tdd', args: '' },     // two emoji: dropped by load()
    { id: 'f1', emoji: '\u{1F319}', skill: 'bedtime', args: '' },
  ] });
  fs.writeFileSync(file, raw);
  const p = control.payload();
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.dropped, 1);
  for (const msg of [
    { type: 'wand-delete', id: 'f1' },
    { type: 'wand-add', emoji: '\u{1F680}', skill: 'merged' },
    { type: 'wand-update', id: 'f1', patch: { emoji: '\u{1F680}' } },
    { type: 'wand-move', id: 'f1', target: 'f1' },
  ]) {
    const f = control.handle(msg);
    assert.strictEqual(f.ok, false, JSON.stringify(msg));
    assert.match(f.reason, /aren't valid|isn't valid/);
    assert.match(f.reason, /nothing was changed/i);
    assert.strictEqual(f.dropped, 1, 'the frame still says so');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), raw, 'the hand-typed entry is still in the file');
  }
});

test('D2/I1: once the file is fixed (nothing dropped) edits work again', () => {
  const { control, file } = setup();
  fs.writeFileSync(file, JSON.stringify({ version: 1, favourites: [{ id: 'a', emoji: 'no', skill: 'tdd', args: '' }] }));
  assert.strictEqual(control.handle({ type: 'wand-add', emoji: '\u{1F680}', skill: 'merged' }).ok, false);
  fs.writeFileSync(file, JSON.stringify({ version: 1, favourites: [{ id: 'a', emoji: '\u{1F680}', skill: 'tdd', args: '' }] }));
  assert.strictEqual(control.handle({ type: 'wand-add', emoji: '\u{1F680}', skill: 'merged' }).ok, true);
});

test('the payload names the file, so the panel can show where it is (Miguel I2)', () => {
  const { control, file } = setup();
  assert.strictEqual(control.payload().file, file);
  const noPath = createWandControl({ store: { read: () => undefined, write() {} }, readSkills: () => ({ skills: [] }) });
  assert.strictEqual(noPath.payload().file, null);
});

// --- Dexter D6: a momentary unreadable file is retried, never shown as "fix or delete" ----------------------

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
// A store whose reads follow a script: each readState() takes the next entry; the last repeats.
function scripted(entries) {
  let i = 0;
  const reads = () => i;
  return {
    reads,
    readState: () => { const e = entries[Math.min(i, entries.length - 1)]; i++; return typeof e === 'function' ? e() : e; },
    write() {},
    pathOf: () => 'C:/state/wand.json',
  };
}
const okState = (favs) => ({ status: 'ok', value: { version: 1, favourites: favs } });
const BUSY = { status: 'unreadable', value: null, error: Object.assign(new Error('busy'), { code: 'EBUSY' }) };
const fv = (id, emoji, skill) => ({ id, emoji, skill, args: '' });

test('D6 A: another host\'s edit read as EBUSY is RETRIED, and the new favourites arrive without a second fs event', async () => {
  const store = scripted([okState([fv('f1', '\u{1F319}', 'bedtime')]), BUSY, okState([fv('f1', '\u{1F319}', 'bedtime'), fv('f2', '\u{1F680}', 'merged')])]);
  const frames = [];
  const control = createWandControl({ store, readSkills: () => SKILLS, emit: f => frames.push(f), retryMs: 15 });
  assert.strictEqual(control.changed(), null, 'busy: nothing to say yet');
  await sleepMs(150);
  assert.strictEqual(frames.length, 1, 'the retry found the new file and said so');
  assert.strictEqual(frames[0].quiet, true);
  assert.deepStrictEqual(frames[0].favourites.map(f => f.id), ['f1', 'f2']);
});

test('D6: retries are bounded: a file that stays unreadable is not polled for ever, and says nothing', async () => {
  const store = scripted([okState([fv('f1', '\u{1F319}', 'bedtime')]), BUSY]);
  const frames = [];
  const control = createWandControl({ store, readSkills: () => SKILLS, emit: f => frames.push(f), retryMs: 5, maxRetries: 4 });
  control.changed();
  await sleepMs(250);
  assert.deepStrictEqual(frames, []);
  assert.ok(store.reads() <= 1 + 1 + 4 + 1, 'reads: ' + store.reads());
});

test('D6 B: a window attaching during a busy read gets the LAST GOOD favourites, not "unavailable"', () => {
  const store = scripted([okState([fv('f1', '\u{1F319}', 'bedtime')]), okState([fv('f1', '\u{1F319}', 'bedtime')]), BUSY]);
  const control = createWandControl({ store, readSkills: () => SKILLS });
  const healthy = control.payload();                       // a good read: remembered
  assert.strictEqual(healthy.status, 'ok');
  const during = control.payload();                        // busy
  assert.strictEqual(during.status, 'ok');
  assert.deepStrictEqual(during.favourites, healthy.favourites);
  assert.strictEqual(during.unavailable, null);
});

test('D6 B: a skills-only frame during a busy read keeps the last good favourites too (no editor thrown away)', () => {
  const store = scripted([okState([fv('f1', '\u{1F319}', 'bedtime')]), okState([fv('f1', '\u{1F319}', 'bedtime')]), BUSY]);
  let list = SKILLS;
  const control = createWandControl({ store, readSkills: () => list });
  control.payload();
  list = { skills: [...SKILLS.skills, { name: 'x', description: '', source: 'user' }], skipped: [] };
  const f = control.skillsChanged();
  assert.strictEqual(f.status, 'ok');
  assert.strictEqual(f.favourites.length, 1);
  assert.ok(f.skills.some(s => s.name === 'x'));
});

test('D6: with no good read yet, a busy file is "unavailable" but marked as RETRYING, and heals when it can be read', async () => {
  const store = scripted([BUSY, BUSY, okState([fv('f1', '\u{1F319}', 'bedtime')])]);
  const frames = [];
  const control = createWandControl({ store, readSkills: () => SKILLS, emit: f => frames.push(f), retryMs: 15 });
  const p = control.payload();
  assert.strictEqual(p.status, 'unavailable');
  assert.strictEqual(p.retrying, true);
  await sleepMs(200);
  assert.ok(frames.length >= 1, 'the healthy read is announced');
  assert.strictEqual(frames[frames.length - 1].status, 'ok');
  assert.strictEqual(frames[frames.length - 1].retrying, false);
});

test('D6: an edit during a busy read is refused with "try again", and the frame is the last good state', () => {
  const store = scripted([okState([fv('f1', '\u{1F319}', 'bedtime')]), BUSY]);
  const control = createWandControl({ store, readSkills: () => SKILLS });
  const f = control.handle({ type: 'wand-delete', id: 'f1' });
  assert.strictEqual(f.ok, false);
  assert.match(f.reason, /try again/i);
  assert.strictEqual(f.status, 'ok');
  assert.strictEqual(f.favourites.length, 1);
});

// --- Dexter D4: answers echo the request id ------------------------------------------------------------------

test('D4: every answer to an edit, success or refusal, echoes the request id', () => {
  const { control } = setup();
  assert.strictEqual(control.handle({ type: 'wand-add', emoji: '\u{1F680}', skill: 'merged', req: 'w1-1' }).req, 'w1-1');
  assert.strictEqual(control.handle({ type: 'wand-delete', id: 'nope', req: 'w1-2' }).req, 'w1-2');
  assert.strictEqual(control.handle({ type: 'wand-other', req: 'w1-3' }).req, 'w1-3');
  assert.strictEqual(control.handle({ type: 'wand-add', emoji: 'x', skill: 'a' }).req, undefined, 'no id asked, none echoed');
});

test('D4: a request id that is not a short string is not echoed (it is only a label)', () => {
  const { control } = setup();
  for (const req of [5, {}, [], null, 'x'.repeat(200)]) assert.strictEqual(control.handle({ type: 'wand-delete', id: 'f1', req }).req, undefined, String(req).slice(0, 10));
});

test('D4: the answer to wand-skills is QUIET: it is not the answer to anyone\'s edit', () => {
  const { control } = setup();
  const f = control.handle({ type: 'wand-skills', req: 'w1-9' });
  assert.strictEqual(f.quiet, true);
  assert.strictEqual(f.req, undefined);
});

// --- Dexter D9: a reorder names the target by id, so a stale view cannot misplace it --------------------------

test('D9: wand-move names the TARGET by id: against a list another host has changed, it lands where it was dropped', () => {
  const { control, file } = setup();
  for (const id of ['f1']) control.handle({ type: 'wand-delete', id });      // another host deleted the first one: [f2,f3,f4]
  const f = control.handle({ type: 'wand-move', id: 'f4', target: 'f2' });
  assert.deepStrictEqual(f.favourites.map(x => x.id), ['f4', 'f2', 'f3']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).favourites.map(x => x.id), ['f4', 'f2', 'f3']);
});

test('D9: a target that no longer exists is a refusal, and an index (the old protocol) moves nothing', () => {
  const { control } = setup();
  const f = control.handle({ type: 'wand-move', id: 'f1', target: 'gone' });
  assert.strictEqual(f.ok, false);
  assert.match(f.reason, /no longer exists/);
  assert.strictEqual(control.handle({ type: 'wand-move', id: 'f1', to: 2 }).ok, false);
});

// --- Miguel I2: Reset wand moves a bad file ASIDE, never deletes it ----------------------------------------------

test('I2: reset moves a corrupt file to wand.json.bad-<timestamp>, byte for byte, and starts from the default set', () => {
  const dir = tmpDir('cc-wc-');
  const store = createStore({ dir });
  const file = path.join(dir, 'wand.json');
  fs.writeFileSync(file, '{ this is the only copy');
  const control = createWandControl({ store, readSkills: () => SKILLS, now: () => new Date('2026-10-03T12:34:56.789Z') });
  const f = control.handle({ type: 'wand-reset', req: 'w-1' });
  assert.strictEqual(f.ok, true);
  assert.strictEqual(f.req, 'w-1');
  assert.strictEqual(f.status, 'missing', 'the default set is showing');
  assert.deepStrictEqual(f.favourites, wand.defaultFavourites());
  assert.strictEqual(f.movedTo, path.join(dir, 'wand.json.bad-2026-10-03T12-34-56-789Z'));
  assert.strictEqual(fs.readFileSync(f.movedTo, 'utf8'), '{ this is the only copy', 'nothing was deleted');
  assert.ok(!fs.existsSync(file), 'the bad file is out of the way');
});

test('I2: reset also covers a file of the wrong shape or a newer version', () => {
  for (const content of ['[]', '{"version":2,"favourites":[]}', '{"version":1}']) {
    const { control, file } = setup();
    fs.writeFileSync(file, content);
    const f = control.handle({ type: 'wand-reset' });
    assert.strictEqual(f.ok, true, content);
    assert.strictEqual(fs.readFileSync(f.movedTo, 'utf8'), content);
  }
});

test('I2: two resets in one second do not overwrite each other\'s backup', () => {
  const dir = tmpDir('cc-wc-');
  const store = createStore({ dir });
  const file = path.join(dir, 'wand.json');
  const control = createWandControl({ store, readSkills: () => SKILLS, now: () => new Date('2026-10-03T12:00:00.000Z') });
  fs.writeFileSync(file, 'first bad');
  const a = control.handle({ type: 'wand-reset' });
  fs.writeFileSync(file, 'second bad');
  const b = control.handle({ type: 'wand-reset' });
  assert.strictEqual(a.ok && b.ok, true);
  assert.notStrictEqual(a.movedTo, b.movedTo);
  assert.strictEqual(fs.readFileSync(a.movedTo, 'utf8'), 'first bad');
  assert.strictEqual(fs.readFileSync(b.movedTo, 'utf8'), 'second bad');
});

test('I2: reset on a healthy or missing file is refused: there is nothing to set aside', () => {
  const { control, file } = setup();
  assert.strictEqual(control.handle({ type: 'wand-reset' }).ok, false, 'missing');
  control.handle({ type: 'wand-add', emoji: '\u{1F680}', skill: 'merged' });
  const before = fs.readFileSync(file, 'utf8');
  const f = control.handle({ type: 'wand-reset' });
  assert.strictEqual(f.ok, false);
  assert.match(f.reason, /nothing to reset/i);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'a good file is never moved');
});

test('I2: reset on a file that is only BUSY is refused with try-again, never moved', () => {
  const store = scripted([BUSY]);
  const moved = [];
  const control = createWandControl({ store, readSkills: () => SKILLS, fs: { renameSync: (...a) => moved.push(a) } });
  const f = control.handle({ type: 'wand-reset' });
  assert.strictEqual(f.ok, false);
  assert.match(f.reason, /try again/i);
  assert.deepStrictEqual(moved, []);
});

test('I2: a failed move is a refusal that says so, and the file is where it was', () => {
  const dir = tmpDir('cc-wc-');
  const store = createStore({ dir });
  fs.writeFileSync(path.join(dir, 'wand.json'), 'bad');
  const control = createWandControl({ store, readSkills: () => SKILLS, fs: { renameSync: () => { throw new Error('EPERM x'); } } });
  const f = control.handle({ type: 'wand-reset' });
  assert.strictEqual(f.ok, false);
  assert.match(f.reason, /EPERM x/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'wand.json'), 'utf8'), 'bad');
});

test('I2: a store with no path (a test double) cannot reset, and says so', () => {
  const control = createWandControl({ store: { read: () => 5, write() {} }, readSkills: () => SKILLS });
  const f = control.handle({ type: 'wand-reset' });
  assert.strictEqual(f.ok, false);
});
