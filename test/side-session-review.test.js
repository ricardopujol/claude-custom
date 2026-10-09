'use strict';
/**
 * PR #149 review fixes (Dexter 1, 3, 6; Miguel Y1, G1): the side session is read-only in EVERY mode, it is not counted as
 * "another live session in this worktree", and its identity carries what other producers need to know it by.
 * The shell-level fixes are in test/tab-shell-side.test.js; the scanner's in test/occupancy-transcripts.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const side = require('../host/side-session');
const { buildClaudeArgs } = require('../host/settings-writer');
const { hostEnv, PER_TAB_KEYS } = require('../host/tab-env');
const { writeIdentity } = require('../host/host-identity');
const { tmpDir } = require('./tmp-dir');

const argValue = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };

// --- Dexter 1 / Miguel Y1: a deny that holds whatever mode the session is in ---------------------------------------------

test('a side session denies every writing tool through the CLI\'s own --disallowedTools, which no mode change lifts', () => {
  const args = buildClaudeArgs({ settingsFile: 's.json', helperExists: true, side: true });
  const denied = (argValue(args, '--disallowedTools') || '').split(',');
  for (const t of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash']) assert.ok(denied.includes(t), `${t} in ${denied}`);
  assert.strictEqual(args.filter(a => a === '--disallowedTools').length, 1);
  assert.strictEqual(argValue(args, '--permission-mode'), 'plan', 'it still STARTS in plan mode');
});

test('the deny list is one comma-separated argument of plain tool names, and is the one the module exports', () => {
  const args = buildClaudeArgs({ settingsFile: 's.json', helperExists: true, side: true });
  assert.strictEqual(argValue(args, '--disallowedTools'), side.SIDE_DENIED_TOOLS.join(','));
  for (const t of side.SIDE_DENIED_TOOLS) assert.match(t, /^[A-Za-z]+$/, 'no pattern that a prompt answer could widen');
});

test('the deny is there with or without the hook helper (it does not depend on hooks)', () => {
  for (const helperExists of [true, false]) {
    const args = buildClaudeArgs({ settingsFile: 's.json', helperExists, side: true });
    assert.ok(argValue(args, '--disallowedTools'), `helperExists ${helperExists}`);
  }
});

test('an ordinary session is never denied anything by this option', () => {
  assert.ok(!buildClaudeArgs({ settingsFile: 's.json', helperExists: true }).includes('--disallowedTools'));
  assert.ok(!buildClaudeArgs({ settingsFile: 's.json', helperExists: true, side: false }).includes('--disallowedTools'));
});

// --- Miguel G1: the flag is not one letter away from CLAUDE_CUSTOM_SIDE_TAB ---------------------------------------------

test('the side host\'s flag is CLAUDE_CUSTOM_SIDE_SESSION, distinct from the picker\'s CLAUDE_CUSTOM_SIDE_TAB', () => {
  assert.strictEqual(side.SIDE_ENV, 'CLAUDE_CUSTOM_SIDE_SESSION');
  assert.strictEqual(side.isSideEnv({ CLAUDE_CUSTOM_SIDE_SESSION: '1' }), true);
  assert.strictEqual(side.isSideEnv({ CLAUDE_CUSTOM_SIDE: '1' }), false, 'the old name is nothing');
  assert.ok(PER_TAB_KEYS.includes('CLAUDE_CUSTOM_SIDE_SESSION'));
  assert.ok(PER_TAB_KEYS.includes('CLAUDE_CUSTOM_SIDE_TAB'));
  const env = hostEnv({}, { cwd: 'C:\\r', port: 4100, token: 't', project: { kind: 'flat', root: 'C:\\r', dev: 'C:\\r' }, side: true });
  assert.strictEqual(env.CLAUDE_CUSTOM_SIDE_SESSION, '1');
});

// --- Dexter 3: the "other claude session in this worktree" warning leaves the folder's own sessions out --------------------

const id = (over) => ({ port: over.port === undefined ? 7700 : over.port, parsed: { port: 7700, cwd: 'C:\\w\\feat-a', pid: 1, claudePid: 11, sessionId: 'sess-main', startedAt: 1, ...over } });

test('the main host leaves its folder\'s side hosts\' claude out of "other sessions" (pid and session id)', () => {
  const ids = [
    id({ port: 7701, pid: 2, claudePid: 22, sessionId: 'sess-side', side: true }),
    id({ port: 7702, pid: 3, claudePid: 33, cwd: 'C:\\w\\feat-b', side: true }),      // another folder: not this one's
    id({ port: 7703, pid: 4, claudePid: 44 }),                                         // an ordinary host of the folder: counted, never excluded
  ];
  assert.deepStrictEqual(side.siblingSessions(ids, { cwd: 'C:\\w\\feat-a', side: false, ownPort: 7700 }), { pids: [22], sessionIds: ['sess-side'] });
});

test('the side host leaves its folder\'s own (non-side) host\'s claude out, and not other side hosts', () => {
  const ids = [
    id({ port: 7700, pid: 1, claudePid: 11, sessionId: 'sess-main' }),
    id({ port: 7701, pid: 2, claudePid: 22, sessionId: 'sess-side', side: true }),     // itself
    id({ port: 7702, pid: 5, claudePid: 55, side: true }),                             // some other side host
  ];
  assert.deepStrictEqual(side.siblingSessions(ids, { cwd: 'C:\\w\\feat-a', side: true, ownPort: 7701 }), { pids: [11], sessionIds: ['sess-main'] });
});

test('a sibling is matched by folder however it is spelled, and an identity with no usable claude pid or session adds nothing', () => {
  const ids = [
    id({ port: 7701, claudePid: undefined, sessionId: undefined, side: true }),
    id({ port: 7702, claudePid: 0, sessionId: '', side: true }),
    id({ port: 7703, claudePid: 66, sessionId: 'x', cwd: 'c:/W/Feat-A/', side: true }),
  ];
  assert.deepStrictEqual(side.siblingSessions(ids, { cwd: 'C:\\w\\feat-a', side: false, ownPort: 7700 }), { pids: [66], sessionIds: ['x'] });
});

test('junk in, nothing out: no list, no cwd, or entries that are not identities', () => {
  const none = { pids: [], sessionIds: [] };
  assert.deepStrictEqual(side.siblingSessions(null, { cwd: 'C:\\x', side: false }), none);
  assert.deepStrictEqual(side.siblingSessions([null, {}, { parsed: null }, { port: 1, parsed: 5 }], { cwd: 'C:\\x', side: false }), none);
  assert.deepStrictEqual(side.siblingSessions([id({ side: true })], { cwd: '', side: false }), none);
});

// --- Dexter 6: a side host's identity names its session, for the producers that read transcripts -----------------------------

test('a side host\'s identity carries its session id; an ordinary host\'s never does; an unsafe id is dropped', () => {
  const dir = tmpDir('side-identity-session');
  const raw = (port) => JSON.parse(fs.readFileSync(path.join(dir, 'hosts', `${port}.json`), 'utf8'));
  writeIdentity({ dir, port: 7720, cwd: 'C:\\r', side: true, sessionId: '2f72d188-bd6d-49bd-8fe4-1f1cde460011' });
  writeIdentity({ dir, port: 7721, cwd: 'C:\\r', sessionId: '2f72d188-bd6d-49bd-8fe4-1f1cde460011' });
  writeIdentity({ dir, port: 7722, cwd: 'C:\\r', side: true, sessionId: '../../x' });
  assert.strictEqual(raw(7720).sessionId, '2f72d188-bd6d-49bd-8fe4-1f1cde460011');
  assert.ok(!('sessionId' in raw(7721)));
  assert.ok(!('sessionId' in raw(7722)));
});

test('sideHostsOf: the port and folder of each side identity, and nothing else', () => {
  const ids = [id({ port: 1, side: true }), id({ port: 2 }), id({ port: 3, side: true, cwd: '' }), { port: 4, parsed: null }];
  assert.deepStrictEqual(side.sideHostsOf(ids), [{ port: 1, cwd: 'C:\\w\\feat-a' }]);
  assert.strictEqual(side.sideHostsOf(undefined), null);
});

test('readerSessionIds: the session ids of the live side identities in a list, and nothing else', () => {
  const ids = [
    id({ port: 1, side: true, sessionId: 'a' }), id({ port: 2, sessionId: 'b' }), id({ port: 3, side: true, sessionId: undefined }), id({ port: 4, side: true, sessionId: 5 }),
  ];
  assert.deepStrictEqual(side.readerSessionIds(ids), ['a']);
  assert.deepStrictEqual(side.readerSessionIds(null), []);
});

// --- the wiring (source assertions: host.js and main.js need a pty and Electron) ----------------------------------------------

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const HOST = read('host', 'host.js');
const MAIN = read('app', 'main.js');

test('host.js: the terminal-session warning excludes the folder\'s sibling side/main sessions', () => {
  const at = HOST.indexOf('async function refreshTerminals');
  const body = HOST.slice(at, HOST.indexOf('\n}\n', at));
  assert.match(body, /siblingSessions\(ownIdentities\(\), \{ cwd: CWD, side: SIDE, ownPort: PORT \}\)/);
  assert.match(body, /pids: \[\.\.\.pids, \.\.\.sibs\.pids\]/);
  assert.match(body, /sessionIds: \[\.\.\.\(sessionId \? \[sessionId\] : \[\]\), \.\.\.sibs\.sessionIds\]/);
});

test('host.js: a side host republishes its identity with its session id once it knows it', () => {
  const writes = HOST.match(/writeIdentity\(\{[^}]*\}\)/g) || [];
  assert.ok(writes.length >= 3);
  for (const w of writes) assert.match(w, /sessionId: SIDE \? sessionId : undefined/, w);
  const at = HOST.indexOf("console.log('[host] session id     :', sessionId);");
  assert.ok(at > 0);
  assert.match(HOST.slice(at, at + 400), /if \(SIDE\) republishIdentity\(\);/);
});

test('main.js: the transcript scanner is told which sessions are side sessions, and the shell how to list side hosts', () => {
  assert.match(MAIN, /readerSessions: \(\) => readerSessionIds\(ownIdentities\(\) \|\| \[\]\)/);
  assert.match(MAIN, /sideHosts: \(\) => sideHostsOf\(ownIdentities\(\)\)/);
});
