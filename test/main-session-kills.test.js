'use strict';
/**
 * Kill tests for host/main-session.js (BACKLOG #228; Mortimer's 2026-11-23 audit left 43 survivors, 62.9%).
 *
 * Each test names the guard it pins. Everything runs on an in-memory store (readText / writeText / mkdir injected), so no
 * mutant can hide behind a real file the suite forgot to clean.
 *
 * Equivalent mutants, not killed and not claimed (JSON.parse can only make null, booleans, numbers, strings, arrays and plain
 * objects, and every read sits inside readSessions' try or behind isSessionId):
 *   - readSessions `Array.isArray(raw)` -> false: a parsed array has no `version`, so `raw.version !== 1` still rejects it.
 *   - readSessions `!raw` -> false: `typeof null` is 'object', so null reaches `raw.version`, which throws inside the try -> {}.
 *   - readSessions `typeof raw !== 'object'` -> false: a parsed number/string/boolean has no `version` -> {}.
 *   - readMainSession `typeof e === 'object'` -> true: a parsed non-object entry has no `.id`, so isSessionId rejects it.
 *   - readMainSession `hasOwnProperty(...) ? sessions[key] : null` -> `true ? ...`: the key is an absolute path, never a name on
 *     Object.prototype, so a missing key gives undefined, which the next line already turns into null.
 *   - both `readFileSync(f, 'utf8')` -> `readFileSync(f, '')`: no encoding returns a Buffer, and JSON.parse reads a Buffer as UTF-8.
 *   - recordMainSession's filter `typeof k === 'string'` -> true: Object.entries only ever yields string keys.
 * Measured (one Stryker run on this file, 2026-11-28): 64.66% -> 91.38%; the 10 survivors left are exactly the ones above.
 *   - resumeIdFor `if (id === null) return null` -> `if (false)`: hasTranscript's first line rejects a null id.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { readMainSession, recordMainSession, resumeIdFor } = require('../host/main-session');
const { spellingKey } = require('../host/project-layout');
const { projectDirName } = require('../host/project-dir');

const MAIN_ID = '11111111-aaaa-4bbb-8ccc-000000000001';
const SIDE_ID = '22222222-aaaa-4bbb-8ccc-000000000002';
const THIRD_ID = '33333333-aaaa-4bbb-8ccc-000000000003';
const CWD = path.resolve('C:\\kill228\\proj\\feat-a');
const OTHER = path.resolve('C:\\kill228\\proj\\feat-b');
const FILE = path.resolve('C:\\kill228\\state\\main-sessions.json');
const KEY = spellingKey(CWD);

/** An in-memory store: `text` is the file body (undefined = no file). */
function mem(text) {
  const m = { text, reads: [], writes: [], dirs: [] };
  m.readText = (f) => { m.reads.push(f); if (m.text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return m.text; };
  m.writeText = (f, body) => { m.writes.push(f); m.text = body; };
  m.mkdir = (d) => { m.dirs.push(d); };
  m.json = () => JSON.parse(m.text);
  m.record = (extra = {}) => recordMainSession({ file: FILE, cwd: CWD, sessionId: MAIN_ID, now: () => 1000,
    readText: m.readText, writeText: m.writeText, mkdir: m.mkdir, ...extra });
  return m;
}
const file = (sessions, version = 1) => JSON.stringify({ version, sessions });

test('readSessions: a file whose version is not 1 is not understood, even when its sessions look valid', () => {
  const body = { [KEY]: { id: MAIN_ID, at: 1 } };
  assert.strictEqual(readMainSession(FILE, CWD, { readText: () => file(body, 1) }), MAIN_ID, 'control: version 1 reads');
  for (const v of [2, 0, '1', null]) {
    assert.strictEqual(readMainSession(FILE, CWD, { readText: () => file(body, v) }), null, `version ${JSON.stringify(v)}`);
  }
  assert.strictEqual(readMainSession(FILE, CWD, { readText: () => JSON.stringify({ sessions: body }) }), null, 'no version');
});

test('readSessions: sessions that are null, a string or an array read as none, and a read never throws', () => {
  for (const s of [null, 'x', 7, true, [{ id: MAIN_ID, at: 1 }]]) {
    assert.strictEqual(readMainSession(FILE, CWD, { readText: () => file(s) }), null, JSON.stringify(s));
  }
});

test('readSessions: a string `sessions` is replaced, so the next record still succeeds', () => {
  const m = mem(file('not an object'));
  assert.deepStrictEqual(m.record(), { ok: true });
  assert.deepStrictEqual(Object.keys(m.json().sessions), [KEY]);
});

test('readSessions: an array `sessions` is replaced, never merged in by its index keys', () => {
  const m = mem(file([{ id: SIDE_ID, at: 5000 }]));
  assert.deepStrictEqual(m.record(), { ok: true });
  assert.deepStrictEqual(m.json().sessions, { [KEY]: { id: MAIN_ID, at: 1000 } });
});

test('readMainSession: a null or id-less entry for this folder reads as none, without a throw', () => {
  for (const e of [null, {}, { id: 'short' }, { id: 5 }, 'x', 0]) {
    assert.strictEqual(readMainSession(FILE, CWD, { readText: () => file({ [KEY]: e }) }), null, JSON.stringify(e));
  }
});

test('readMainSession: no file name or no folder -> null, and the store is never read', () => {
  const m = mem(file({ [KEY]: { id: MAIN_ID, at: 1 } }));
  for (const f of [undefined, null, '', 5, {}]) {
    assert.strictEqual(readMainSession(f, CWD, { readText: m.readText }), null, String(f));
  }
  for (const c of [undefined, null, '', 5]) {
    assert.strictEqual(readMainSession(FILE, c, { readText: m.readText }), null, String(c));
  }
  assert.deepStrictEqual(m.reads, [], 'an argument guard answered before any read');
  assert.strictEqual(readMainSession(FILE, CWD, { readText: m.readText }), MAIN_ID, 'control: good arguments read');
  assert.deepStrictEqual(m.reads, [FILE]);
});

test('recordMainSession: no file name or no folder -> "nothing to record", and nothing is read or written', () => {
  for (const f of [undefined, null, '', 5]) {
    const m = mem(undefined);
    assert.deepStrictEqual(m.record({ file: f }), { ok: false, error: 'nothing to record' }, String(f));
    assert.deepStrictEqual([m.reads, m.writes, m.dirs], [[], [], []]);
  }
  for (const c of [undefined, null, '']) {
    const m = mem(undefined);
    assert.deepStrictEqual(m.record({ cwd: c }), { ok: false, error: 'nothing to record' }, String(c));
    assert.deepStrictEqual([m.reads, m.writes, m.dirs], [[], [], []]);
  }
  const m = mem(undefined);
  assert.deepStrictEqual(m.record({ sessionId: 'nope' }), { ok: false, error: 'nothing to record' });
  assert.deepStrictEqual(m.writes, []);
});

test('recordMainSession: junk entries already in the file are dropped, good ones are kept', () => {
  const m = mem(file({ nul: null, bad: { id: 'bad', at: 9 }, noid: { at: 9 }, str: 'x', good: { id: SIDE_ID, at: 5 } }));
  assert.deepStrictEqual(m.record(), { ok: true });
  assert.deepStrictEqual(m.json().sessions, { [KEY]: { id: MAIN_ID, at: 1000 }, good: { id: SIDE_ID, at: 5 } });
});

test('recordMainSession: the file is written newest first, an entry with no usable time ranks last', () => {
  const m = mem(file({ old: { id: SIDE_ID, at: 10 }, notime: { id: THIRD_ID }, nan: { id: THIRD_ID, at: 'soon' }, newer: { id: SIDE_ID, at: 2000 } }));
  m.record();
  const keys = Object.keys(m.json().sessions);
  assert.deepStrictEqual(keys.slice(0, 3), ['newer', KEY, 'old']);
  assert.deepStrictEqual(keys.slice(3).sort(), ['nan', 'notime']);
});

test('recordMainSession: at the bound, the entry with no time is the one dropped', () => {
  const sessions = { notime: { id: THIRD_ID } };
  for (let i = 0; i < 199; i++) sessions[`lane${i}`] = { id: SIDE_ID, at: 10 + i };
  const m = mem(file(sessions));
  m.record();
  const kept = m.json().sessions;
  assert.strictEqual(Object.keys(kept).length, 200);
  assert.strictEqual('notime' in kept, false, 'the timeless entry went');
  assert.strictEqual(kept[KEY].id, MAIN_ID);
  assert.strictEqual(Object.keys(kept)[0], KEY, 'and the new record (at 1000) is first');
});

test('recordMainSession: the body is version 1, pretty-printed, newline-terminated, into the file\'s own folder', () => {
  const m = mem(undefined);
  assert.deepStrictEqual(m.record(), { ok: true });
  assert.deepStrictEqual(m.writes, [FILE]);
  assert.deepStrictEqual(m.dirs, [path.dirname(FILE)]);
  assert.strictEqual(m.text, JSON.stringify({ version: 1, sessions: { [KEY]: { id: MAIN_ID, at: 1000 } } }, null, 2) + '\n');
});

test('recordMainSession: a failure is { ok: false, error }, whatever is thrown', () => {
  const thrown = (v) => mem(undefined).record({ writeText: () => { throw v; } });
  assert.deepStrictEqual(thrown(new Error('disk full')), { ok: false, error: 'disk full' });
  assert.deepStrictEqual(thrown('boom'), { ok: false, error: 'boom' });
  assert.deepStrictEqual(thrown(new Error('')), { ok: false, error: 'Error' });
  assert.deepStrictEqual(thrown(null), { ok: false, error: 'null' });
  assert.deepStrictEqual(mem(undefined).record({ mkdir: () => { throw new Error('EPERM'); } }), { ok: false, error: 'EPERM' });
});

test('recordMainSession: the default clock stamps the record', () => {
  const m = mem(undefined);
  const before = Date.now();
  assert.deepStrictEqual(recordMainSession({ file: FILE, cwd: CWD, sessionId: MAIN_ID, readText: m.readText, writeText: m.writeText, mkdir: m.mkdir }), { ok: true });
  const at = m.json().sessions[KEY].at;
  assert.ok(typeof at === 'number' && at >= before && at <= Date.now(), String(at));
});

test('resumeIdFor: an injected readText is the store it reads, not the disk', () => {
  const projectsDir = path.resolve('C:\\kill228\\.claude\\projects');
  const dir = path.join(projectsDir, projectDirName(CWD));
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n';
  const dirent = (name, isFile) => ({ name, isFile: () => isFile });
  const fsImpl = {
    readdirSync: (d) => {
      if (path.resolve(d) === projectsDir) return [dirent(projectDirName(CWD), false)];
      if (path.resolve(d) === dir) return [dirent(`${MAIN_ID}.jsonl`, true)];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    openSync: () => 3, closeSync: () => {},
    readSync: (fd, buf) => buf.write(line),
  };
  const readText = () => file({ [KEY]: { id: MAIN_ID, at: 1 } });
  assert.strictEqual(resumeIdFor({ file: FILE, cwd: CWD, store: { projectsDir, fsImpl }, readText }), MAIN_ID);
  assert.strictEqual(resumeIdFor({ file: FILE, cwd: OTHER, store: { projectsDir, fsImpl }, readText }), null, 'another folder has none');
});
