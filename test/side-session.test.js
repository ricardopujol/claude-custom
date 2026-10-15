'use strict';
/**
 * BACKLOG #81: the standing read-only side session. These are the pure and host-level pieces; the shell's lifecycle
 * is in test/tab-shell-side.test.js and the source wiring in test/side-session-wiring.test.js.
 *
 * The side session is the CLI's own mechanism (`--permission-mode plan`), a second real `claude` in the same folder.
 * It never takes the worktree's writer role: it is a reader, in the occupancy claims and in every "is an agent working
 * here" check.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const side = require('../host/side-session');
const { hostEnv, PER_TAB_KEYS } = require('../host/tab-env');
const { buildClaudeArgs } = require('../host/settings-writer');
const { writeIdentity, readIdentity } = require('../host/host-identity');
const { decideAttach } = require('../host/handshake');
const { resolvePort } = require('../host/port-for-project');
const { buildClaim, parseClaim, serializeClaim } = require('../host/agent-occupancy');
const { createOccupancyProducer } = require('../host/occupancy-producer');
const occupancyDisplay = require('../app/occupancy-display');
const { tmpDir } = require('./tmp-dir');

// --- host/side-session.js ----------------------------------------------------------------------------------

test('a side key is its branch tab key plus a suffix no path can end in, and it round-trips', () => {
  const k = side.sideKeyOf('c:\\proj\\feat-a');
  assert.strictEqual(k, 'c:\\proj\\feat-a|side');
  assert.strictEqual(side.isSideKey(k), true);
  assert.strictEqual(side.parentKeyOf(k), 'c:\\proj\\feat-a');
  assert.strictEqual(side.isSideKey('c:\\proj\\feat-a'), false);
  assert.strictEqual(side.parentKeyOf('c:\\proj\\feat-a'), null);
});

test('property: parentKeyOf(sideKeyOf(k)) is k for every key, and a side key has no side of its own', () => {
  fc.assert(fc.property(fc.string({ minLength: 1 }).filter(s => !s.endsWith('|side')), (k) => {
    const s = side.sideKeyOf(k);
    assert.strictEqual(side.parentKeyOf(s), k);
    assert.strictEqual(side.sideKeyOf(s), null);
  }));
});

test('absence is not a key: a missing, empty or non-string parent has no side key, and "|side" alone is no side key', () => {
  for (const bad of [null, undefined, '', 5, {}]) assert.strictEqual(side.sideKeyOf(bad), null, String(bad));
  for (const bad of [null, undefined, '', '|side', 5]) {
    assert.strictEqual(side.isSideKey(bad), false, String(bad));
    assert.strictEqual(side.parentKeyOf(bad), null, String(bad));
  }
});

test('the side tab is labelled "<branch> · side"', () => {
  assert.strictEqual(side.sideLabel('feat/a'), 'feat/a \u00b7 side');
});

test('only the exact string "1" in CLAUDE_CUSTOM_SIDE_SESSION makes a host a side host', () => {
  assert.strictEqual(side.isSideEnv({ CLAUDE_CUSTOM_SIDE_SESSION: '1' }), true);
  for (const v of [undefined, '', '0', 'true', 'yes', 1]) assert.strictEqual(side.isSideEnv({ CLAUDE_CUSTOM_SIDE_SESSION: v }), false, String(v));
  assert.strictEqual(side.isSideEnv(null), false);
  assert.strictEqual(side.isSideEnv(undefined), false);
});

// --- the spawn: hostEnv and claude's argv ---------------------------------------------------------------------

const FLAT = { kind: 'flat', root: 'C:\\repo', dev: 'C:\\repo' };
const envArgs = (over = {}) => ({ cwd: 'C:\\repo', port: 4100, token: 'tok', project: FLAT, ...over });

test('hostEnv marks a side host with CLAUDE_CUSTOM_SIDE_SESSION=1, and only when asked', () => {
  assert.strictEqual(hostEnv({}, envArgs({ side: true })).CLAUDE_CUSTOM_SIDE_SESSION, '1');
  assert.ok(!('CLAUDE_CUSTOM_SIDE_SESSION' in hostEnv({}, envArgs())));
  assert.ok(!('CLAUDE_CUSTOM_SIDE_SESSION' in hostEnv({}, envArgs({ side: false }))));
});

test('an inherited CLAUDE_CUSTOM_SIDE_SESSION never reaches an ordinary tab\'s host: it is per-tab identity', () => {
  assert.ok(PER_TAB_KEYS.includes('CLAUDE_CUSTOM_SIDE_SESSION'));
  assert.ok(!('CLAUDE_CUSTOM_SIDE_SESSION' in hostEnv({ CLAUDE_CUSTOM_SIDE_SESSION: '1' }, envArgs())));
});

test('a side session\'s claude runs in plan mode, never with permissions bypassed', () => {
  const args = buildClaudeArgs({ settingsFile: 'C:/h/s.json', helperExists: true, side: true });
  const i = args.indexOf('--permission-mode');
  assert.ok(i >= 0, 'expected --permission-mode');
  assert.strictEqual(args[i + 1], 'plan');
  assert.ok(!args.includes('--dangerously-skip-permissions'), 'bypass would override plan mode');
  assert.strictEqual(args[args.indexOf('--settings') + 1], 'C:/h/s.json', 'its hooks still run');
});

test('a side session is offered no panel of Claude\'s own: no --mcp-config', () => {
  const canvasMcp = { nodePath: 'node', scriptPath: 'C:/x/canvas-mcp.js', root: 'C:/s', pointerFile: 'C:/s/p.json' };
  assert.ok(buildClaudeArgs({ settingsFile: 's', helperExists: true, canvasMcp }).includes('--mcp-config'));
  assert.ok(!buildClaudeArgs({ settingsFile: 's', helperExists: true, canvasMcp, side: true }).includes('--mcp-config'));
});

test('an ordinary session\'s args are unchanged by the side option existing', () => {
  const args = buildClaudeArgs({ settingsFile: 's', helperExists: true });
  assert.strictEqual(args[0], '--dangerously-skip-permissions');
  assert.ok(!args.includes('--permission-mode'));
  assert.deepStrictEqual(buildClaudeArgs({ settingsFile: 's', helperExists: true, side: false }), args);
});

// --- identity, handshake and the port walk: a side host is never "the" host of its folder -------------------

test('a side host\'s identity says so, and an ordinary one does not', () => {
  const dir = tmpDir('side-identity');
  writeIdentity({ dir, port: 7710, cwd: 'C:\\repo', side: true });
  writeIdentity({ dir, port: 7711, cwd: 'C:\\repo' });
  assert.strictEqual(readIdentity({ dir, port: 7710 }).side, true);
  assert.ok(!('side' in readIdentity({ dir, port: 7711 })), 'an ordinary identity is what it always was');
});

test('a window asking for the folder\'s own host is refused a side host on that folder, and the reverse', () => {
  const sideHost = { cwd: 'C:/proj', side: true };
  const mainHost = { cwd: 'C:/proj' };
  assert.strictEqual(decideAttach({ requestedCwd: 'C:/proj', occupant: sideHost }).action, 'refuse');
  assert.strictEqual(decideAttach({ requestedCwd: 'C:/proj', occupant: sideHost, requestedSide: true }).action, 'attach');
  assert.strictEqual(decideAttach({ requestedCwd: 'C:/proj', occupant: mainHost, requestedSide: true }).action, 'refuse');
  assert.strictEqual(decideAttach({ requestedCwd: 'C:/proj', occupant: mainHost }).action, 'attach');
  assert.strictEqual(decideAttach({ requestedCwd: 'C:/proj', occupant: null, requestedSide: true }).action, 'spawn');
});

test('the port walk: the main tab and the side tab of one folder never attach to each other\'s host', async () => {
  // 7700.. : the folder's main host sits on `first`, its side host one port on.
  const { portForCwd } = require('../host/port-for-project');
  const first = portForCwd('C:/proj');
  const occ = { [first]: { cwd: 'C:/proj' }, [first + 1]: { cwd: 'C:/proj', side: true } };
  const at = (p) => occ[p] || null;
  assert.deepStrictEqual(await resolvePort({ cwd: 'C:/proj', occupantAt: at }), { port: first, action: 'attach' });
  assert.deepStrictEqual(await resolvePort({ cwd: 'C:/proj', occupantAt: at, side: true }), { port: first + 1, action: 'attach' });
  // no side host yet: the side tab spawns on the first free port past the main one, not onto it
  const only = { [first]: { cwd: 'C:/proj' } };
  assert.deepStrictEqual(await resolvePort({ cwd: 'C:/proj', occupantAt: (p) => only[p] || null, side: true }), { port: first + 1, action: 'spawn' });
});

// --- occupancy: a reader --------------------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const touch = { worktree: 'C:\\w\\feat-b', firstAt: T0, lastAt: T0 + 5, count: 2 };
const claimArgs = (over = {}) => ({
  agentId: 'ag-1', agent: 'Explore', fromBranch: 'feat/a', fromRoot: 'C:\\w\\feat-a', sessionId: null,
  hostPid: 4242, hostStartedAt: '133500000000000000', touches: [touch], ...over,
});

test('a reader\'s claim carries role "reader" through build, file and parse; a writer\'s carries nothing new', () => {
  const r = buildClaim(claimArgs({ role: 'reader' }));
  assert.strictEqual(r.role, 'reader');
  const back = parseClaim(serializeClaim(r));
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.claim.role, 'reader');
  const w = buildClaim(claimArgs());
  assert.ok(!('role' in w), 'an ordinary claim is byte-for-byte what it was');
  assert.ok(!serializeClaim(w).includes('role'));
  assert.ok(!('role' in parseClaim(serializeClaim(w)).claim));
});

test('only the exact word "reader" is a reader: anything else in a claim file reads as an ordinary writer', () => {
  for (const role of ['writer', 'READER', '', null, 5, {}]) {
    const text = serializeClaim(buildClaim(claimArgs({ role: 'reader' }))).replace('"reader"', JSON.stringify(role));
    assert.ok(!('role' in parseClaim(text).claim), JSON.stringify(role));
  }
});

test('a side host\'s producer writes its subagents\' claims as a reader', () => {
  const written = [];
  const prod = createOccupancyProducer({
    writer: { write: (rec) => { written.push(rec); return { ok: true }; }, remove() {}, removeAll() {} },
    roots: { get: () => ['C:\\w\\feat-a', 'C:\\w\\feat-b'], stale: () => false, refresh: async () => {} },
    ownRoot: 'C:\\w\\feat-a', hostPid: 1, hostStartedAt: () => '133500000000000000', now: () => T0, role: 'reader',
  });
  prod.handle({ event: 'PreToolUse', payload: { agent_id: 'ag-1', tool_name: 'Read', tool_input: { file_path: 'C:\\w\\feat-b\\x.js' } } });
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].role, 'reader');
});

const claim = (over = {}) => ({ agentId: 'ag-1', agent: 'Miguel', worktree: 'c:\\w\\feat-a', fromBranch: 'feat/b', firstAt: T0, lastAt: T0, ...over });

test('occupancy: a reader is shown, marked "reading only", and is not a writer: no warning, not counted', () => {
  const reader = claim({ role: 'reader' });
  const occ = occupancyDisplay.tabOccupancy([reader], 'c:\\w\\feat-a', { turn: 'turn', now: T0 + 60_000 });
  assert.ok(occ, 'shown');
  assert.strictEqual(occ.count, 0, 'not an agent working here');
  assert.strictEqual(occ.warn, false, 'a reader is never a second writer');
  assert.strictEqual(occ.readersOnly, true);
  assert.deepStrictEqual(occ.tags, ['MI']);
  assert.ok(occ.lines.some(l => /reading only/.test(l)), JSON.stringify(occ.lines));
});

test('occupancy: a writer beside a reader still counts once, and still warns while the tab\'s own turn runs', () => {
  const occ = occupancyDisplay.tabOccupancy(
    [claim({ role: 'reader', agentId: 'r-1', agent: 'Explore' }), claim({ agentId: 'w-1', agent: 'Dexter' })],
    'c:\\w\\feat-a', { turn: 'turn', now: T0 });
  assert.strictEqual(occ.count, 1);
  assert.strictEqual(occ.warn, true);
  assert.strictEqual(occ.readersOnly, false);
  assert.strictEqual(occ.tags.length, 2);
});

test('occupancy: with no reader anywhere, the answer has the same shape and numbers as before', () => {
  const occ = occupancyDisplay.tabOccupancy([claim()], 'c:\\w\\feat-a', { turn: 'idle', now: T0 });
  assert.strictEqual(occ.count, 1);
  assert.strictEqual(occ.readersOnly, false);
  assert.strictEqual(occ.warn, false);
  assert.ok(!occ.lines.some(l => /reading only/.test(l)));
});

test('property: readers never change the writer count or the warning', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 }), fc.boolean(), (writers, readers, running) => {
    const cs = [];
    for (let i = 0; i < writers; i++) cs.push(claim({ agentId: `w-${i}`, agent: `W${i}` }));
    const base = occupancyDisplay.tabOccupancy(cs, 'c:\\w\\feat-a', { turn: running ? 'turn' : 'idle', now: T0 });
    for (let i = 0; i < readers; i++) cs.push(claim({ agentId: `r-${i}`, agent: `R${i}`, role: 'reader' }));
    const occ = occupancyDisplay.tabOccupancy(cs, 'c:\\w\\feat-a', { turn: running ? 'turn' : 'idle', now: T0 });
    assert.strictEqual(occ ? occ.count : 0, base ? base.count : 0);
    assert.strictEqual(occ ? occ.warn : false, base ? base.warn : false);
  }));
});

// --- kill tests for the release-176 survivors (BACKLOG #94) ----------------------

const CWD = 'C:/proj/wt';
const ident = (port, parsed) => ({ port, parsed });
const JUNK = [null, undefined, 'x', 7, true, [], {}, { port: 1 }, { port: 2, parsed: null }, { port: 3, parsed: 'str' }, { port: 4, parsed: 5 }];

test('M11: siblingSessions skips junk entries and keeps the valid ones', () => {
  const valid = ident(5000, { cwd: CWD, side: true, claudePid: 91, sessionId: 'sid-1' });
  const got = side.siblingSessions([...JUNK, valid], { cwd: CWD, side: false, ownPort: 1 });
  assert.deepStrictEqual(got, { pids: [91], sessionIds: ['sid-1'] });
});

test('M11: siblingSessions leaves out the host\'s own port, whether it is on the entry or on its identity file', () => {
  const mk = (entryPort, parsedPort) => ident(entryPort, { cwd: CWD, side: true, claudePid: 91, sessionId: 'sid-1', port: parsedPort });
  const ask = (e) => side.siblingSessions([e], { cwd: CWD, side: false, ownPort: 7000 });
  assert.deepStrictEqual(ask(mk(7000, 7001)), { pids: [], sessionIds: [] }, 'the entry is this host');
  assert.deepStrictEqual(ask(mk(7001, 7000)), { pids: [], sessionIds: [] }, 'the identity file names this host');
  assert.deepStrictEqual(ask(mk(7001, 7002)), { pids: [91], sessionIds: ['sid-1'] }, 'another host');
});

test('M11: siblingSessions with an empty or missing cwd names nothing, even beside a cwd-less identity', () => {
  const e = ident(5000, { cwd: '', side: true, claudePid: 91, sessionId: 's' });
  for (const cwd of ['', undefined, null, 5]) assert.deepStrictEqual(side.siblingSessions([e], { cwd, side: false }), { pids: [], sessionIds: [] });
  assert.deepStrictEqual(side.siblingSessions([e, ident(5001, { side: true, claudePid: 92 })], { cwd: CWD, side: false }), { pids: [], sessionIds: [] }, 'an identity with no cwd is nobody\'s sibling');
  assert.deepStrictEqual(side.siblingSessions(undefined, { cwd: CWD }), { pids: [], sessionIds: [] });
  assert.deepStrictEqual(side.siblingSessions('nope', { cwd: CWD }), { pids: [], sessionIds: [] });
});

test('M11: a branch host counts the side hosts of its folder, a side host counts the folder\'s own host, never its own kind', () => {
  const ids = [
    ident(5001, { cwd: CWD, side: true, claudePid: 11, sessionId: 'side-a' }),
    ident(5002, { cwd: CWD, claudePid: 22, sessionId: 'own-a' }),
    ident(5003, { cwd: 'C:/other', side: true, claudePid: 33, sessionId: 'elsewhere' }),
    ident(5004, { cwd: CWD, side: true, claudePid: 11, sessionId: 'side-a' }),
  ];
  assert.deepStrictEqual(side.siblingSessions(ids, { cwd: CWD, side: false, ownPort: 1 }), { pids: [11], sessionIds: ['side-a'] }, 'deduplicated');
  assert.deepStrictEqual(side.siblingSessions(ids, { cwd: CWD, side: true, ownPort: 1 }), { pids: [22], sessionIds: ['own-a'] });
});

test('M11: a pid or session id that is not usable is not listed', () => {
  const ids = [ident(5001, { cwd: CWD, side: true, claudePid: 0, sessionId: '' }), ident(5002, { cwd: CWD, side: true, claudePid: 1.5, sessionId: 7 }),
    ident(5003, { cwd: CWD, side: true, claudePid: -4, sessionId: null })];
  assert.deepStrictEqual(side.siblingSessions(ids, { cwd: CWD, side: false, ownPort: 1 }), { pids: [], sessionIds: [] });
});

test('M11: sideHostsOf and readerSessionIds skip junk entries and read only the side hosts', () => {
  const ids = [...JUNK,
    ident(5001, { cwd: CWD, side: true, sessionId: 'sa' }),
    ident(5002, { cwd: CWD, sessionId: 'own' }),
    ident('5003', { cwd: CWD, side: true, sessionId: 'sb' }),
    ident(5004, { cwd: '', side: true, sessionId: 'sc' }),
    ident(5005, { cwd: CWD, side: true, sessionId: 'sa' })];
  assert.deepStrictEqual(side.sideHostsOf(ids), [{ port: 5001, cwd: CWD }, { port: 5005, cwd: CWD }]);
  assert.deepStrictEqual(side.readerSessionIds(ids), ['sa', 'sb', 'sc']);
  assert.strictEqual(side.sideHostsOf(null), null);
  assert.strictEqual(side.sideHostsOf([ident(5001, { cwd: CWD, side: true }), { unreadable: true }]), null, 'an unreadable identity may be a live side host\'s');
  assert.deepStrictEqual(side.readerSessionIds(undefined), []);
});
