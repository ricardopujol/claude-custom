'use strict';
/**
 * The model an agent ACTUALLY used, read from its own transcript.
 *
 * MEASURED (2026-09-22) on this project's real transcripts under
 * ~/.claude/projects/<encoded-cwd>/: every assistant line carries
 * `message.model`, one line in this project's history carries the sentinel
 * `<synthetic>` (not a model, must be filtered), and the parent session's own
 * `Agent` tool_input carries an undocumented `model` field that is the model
 * REQUESTED, never the one used -- so identity for "what actually ran" can
 * only come from the subagent's own transcript.
 *
 * Identity (name vs. true agent type) is NOT re-solved here: it is the exact
 * problem host/agent-stats.js already has a tested answer for, and a second
 * walker would be a second place for the "named spawn" defect to hide.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { latestModel, readSessionModel } = require('../host/session-model');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const NL = String.fromCharCode(10);
const CWD = 'C:/w/proj';
const SYNTHETIC = '<synthetic>';

function project() {
  const projectsDir = tmpDir('cc-session-model-');
  const projectDir = projectDirName(CWD);
  const dir = path.join(projectsDir, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  return { projectsDir, projectDir, dir };
}

const assistant = (model, at) => ({
  type: 'assistant',
  timestamp: at,
  message: { model, id: 'msg_' + Math.random().toString(36).slice(2) },
});

function writeSession(dir, sessionId, lines) {
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'),
    lines.map(l => JSON.stringify(l)).join(NL) + NL);
}

function writeSubagent(dir, sessionId, file, meta, lines) {
  const sd = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, file + '.meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(sd, file + '.jsonl'),
    lines.map(l => JSON.stringify(l)).join(NL) + NL);
}

// A parent-session Agent tool_use block, the identity source host/agent-stats.js
// already resolves. Mirrors test/agent-stats.test.js's `session()` helper.
function agentSpawn(id, type, name) {
  return {
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      content: [{
        type: 'tool_use', id, name: 'Agent',
        input: { subagent_type: type, ...(name ? { name } : {}) },
      }],
    },
  };
}

// --- latestModel: pure ------------------------------------------------------

test('latestModel: null for an empty list', () => {
  assert.strictEqual(latestModel([]), null);
});

test('latestModel: skips <synthetic> -- it is not a model', () => {
  const r = latestModel([assistant(SYNTHETIC, '2026-01-01T00:00:00.000Z')]);
  assert.strictEqual(r, null);
});

test('latestModel: skips non-assistant lines', () => {
  const entries = [
    { type: 'cost-state', model: 'claude-opus-5' },
    { type: 'user', message: { model: 'claude-opus-5' } },
    assistant('claude-sonnet-5', '2026-01-01T00:00:01.000Z'),
  ];
  const r = latestModel(entries);
  assert.strictEqual(r.model, 'claude-sonnet-5');
});

test('latestModel: skips assistant lines with no message.model', () => {
  const entries = [
    { type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message: { id: 'x' } },
    assistant('claude-opus-5', '2026-01-01T00:00:01.000Z'),
  ];
  assert.strictEqual(latestModel(entries).model, 'claude-opus-5');
});

test('latestModel: the LAST matching entry wins, by file order', () => {
  // Not by timestamp -- entries arrive in file order and that order IS the
  // truth, exactly like usage.js's own "one message, one line" reasoning.
  const entries = [
    assistant('claude-opus-5', '2026-01-01T00:00:05.000Z'),
    assistant('claude-sonnet-5', '2026-01-01T00:00:01.000Z'),   // earlier stamp, later in file
  ];
  assert.strictEqual(latestModel(entries).model, 'claude-sonnet-5');
});

test('latestModel: carries the timestamp of the winning entry', () => {
  const r = latestModel([assistant('claude-fable-5-1', '2026-02-02T02:02:02.000Z')]);
  assert.deepStrictEqual(r, { model: 'claude-fable-5-1', at: '2026-02-02T02:02:02.000Z' });
});

test('latestModel: a real model followed by a synthetic one still reports the real one', () => {
  // <synthetic> must never OVERWRITE a genuine answer -- it is not "unknown
  // wins", it is "not a model, skip it".
  const entries = [
    assistant('claude-opus-5', '2026-01-01T00:00:00.000Z'),
    assistant(SYNTHETIC, '2026-01-01T00:00:01.000Z'),
  ];
  assert.strictEqual(latestModel(entries).model, 'claude-opus-5');
});

// property: latestModel never returns <synthetic>, for any mix of junk and
// synthetic-tagged assistant lines.
test('property: latestModel never returns <synthetic>, for any input shape', () => {
  const junk = [
    null, undefined, 42, 'a string', [], {},
    { type: 'assistant' },
    { type: 'assistant', message: null },
    { type: 'assistant', message: {} },
    { type: 'assistant', message: { model: 123 } },
    { type: 'user', message: { model: 'claude-opus-5' } },
  ];
  for (let trial = 0; trial < 200; trial++) {
    const len = 1 + Math.floor(Math.random() * 6);
    const entries = [];
    for (let i = 0; i < len; i++) {
      const pick = Math.random();
      if (pick < 0.4) entries.push(assistant(SYNTHETIC, new Date(i).toISOString()));
      else if (pick < 0.7) entries.push(junk[Math.floor(Math.random() * junk.length)]);
      else entries.push(assistant('claude-real-' + i, new Date(i).toISOString()));
    }
    const r = latestModel(entries);
    if (r) assert.notStrictEqual(r.model, SYNTHETIC, JSON.stringify(entries));
  }
});

// property: null iff no assistant line carries a real model.
test('property: result is null iff no entry is an assistant line with a real model', () => {
  const junk = [
    null, { type: 'cost-state' }, { type: 'assistant' },
    { type: 'assistant', message: { model: SYNTHETIC } },
    { type: 'user', message: { model: 'claude-opus-5' } },
  ];
  for (let trial = 0; trial < 200; trial++) {
    const hasReal = Math.random() < 0.5;
    const len = 1 + Math.floor(Math.random() * 5);
    const entries = [];
    for (let i = 0; i < len; i++) entries.push(junk[Math.floor(Math.random() * junk.length)]);
    if (hasReal) entries.splice(Math.floor(Math.random() * entries.length), 0,
      assistant('claude-real', new Date().toISOString()));
    const r = latestModel(entries);
    assert.strictEqual(r === null, !hasReal, JSON.stringify(entries));
  }
});

// --- readSessionModel: fs ----------------------------------------------------

test('readSessionModel: the main session model is the latest assistant line', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [
    assistant('claude-opus-5', '2026-01-01T00:00:00.000Z'),
    assistant('claude-sonnet-5', '2026-01-01T00:01:00.000Z'),
  ]);
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.deepStrictEqual(r.session, { model: 'claude-sonnet-5', at: '2026-01-01T00:01:00.000Z' });
  assert.strictEqual(r.errors, 0);
});

test('readSessionModel: <synthetic> is filtered out of the session model too', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [
    assistant('claude-opus-5', '2026-01-01T00:00:00.000Z'),
    assistant(SYNTHETIC, '2026-01-01T00:01:00.000Z'),
  ]);
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.session.model, 'claude-opus-5');
});

test('readSessionModel: an ordinary subagent is filed under its TYPE', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'code-reviewer')]);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'code-reviewer', toolUseId: 'toolu_1' },
    [assistant('claude-opus-5', '2026-01-01T00:05:00.000Z')]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.deepStrictEqual(r.agents['code-reviewer'],
    { model: 'claude-opus-5', at: '2026-01-01T00:05:00.000Z' });
});

// Dexter, PR #34, Finding 1: two runs of one agent type in one session. Subagent
// file ids are random hex, so readdir order says nothing about which run is
// newer -- the card must show the model of the LATEST run, and the answer must
// not change with the order the files happen to be enumerated in. Both
// orientations are asserted: a fix that only reverses the loop passes one.
for (const newerSortsFirst of [true, false]) {
  test(`readSessionModel: two runs of one type -- the NEWER run wins (newer file sorts ${newerSortsFirst ? 'first' : 'last'})`, async () => {
    const { projectsDir, projectDir, dir } = project();
    writeSession(dir, 's1', [agentSpawn('toolu_1', 'logic-reviewer'), agentSpawn('toolu_2', 'logic-reviewer')]);
    const [newerFile, olderFile] = newerSortsFirst ? ['agent-0a9e', 'agent-f3c1'] : ['agent-f3c1', 'agent-0a9e'];
    writeSubagent(dir, 's1', olderFile, { agentType: 'logic-reviewer', toolUseId: 'toolu_1' },
      [assistant('claude-opus-5', '2026-01-01T10:00:00.000Z')]);
    writeSubagent(dir, 's1', newerFile, { agentType: 'logic-reviewer', toolUseId: 'toolu_2' },
      [assistant('claude-sonnet-5', '2026-01-01T11:00:00.000Z')]);

    const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
    assert.deepStrictEqual(r.agents['logic-reviewer'],
      { model: 'claude-sonnet-5', at: '2026-01-01T11:00:00.000Z' });
  });
}

test('isNewerRun (property): the pick is the same for EVERY enumeration order', () => {
  // Exhaustive over all 120 orders of five runs covering every branch: two
  // equal stamps (tie -> file), an unparseable stamp, a missing one, and the
  // true newest. A pick that depends on order is the Finding 1 defect.
  const { isNewerRun } = require('../host/session-model');
  const runs = [
    { at: '2026-01-01T10:00:00.000Z', file: 'd' },
    { at: '2026-01-01T12:00:00.000Z', file: 'a' },
    { at: '2026-01-01T12:00:00.000Z', file: 'c' },
    { at: 'not a date', file: 'z' },
    { at: null, file: 'y' },
  ];
  const permutations = (xs) => xs.length <= 1 ? [xs]
    : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]));
  const pick = (order) => order.reduce((best, r) => (!best || isNewerRun(r, best) ? r : best), null);

  const picks = new Set(permutations(runs).map(o => pick(o).file));
  assert.deepStrictEqual([...picks], ['c'], 'newest stamp, tie broken by file name, in every order');
});

test('isNewerRun: irreflexive and asymmetric -- never both a>b and b>a', () => {
  const { isNewerRun } = require('../host/session-model');
  const runs = [
    { at: '2026-01-01T10:00:00.000Z', file: 'a' }, { at: '2026-01-01T10:00:00.000Z', file: 'b' },
    { at: undefined, file: 'a' }, { at: 'garbage', file: 'b' }, { at: '2026-01-02T00:00:00.000Z', file: 'a' },
  ];
  for (const a of runs) {
    assert.strictEqual(isNewerRun(a, a), false);
    for (const b of runs) {
      if (a === b) continue;
      assert.ok(!(isNewerRun(a, b) && isNewerRun(b, a)), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  }
});

test('readSessionModel: a run WITH a timestamp beats one without, in either order', async () => {
  // A missing `at` cannot be ordered, so it must never displace one that can.
  for (const stampedFirst of [true, false]) {
    const { projectsDir, projectDir, dir } = project();
    writeSession(dir, 's1', [agentSpawn('toolu_1', 'logic-reviewer'), agentSpawn('toolu_2', 'logic-reviewer')]);
    const [stamped, bare] = stampedFirst ? ['agent-0a9e', 'agent-f3c1'] : ['agent-f3c1', 'agent-0a9e'];
    writeSubagent(dir, 's1', stamped, { agentType: 'logic-reviewer', toolUseId: 'toolu_1' },
      [assistant('claude-sonnet-5', '2026-01-01T11:00:00.000Z')]);
    writeSubagent(dir, 's1', bare, { agentType: 'logic-reviewer', toolUseId: 'toolu_2' },
      [assistant('claude-opus-5', undefined)]);

    const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
    assert.strictEqual(r.agents['logic-reviewer'].model, 'claude-sonnet-5', `stampedFirst=${stampedFirst}`);
  }
});

test('readSessionModel: a NAMED spawn resolves to its TYPE, not its name', async () => {
  // The exact defect host/agent-stats.js exists for -- reused here, not
  // re-derived, so this module cannot get it independently wrong.
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'code-reviewer', 'miguel-review')]);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'miguel-review', requestShape: 'background' },
    [assistant('claude-fable-5-1', '2026-01-01T00:05:00.000Z')]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.ok(!r.agents['miguel-review'], 'must not be filed under the name');
  assert.deepStrictEqual(r.agents['code-reviewer'],
    { model: 'claude-fable-5-1', at: '2026-01-01T00:05:00.000Z' });
});

test('readSessionModel: a name that resolves nowhere is kept as a label, marked unresolved', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', []);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'some-ghost', requestShape: 'background' },
    [assistant('claude-opus-5', '2026-01-01T00:05:00.000Z')]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.agents['some-ghost'].model, 'claude-opus-5');
  assert.strictEqual(r.agents['some-ghost'].unresolved, true);
});

test('readSessionModel: no assistant line yet is null, never a guessed string', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'code-reviewer')]);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'code-reviewer', toolUseId: 'toolu_1' },
    [{ type: 'user', message: { role: 'user', content: 'go' } }]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.session.model, null);
  assert.strictEqual(r.session.at, null);
  assert.ok(!('code-reviewer' in r.agents), 'nothing to report yet is absence, not a row');
});

test('readSessionModel: a session with no subagents is ordinary, not an error', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [assistant('claude-opus-5', '2026-01-01T00:00:00.000Z')]);
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.errors, 0);
  assert.deepStrictEqual(r.agents, {});
});

test('readSessionModel: a project folder that cannot be read is absence, counted as an error', async () => {
  const { projectsDir, projectDir } = project();
  fs.rmSync(path.join(projectsDir, projectDir), { recursive: true, force: true });
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.errors, 1);
  assert.deepStrictEqual(r.session, { model: null, at: null });
  assert.deepStrictEqual(r.agents, {});
});

test('readSessionModel: a subagents folder that cannot be LISTED is counted, not a clean "no agents"', async () => {
  // Dexter, PR #34, Finding 2: transcriptFiles reported the failure in its
  // `errors` and this module destructured it away, so EBUSY/EPERM on the
  // subagents folder came back as { agents: {}, errors: 0 }. `subagents` as a
  // FILE makes readdir fail with ENOTDIR -- the same non-ENOENT class, portably.
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [assistant('claude-opus-5', '2026-01-01T00:00:00.000Z')]);
  fs.mkdirSync(path.join(dir, 's1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's1', 'subagents'), 'not a folder');

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.ok(r.errors >= 1, `expected the unlistable folder to be counted, got errors=${r.errors}`);
  assert.strictEqual(r.session.model, 'claude-opus-5', 'what COULD be read is still reported');
});

test('readSessionModel: a subagent transcript that exists but cannot be OPENED is counted, not swallowed', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'code-reviewer')]);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'code-reviewer', toolUseId: 'toolu_1' },
    [assistant('claude-opus-5', '2026-01-01T00:05:00.000Z')]);

  const err = new Error('locked');
  err.code = 'EBUSY';
  const openFile = async (file) => {
    if (file.endsWith('.jsonl') && file.includes('subagents')) throw err;
    return fs.promises.open(file, 'r');
  };

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1', openFile });
  assert.strictEqual(r.errors, 1);
  assert.ok(!('code-reviewer' in r.agents), 'a failure must not be reported as absence-of-runs either');
});

test('readSessionModel: a transcript deleted between the listing and the read contributes nothing, not an error', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'code-reviewer')]);
  writeSubagent(dir, 's1', 'agent-a', { agentType: 'code-reviewer', toolUseId: 'toolu_1' },
    [assistant('claude-opus-5', '2026-01-01T00:05:00.000Z')]);
  fs.unlinkSync(path.join(dir, 's1', 'subagents', 'agent-a.jsonl'));

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.errors, 0);
  assert.ok(!('code-reviewer' in r.agents));
});

test('readSessionModel: no sessionId is absence, never a guess', async () => {
  const { projectsDir, projectDir } = project();
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: null });
  assert.deepStrictEqual(r, { session: { model: null, at: null }, agents: {}, errors: 0 });
});

test('readSessionModel: the model is found even far past a tail-read window', async () => {
  // The module reads only the TAIL of each file (these transcripts run tens of
  // MB). This proves the tail read still lands on a real answer once the file
  // is comfortably past any small internal chunk size, rather than silently
  // reporting null for "the read window missed it".
  const { projectsDir, projectDir, dir } = project();
  const filler = [];
  // A run of plain (non-model-bearing) lines, individually large, so the file
  // crosses any reasonable tail-window boundary well before the real answer.
  for (let i = 0; i < 400; i++) {
    filler.push({ type: 'cost-state', pad: 'x'.repeat(512), i });
  }
  filler.push(assistant('claude-sonnet-5', '2026-01-01T00:09:00.000Z'));
  writeSession(dir, 's1', filler);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.session.model, 'claude-sonnet-5');
});

test('readSessionModel: an agent spawned by an agent is still resolved (nested identity)', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [agentSpawn('toolu_1', 'agent-organizer')]);
  writeSubagent(dir, 's1', 'outer', { agentType: 'agent-organizer', toolUseId: 'toolu_1' }, [
    assistant('claude-opus-5', '2026-01-01T00:01:00.000Z'),
    agentSpawn('toolu_9', 'ui-designer', 'ascii-judge'),
  ]);
  writeSubagent(dir, 's1', 'inner', { agentType: 'ascii-judge', requestShape: 'background' },
    [assistant('claude-fable-5-1', '2026-01-01T00:02:00.000Z')]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.agents['agent-organizer'].model, 'claude-opus-5');
  assert.strictEqual(r.agents['ui-designer'].model, 'claude-fable-5-1');
  assert.ok(!r.agents['ascii-judge']);
});

// --- mergeSessionModel + the host's refresher --------------------------------
//
// Dexter, PR #34, Findings 3 and 4. These live here rather than in host.js so
// the host's wiring has a test at all (Miguel, S2): host.js is the process
// entry point and cannot be required without starting one.

const { mergeSessionModel, createSessionModelRefresher } = require('../host/session-model');

const EMPTY = { session: { model: null, at: null }, agents: {}, errors: 0 };
const row = (model, at = '2026-01-01T00:00:00.000Z') => ({ model, at });

test('mergeSessionModel: a failed read does NOT erase a model already known (Finding 3)', () => {
  const prev = { session: { model: 'claude-opus-5', at: 'x' }, agents: { X: row('claude-opus-5') }, errors: 0 };
  const failed = { session: { model: null, at: null }, agents: {}, errors: 1 };
  const m = mergeSessionModel(prev, failed);
  assert.deepStrictEqual(m.agents.X, row('claude-opus-5'));
  assert.strictEqual(m.session.model, 'claude-opus-5');
  assert.strictEqual(m.errors, 1, 'the failure is still reported');
});

test('mergeSessionModel: a newer read of an agent replaces it; new agents are added', () => {
  const prev = { ...EMPTY, agents: { X: row('claude-opus-5', 'a') } };
  const next = { ...EMPTY, agents: { X: row('claude-sonnet-5', 'b'), Y: row('claude-fable-5-1') } };
  const m = mergeSessionModel(prev, next);
  assert.deepStrictEqual(m.agents, { X: row('claude-sonnet-5', 'b'), Y: row('claude-fable-5-1') });
});

test('mergeSessionModel: an agent literally named __proto__ is an own key, not a prototype swap', () => {
  const next = { ...EMPTY, agents: JSON.parse('{"__proto__": {"model": "m", "at": null}}') };
  const m = mergeSessionModel(EMPTY, next);
  assert.ok(Object.prototype.hasOwnProperty.call(m.agents, '__proto__'));
  assert.strictEqual(Object.getPrototypeOf(m.agents), Object.prototype);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.agents)), { ['__proto__']: { model: 'm', at: null } });
});

// A read whose resolution the test controls.
function deferredReader() {
  const calls = [];
  const read = (sessionId) => new Promise((resolve, reject) => calls.push({ sessionId, resolve, reject }));
  return { read, calls };
}
const tick = () => new Promise(r => setImmediate(r));

test('refresher: an event DURING a read gets a fresh read after it, not the stale one (Finding 4A)', async () => {
  const { read, calls } = deferredReader();
  const r = createSessionModelRefresher({ read, currentSessionId: () => 's1' });
  const first = r.refresh();                 // SubagentStop(agent-organizer)
  await tick();
  const second = r.refresh();                // SubagentStop(vera), mid-read
  calls[0].resolve({ ...EMPTY, agents: { 'agent-organizer': row('claude-opus-5') } });
  await tick();
  assert.strictEqual(calls.length, 2, 'a follow-up read must be issued for the event that arrived mid-read');
  calls[1].resolve({ ...EMPTY, agents: { 'agent-organizer': row('claude-opus-5'), vera: row('claude-sonnet-5') } });
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(b.agents.vera.model, 'claude-sonnet-5');
  assert.strictEqual(a, b, 'both callers settle on the same final state');
});

test('refresher: a /clear mid-read never shows the OLD session under the new id (Finding 4B)', async () => {
  const { read, calls } = deferredReader();
  let sid = 'A';
  const broadcasts = [];
  const r = createSessionModelRefresher({ read, currentSessionId: () => sid, onChange: (m) => broadcasts.push(m) });
  const p1 = r.refresh();
  await tick();
  sid = 'B';                                  // SessionStart(B) while A's read is in flight
  const switchedAt = broadcasts.length;
  const p2 = r.refresh();
  calls[0].resolve({ ...EMPTY, agents: { old: row('claude-opus-5') } });
  await tick();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].sessionId, 'B');
  calls[1].resolve({ ...EMPTY, session: { model: 'claude-sonnet-5', at: 't' } });
  const [a, b] = await Promise.all([p1, p2]);
  assert.ok(!('old' in b.agents), 'session A\'s agents must not appear under B');
  assert.strictEqual(b.session.model, 'claude-sonnet-5');
  assert.strictEqual(a, b);
  // Not only the final state: nothing BROADCAST after the switch may carry A's
  // agents either. Found by hand-mutation -- with the stale-result discard
  // removed, the final state was still right (the next loop's reset cleaned
  // it up) but clients were sent A's agents in between.
  for (const m of broadcasts.slice(switchedAt)) {
    assert.ok(!('old' in m.agents), 'a broadcast after the switch carried session A\'s agents');
  }
});

test('refresher: a new session starts empty rather than inheriting the last one', async () => {
  let sid = 'A';
  const r = createSessionModelRefresher({
    read: async (s) => (s === 'A' ? { ...EMPTY, agents: { old: row('m') } } : { ...EMPTY }),
    currentSessionId: () => sid,
  });
  await r.refresh();
  sid = 'B';
  const m = await r.refresh();
  assert.deepStrictEqual(m.agents, {});
});

test('refresher: a failed read keeps what was known, and says so (Finding 3 end to end)', async () => {
  const reads = [
    { ...EMPTY, agents: { X: row('claude-opus-5') } },
    { ...EMPTY, errors: 1 },
  ];
  const r = createSessionModelRefresher({ read: async () => reads.shift(), currentSessionId: () => 's1' });
  await r.refresh();
  const m = await r.refresh();
  assert.strictEqual(m.agents.X.model, 'claude-opus-5');
  assert.strictEqual(m.errors, 1);
});

test('refresher: a read that THROWS keeps the last state and reports no change', async () => {
  const changes = [];
  let fail = false;
  const r = createSessionModelRefresher({
    read: async () => { if (fail) throw new Error('boom'); return { ...EMPTY, agents: { X: row('m') } }; },
    currentSessionId: () => 's1',
    onChange: (m) => changes.push(m),
    log: () => {},
  });
  await r.refresh();
  fail = true;
  const m = await r.refresh();
  assert.strictEqual(m.agents.X.model, 'm');
  assert.strictEqual(changes.length, 1, 'only the first, real change is announced');
});

test('refresher: onChange fires once per real change, never for an identical read', async () => {
  const changes = [];
  const r = createSessionModelRefresher({
    read: async () => ({ ...EMPTY, agents: { X: row('m') } }),
    currentSessionId: () => 's1',
    onChange: (m) => changes.push(m),
  });
  await r.refresh();
  await r.refresh();
  await r.refresh();
  assert.strictEqual(changes.length, 1);
});

test('refresher: no session id yet means no read and the empty state', async () => {
  let reads = 0;
  const r = createSessionModelRefresher({ read: async () => { reads++; return EMPTY; }, currentSessionId: () => null });
  const m = await r.refresh();
  assert.strictEqual(reads, 0);
  assert.deepStrictEqual(m, EMPTY);
  assert.deepStrictEqual(r.current(), EMPTY);
});

test('refresher: on a session change the old state is dropped AT ONCE, not when the new read lands', async () => {
  // Between SessionStart(B) and B's read resolving, a client that connects gets
  // current() in its hello. It must not be session A's agents.
  const { read, calls } = deferredReader();
  let sid = 'A';
  const r = createSessionModelRefresher({ read, currentSessionId: () => sid });
  const p = r.refresh();
  await tick();
  calls[0].resolve({ ...EMPTY, agents: { old: row('m') } });
  await p;
  sid = 'B';
  r.refresh();
  await tick();
  assert.deepStrictEqual(r.current().agents, {}, 'A\'s agents must be gone while B is being read');
});

test('readSessionModel: an agent labelled __proto__ is an own key, not a prototype swap (Miguel I1)', async () => {
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', []);
  writeSubagent(dir, 's1', 'agent-a', { agentType: '__proto__', requestShape: 'background' },
    [assistant('claude-opus-5', '2026-01-01T00:05:00.000Z')]);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.ok(Object.prototype.hasOwnProperty.call(r.agents, '__proto__'), 'must be an own key');
  assert.strictEqual(Object.getPrototypeOf(r.agents), Object.prototype, 'prototype untouched');
  assert.strictEqual(JSON.parse(JSON.stringify(r.agents))['__proto__'].model, 'claude-opus-5',
    'and it survives the trip to the renderer');
});

// --- Dexter, PR #34, Finding 5: the tail window ------------------------------

const { TAIL_BYTES } = require('../host/session-model');

// An assistant line padded so its JSON is EXACTLY `len` bytes (ASCII only).
function paddedAssistant(model, at, len) {
  // ONE assistant() call, measured and then padded. assistant() mints a random
  // message id whose length varies, so measuring one object and padding a
  // second came out a byte short about half the time.
  const obj = { ...assistant(model, at), pad: '' };
  obj.pad = 'x'.repeat(len - JSON.stringify(obj).length);
  assert.strictEqual(JSON.stringify(obj).length, len);
  return obj;
}

test('readSessionModel: a last record bigger than the tail window does not lose the model', async () => {
  // A subagent killed right after a huge Read: its final line is a user
  // tool_result longer than TAIL_BYTES, and every model-bearing line is before it.
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [
    assistant('claude-opus-5', '2026-01-01T00:00:00.000Z'),
    { type: 'user', message: { role: 'user', content: 'y'.repeat(TAIL_BYTES + 12 * 1024) } },
  ]);
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.session.model, 'claude-opus-5');
});

test('readSessionModel: a window that starts EXACTLY on a line boundary keeps that line', async () => {
  // The last line plus its newline is exactly TAIL_BYTES, so the byte before the
  // window is '\n' and the window's first line is complete. Dropping it as a
  // "partial fragment" empties the window.
  //
  // WHAT IS OBSERVABLE, corrected after hand-mutation: widening then re-reads
  // from further back and still finds the newest model, so the ANSWER is right
  // either way -- a first version of this test asserted only the answer and
  // passed with the fix reverted. The defect that remains is a wasted second
  // read of every such file, so that is what is asserted: one read, not two.
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [
    assistant('claude-opus-5', '2026-01-01T00:00:00.000Z'),
    paddedAssistant('claude-sonnet-5', '2026-01-01T00:01:00.000Z', TAIL_BYTES - 1),
  ]);
  let reads = 0;
  const openFile = async (f, flags) => {
    const fh = await fs.promises.open(f, flags);
    const read = fh.read.bind(fh);
    fh.read = (...a) => { reads++; return read(...a); };
    return fh;
  };
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1', openFile });
  assert.strictEqual(r.session.model, 'claude-sonnet-5');
  assert.strictEqual(reads, 1, 'the boundary line is kept by the FIRST window, not recovered by widening');
});

test('readSessionModel: the widening STOPS at the cap -- beyond it the model is unread, not guessed', async () => {
  const { TAIL_MAX_BYTES } = require('../host/session-model');
  const { projectsDir, projectDir, dir } = project();
  writeSession(dir, 's1', [
    assistant('claude-opus-5', '2026-01-01T00:00:00.000Z'),
    { type: 'user', message: { role: 'user', content: 'y'.repeat(TAIL_MAX_BYTES + 1024) } },
  ]);
  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.session.model, null);
});

// --- round 1: Dexter r1 F1 / Miguel r1 N1, F2, F3 -----------------------------

test('mergeSessionModel: a partial read never puts an OLDER run back on the card (r1 F1 / N1)', () => {
  // Known: sonnet @ 11:00. Next read could not open run 2's transcript, so the
  // only run it saw is run 1: opus @ 10:00. The card must keep sonnet.
  const prev = { ...EMPTY, agents: { lr: row('claude-sonnet-5', '2026-01-01T11:00:00.000Z') } };
  const partial = { ...EMPTY, agents: { lr: row('claude-opus-5', '2026-01-01T10:00:00.000Z') }, errors: 1 };
  assert.deepStrictEqual(mergeSessionModel(prev, partial).agents.lr, row('claude-sonnet-5', '2026-01-01T11:00:00.000Z'));
});

test('mergeSessionModel: an equal or newer run still replaces, and a stamped run beats a bare one', () => {
  const at = '2026-01-01T11:00:00.000Z';
  const prev = { ...EMPTY, agents: { a: row('m1', at), b: row('m1', '2026-01-01T10:00:00.000Z'), c: row('m1', undefined), d: row('m1', at) } };
  const next = { ...EMPTY, agents: { a: row('m2', at), b: row('m2', at), c: row('m2', at), d: row('m2', undefined) } };
  const m = mergeSessionModel(prev, next).agents;
  assert.strictEqual(m.a.model, 'm2', 'equal stamp: the fresh read wins');
  assert.strictEqual(m.b.model, 'm2', 'newer: replaces');
  assert.strictEqual(m.c.model, 'm2', 'stamped beats bare');
  assert.strictEqual(m.d.model, 'm1', 'a bare row never displaces a stamped one');
});

test('mergeSessionModel: an UNRESOLVED row is not carried forward -- a wrong name must not stick (r1 F3)', () => {
  // R1 half-failed (identity tables unreadable) and filed the run under its
  // label L; a clean R2 resolves it to its type T. Only T may remain.
  const prev = { ...EMPTY, agents: { L: { ...row('m'), unresolved: true }, known: row('m') } };
  const clean = { ...EMPTY, agents: { T: row('m') } };
  const m = mergeSessionModel(prev, clean).agents;
  assert.deepStrictEqual(Object.keys(m).sort(), ['T', 'known']);
});

test('refresher: a /clear is reflected by current() AT ONCE, even while the old read is still in flight (r1 F2)', async () => {
  const { read, calls } = deferredReader();
  let sid = 'A';
  const r = createSessionModelRefresher({ read, currentSessionId: () => sid });
  const p = r.refresh();
  await tick();
  calls[0].resolve({ ...EMPTY, agents: { old: row('m') } });
  await p;                                   // A is known
  const p2 = r.refresh();                    // a second read of A starts...
  await tick();
  sid = 'B';                                 // ...and /clear lands while it runs
  r.refresh();
  assert.deepStrictEqual(r.current().agents, {}, 'hello must not carry A\'s agents under B');
  calls[1].resolve({ ...EMPTY, agents: { old: row('m') } });
  await tick();
  calls[2].resolve({ ...EMPTY });
  await p2;
  assert.deepStrictEqual(r.current().agents, {});
});

test('readSessionModel: a file of exactly TAIL_MAX_BYTES + 1 keeps its first line (r1 F4)', async () => {
  // At the cap the window starts at byte 1, so the read begins at byte 0 --
  // there IS no fragment to drop, and dropping "up to the first newline" threw
  // away line 1, here the only model-bearing line.
  const { TAIL_MAX_BYTES } = require('../host/session-model');
  const { projectsDir, projectDir, dir } = project();
  const first = JSON.stringify(assistant('claude-opus-5', '2026-01-01T00:00:00.000Z'));
  const user = { type: 'user', message: { role: 'user', content: '' } };
  // total = first + '\n' + user + '\n' === TAIL_MAX_BYTES + 1
  user.message.content = 'y'.repeat(TAIL_MAX_BYTES + 1 - first.length - 2 - JSON.stringify(user).length);
  const text = first + NL + JSON.stringify(user) + NL;
  assert.strictEqual(Buffer.byteLength(text), TAIL_MAX_BYTES + 1);
  fs.writeFileSync(path.join(dir, 's1.jsonl'), text);

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 's1' });
  assert.strictEqual(r.session.model, 'claude-opus-5');
});
