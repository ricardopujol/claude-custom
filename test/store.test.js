'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../host/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-'));

test('reading an absent file returns the default', () => {
  const s = createStore({ dir: tmp() });
  assert.deepStrictEqual(s.read('loadout', { agents: {} }), { agents: {} });
});

test('writes then reads back', () => {
  const s = createStore({ dir: tmp() });
  s.write('loadout', { agents: { miguel: ['whetstone'] } });
  assert.deepStrictEqual(s.read('loadout', {}), { agents: { miguel: ['whetstone'] } });
});

test('survives a process restart', () => {
  const dir = tmp();
  createStore({ dir }).write('stats', { runs: 3 });
  assert.deepStrictEqual(createStore({ dir }).read('stats', {}), { runs: 3 });
});

test('a corrupt file yields the default instead of throwing', () => {
  // One feature's state must not be able to take the session down. Everything
  // here is regenerable; none of it is worth an exception on a hot path.
  const dir = tmp();
  const s = createStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vault.json'), '{ not json');
  assert.deepStrictEqual(s.read('vault', { bugs: [] }), { bugs: [] });
});

test('one corrupt file does not affect the others', () => {
  // The reason for one file per concern rather than a single blob.
  const dir = tmp();
  const s = createStore({ dir });
  s.write('stats', { runs: 7 });
  fs.writeFileSync(path.join(dir, 'vault.json'), 'garbage');
  assert.deepStrictEqual(s.read('stats', {}), { runs: 7 });
});

test('writes atomically, so a crash mid-write cannot truncate the file', () => {
  // Observed earlier in this project: a hard exit truncated a file to zero
  // bytes straight after a synchronous write. A half-written JSON file reads
  // as corrupt and silently resets whatever feature owned it.
  const dir = tmp();
  const s = createStore({ dir });
  s.write('stats', { a: 1 });
  const before = fs.readFileSync(path.join(dir, 'stats.json'), 'utf8');
  s.write('stats', { a: 2 });
  const after = fs.readFileSync(path.join(dir, 'stats.json'), 'utf8');
  assert.notStrictEqual(before, after);
  assert.deepStrictEqual(JSON.parse(after), { a: 2 });
  // No temp files left lying around.
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => !f.endsWith('.json')), []);
});

test('creates its directory on demand', () => {
  const dir = path.join(tmp(), 'nested', 'deep');
  createStore({ dir }).write('stats', { ok: true });
  assert.ok(fs.existsSync(path.join(dir, 'stats.json')));
});

test('update applies a function to the current value', () => {
  const s = createStore({ dir: tmp() });
  s.write('stats', { runs: 1 });
  s.update('stats', { runs: 0 }, v => ({ runs: v.runs + 1 }));
  assert.strictEqual(s.read('stats', {}).runs, 2);
});

test('update on an absent file starts from the default', () => {
  const s = createStore({ dir: tmp() });
  s.update('stats', { runs: 0 }, v => ({ runs: v.runs + 1 }));
  assert.strictEqual(s.read('stats', {}).runs, 1);
});

test('a name that could escape the store directory is refused', () => {
  // Names may come from feature code and one day from config; a traversal here
  // would write outside the harness directory entirely.
  const dir = tmp();
  const s = createStore({ dir });
  assert.throws(() => s.write('../escape', { x: 1 }), /name/i);
  assert.throws(() => s.read('../../secrets', {}), /name/i);
});

test('exposes the path of a file for other processes to read', () => {
  // The hook helper reads loadout.json itself so items keep working with the
  // GUI closed, and it needs to be told where that is.
  const dir = tmp();
  const s = createStore({ dir });
  assert.strictEqual(s.pathOf('loadout'), path.join(dir, 'loadout.json'));
});

// --- readState: missing is not corrupt ---------------------------------------
//
// Dexter, PR #29 review, F1. `read(name, fallback)` returns the fallback for
// BOTH "no file" and "file exists and did not parse", which is right for every
// consumer this store had when it was written: cooldowns, seats, counters --
// all regenerable, all happy to start over.
//
// The bug vault is the first consumer holding records a user CANNOT
// reconstruct, and it used the absent/corrupt fallback as its "first run"
// signal: `read(KEY, null)` returning null meant seed, so a vault that failed
// to parse once was overwritten with defaults and the evidence was gone.
//
// `read` keeps its defaulting behaviour -- it is correct, and everything else
// depends on it. `readState` is the narrow addition for consumers that must
// fail CLOSED: it reports WHY there is no value, so "there is nothing here"
// and "something is here and I could not read it" stop being the same answer.

test('readState reports a missing file as missing, with no value', () => {
  const s = createStore({ dir: tmp() });
  const r = s.readState('cooldowns');
  assert.strictEqual(r.status, 'missing');
  assert.strictEqual(r.value, null);
});

test('readState reports a corrupt file as corrupt, NOT as missing', () => {
  // The whole point. These two were indistinguishable, and one of them means
  // "it is safe to write defaults over this".
  const dir = tmp();
  const s = createStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cooldowns.json'), '{ not json');
  const r = s.readState('cooldowns');
  assert.strictEqual(r.status, 'corrupt');
  assert.strictEqual(r.value, null);
});

test('readState returns the parsed value when the file is good', () => {
  const s = createStore({ dir: tmp() });
  s.write('cooldowns', { a: 1 });
  assert.deepStrictEqual(s.readState('cooldowns'), { status: 'ok', value: { a: 1 } });
});

test('readState reports a file it cannot open as unreadable, distinct from both', () => {
  // A directory where a file should be: not absent, not corrupt, not readable.
  // Whatever the platform's errno, the one thing it must NOT report is
  // "missing", because that is the status that authorises an overwrite.
  const dir = tmp();
  const s = createStore({ dir });
  fs.mkdirSync(path.join(dir, 'cooldowns.json'), { recursive: true });
  const r = s.readState('cooldowns');
  assert.notStrictEqual(r.status, 'missing');
  assert.notStrictEqual(r.status, 'ok');
});

test('readState still refuses a traversing name rather than reporting it as missing', () => {
  // A path that escapes the store is a programming error and must surface.
  // Reporting it as "missing" would invite the caller to seed defaults into
  // whatever it names.
  const s = createStore({ dir: tmp() });
  assert.throws(() => s.readState('../escape'), /name/i);
});

test('read and readState cannot drift: read returns the fallback for every non-ok status', () => {
  // read() is expressed in terms of readState so there is ONE decision about
  // what counts as readable. This asserts the relationship, not a repeat of
  // the cases above.
  const dir = tmp();
  const s = createStore({ dir });
  fs.mkdirSync(dir, { recursive: true });

  const sentinel = { sentinel: true };
  assert.deepStrictEqual(s.read('cooldowns', sentinel), sentinel, 'missing');

  fs.writeFileSync(path.join(dir, 'cooldowns.json'), 'garbage');
  assert.deepStrictEqual(s.read('cooldowns', sentinel), sentinel, 'corrupt');
  assert.strictEqual(s.readState('cooldowns').status, 'corrupt');

  s.write('cooldowns', { real: 1 });
  assert.deepStrictEqual(s.read('cooldowns', sentinel), { real: 1 }, 'ok');
});
