'use strict';
/**
 * host/main-session.js (Dexter 1 / Miguel Y4 on PR #250): a lane's main tab resumes ITS OWN conversation, by the session id its host
 * recorded, never by `--continue` (which takes the folder's newest conversation: a side session's, when it wrote last). No recorded
 * id, or no transcript for it in the CLI's store, means a fresh session.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { readMainSession, recordMainSession, resumeIdFor } = require('../host/main-session');
const { hasTranscript } = require('../host/continue-flag');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const MAIN_ID = '11111111-aaaa-4bbb-8ccc-000000000001';
const SIDE_ID = '22222222-aaaa-4bbb-8ccc-000000000002';
const USER_LINE = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n';

function store() {
  const root = tmpDir('cc-mainsession-');
  const cwd = path.join(root, 'proj', 'feat-a');
  const dir = path.join(root, '.claude', 'projects', projectDirName(cwd));
  return {
    cwd, dir, file: path.join(root, 'state', 'main-sessions.json'),
    store: { projectsDir: path.join(root, '.claude', 'projects') },
    put(name, body, mtimeSec) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), body);
      if (mtimeSec) fs.utimesSync(path.join(dir, name), mtimeSec, mtimeSec);
    },
  };
}

test('record then read: the id comes back for that folder, whatever the case or slashes of its path', () => {
  const s = store();
  assert.deepStrictEqual(recordMainSession({ file: s.file, cwd: s.cwd, sessionId: MAIN_ID }), { ok: true });
  assert.strictEqual(readMainSession(s.file, s.cwd), MAIN_ID);
  assert.strictEqual(readMainSession(s.file, s.cwd.toUpperCase()), MAIN_ID);
  assert.strictEqual(readMainSession(s.file, path.join(s.cwd, '..', 'other')), null, 'another folder has none');
});

test('a /clear (a new session id for the same folder) replaces the record', () => {
  const s = store();
  recordMainSession({ file: s.file, cwd: s.cwd, sessionId: MAIN_ID });
  recordMainSession({ file: s.file, cwd: s.cwd, sessionId: SIDE_ID });
  assert.strictEqual(readMainSession(s.file, s.cwd), SIDE_ID);
});

test('nothing is recorded for junk, and nothing is read from a store that is not understood', () => {
  const s = store();
  for (const sessionId of [undefined, null, '', 5, '../x', 'a b', 'short']) {
    assert.strictEqual(recordMainSession({ file: s.file, cwd: s.cwd, sessionId }).ok, false, String(sessionId));
  }
  assert.strictEqual(fs.existsSync(s.file), false);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  for (const bad of ['{ nope', '[]', '{"version":2,"sessions":{}}', '{"version":1,"sessions":[]}']) {
    fs.writeFileSync(s.file, bad);
    assert.strictEqual(readMainSession(s.file, s.cwd), null, bad);
  }
  assert.strictEqual(recordMainSession({ file: s.file, cwd: s.cwd, sessionId: MAIN_ID }).ok, true, 'and the next record rewrites it');
  assert.strictEqual(readMainSession(s.file, s.cwd), MAIN_ID);
});

test('a write that fails is an error answer, never a throw; the record is bounded', () => {
  const s = store();
  assert.strictEqual(recordMainSession({ file: s.file, cwd: s.cwd, sessionId: MAIN_ID, writeText: () => { throw new Error('disk full'); } }).error, 'disk full');
  let t = 0;
  for (let i = 0; i < 230; i++) recordMainSession({ file: s.file, cwd: path.join(s.cwd, `..\\lane${i}`), sessionId: MAIN_ID, now: () => ++t });
  const n = Object.keys(JSON.parse(fs.readFileSync(s.file, 'utf8')).sessions).length;
  assert.strictEqual(n, 200);
  assert.strictEqual(readMainSession(s.file, path.join(s.cwd, '..\\lane229')), MAIN_ID, 'the newest are the ones kept');
});

test('hasTranscript: this id\'s transcript, with a message in it; an id that is not one never matches', () => {
  const s = store();
  assert.strictEqual(hasTranscript(s.cwd, MAIN_ID, s.store), false, 'no store yet');
  s.put(`${MAIN_ID}.jsonl`, USER_LINE);
  assert.strictEqual(hasTranscript(s.cwd, MAIN_ID, s.store), true);
  assert.strictEqual(hasTranscript(s.cwd, SIDE_ID, s.store), false, 'another session\'s id');
  for (const bad of ['../x', '', null, undefined, 'a/b']) assert.strictEqual(hasTranscript(s.cwd, bad, s.store), false, String(bad));
  s.put(`${SIDE_ID}.jsonl`, '');
  assert.strictEqual(hasTranscript(s.cwd, SIDE_ID, s.store), false, 'an empty transcript is not a conversation');
});

test('Dexter 1: a side transcript NEWER than the main\'s -> the main resumes its own id', () => {
  const s = store();
  s.put(`${MAIN_ID}.jsonl`, USER_LINE, 1000);
  s.put(`${SIDE_ID}.jsonl`, USER_LINE, 2000);       // the side session wrote last: --continue would take this one
  recordMainSession({ file: s.file, cwd: s.cwd, sessionId: MAIN_ID });
  assert.strictEqual(resumeIdFor({ file: s.file, cwd: s.cwd, store: s.store }), MAIN_ID);
});

test('Dexter 1: only a side transcript in the folder (no main session recorded) -> a fresh session', () => {
  const s = store();
  s.put(`${SIDE_ID}.jsonl`, USER_LINE);
  assert.strictEqual(resumeIdFor({ file: s.file, cwd: s.cwd, store: s.store }), null);
});

test('a recorded id whose transcript is gone (or never got a message) is a fresh session, not an error screen', () => {
  const s = store();
  recordMainSession({ file: s.file, cwd: s.cwd, sessionId: MAIN_ID });
  assert.strictEqual(resumeIdFor({ file: s.file, cwd: s.cwd, store: s.store }), null, 'no transcript');
  s.put(`${MAIN_ID}.jsonl`, JSON.stringify({ type: 'file-history-snapshot' }) + '\n');
  assert.strictEqual(resumeIdFor({ file: s.file, cwd: s.cwd, store: s.store }), null, 'bookkeeping only');
});

test('Miguel Y5: one unreadable transcript does not hide another, and doubts are logged', () => {
  const s = store();
  s.put('aaaaaaaa-1111-4111-8111-000000000001.jsonl', USER_LINE);
  s.put('bbbbbbbb-1111-4111-8111-000000000002.jsonl', USER_LINE);
  const real = fs;
  const lines = [];
  const flaky = { ...real, openSync: (f, ...r) => { if (/aaaaaaaa/.test(f)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real.openSync(f, ...r); } };
  const { hasConversation } = require('../host/continue-flag');
  assert.strictEqual(hasConversation(s.cwd, { ...s.store, fsImpl: flaky, log: (l) => lines.push(l) }), true, 'the other transcript matched');
  assert.ok(lines.some(l => /can't read aaaaaaaa.*EBUSY/.test(l)), lines.join('|'));
  const bookkeeping = store();
  bookkeeping.put('cccccccc-1111-4111-8111-000000000003.jsonl', JSON.stringify({ type: 'file-history-snapshot' }) + '\n');
  const seen = [];
  assert.strictEqual(hasConversation(bookkeeping.cwd, { ...bookkeeping.store, log: (l) => seen.push(l) }), false);
  assert.ok(seen.some(l => /none has a user or assistant entry/.test(l)), 'a silent no would stop every resume for ever');
  const unreadable = [];
  hasConversation(s.cwd, { ...s.store, fsImpl: { ...real, readdirSync: () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }); } }, log: (l) => unreadable.push(l) });
  assert.ok(unreadable.some(l => /can't read the session store: EBUSY/.test(l)));
});
