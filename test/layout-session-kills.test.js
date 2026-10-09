'use strict';
/**
 * Kill tests for Mortimer's release-gate survivors S25 (tail, 2026-10-09): the id-backfill branches of
 * app/layout-bridge.js `giveIds` (`answer.status !== 'ok'`, `Array.isArray(st.value)`, `list === null`) and the
 * `files.filter(f => f.session === sessionId)` of host/session-model.js readSessionModel.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { registerLayoutHandlers, PRESET_NAMES } = require('../app/layout-bridge');
const { readSessionModel } = require('../host/session-model');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const L = (tag = 'a') => ({ version: 2, root: { type: 'term' }, floats: [], hidden: [tag], seat: {} });
const IDLESS = [{ name: 'Focus', layout: L('focus') }, { name: 'Debug', layout: L('debug') }];

// A store whose readState answers `states` in order (the last one repeats), counting locks, writes and pushes.
function scripted(states) {
  const store = { locks: 0, writes: 0, reads: 0 };
  store.readState = () => { const s = states[Math.min(store.reads, states.length - 1)]; store.reads += 1; return s; };
  store.withLock = (name, fn) => { store.locks += 1; return fn(); };
  store.write = () => { store.writes += 1; };
  return store;
}

function windowOn(store) {
  const handlers = new Map();
  const sent = [];
  const view = {};
  const sync = {};
  let n = 0;
  registerLayoutHandlers({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, store, sync, names: PRESET_NAMES,
    isSender: s => s === view, send: (ch, v) => sent.push([ch, v]), newId: () => `n${++n}`,
  });
  return { sent, sync, get: () => handlers.get(PRESET_NAMES.get)({ sender: view }) };
}

test('S25: a preset list that is not "ok" (corrupt, unreadable, missing) is answered as it is: no lock, no write, no push', async () => {
  for (const status of ['corrupt', 'unreadable', 'missing']) {
    const store = scripted([{ status, value: null }]);
    const w = windowOn(store);
    const answer = await w.get();
    assert.strictEqual(answer.status, status === 'missing' ? 'missing' : status, status);
    assert.strictEqual(store.locks, 0, `${status}: the backfill never takes the lock`);
    assert.strictEqual(store.writes, 0);
    assert.deepStrictEqual(w.sent, []);
  }
});

test('S25: a list that already has its ids is answered without a lock or a write (control)', async () => {
  const withIds = [{ name: 'Focus', layout: L('focus'), id: 'a' }, { name: 'Debug', layout: L('debug'), id: 'b' }];
  const store = scripted([{ status: 'ok', value: withIds }]);
  const w = windowOn(store);
  const answer = await w.get();
  assert.deepStrictEqual(answer, { status: 'ok', layout: withIds });
  assert.strictEqual(store.locks, 0);
});

test('S25: an id-less list that changed under the lock to something that is not a list is answered as it was read, and nothing is written', async () => {
  const racers = [
    { status: 'ok', value: { not: 'a list' } },
    { status: 'ok', value: null },
    { status: 'corrupt', value: null },
    { status: 'unreadable', value: null },
    { status: 'missing', value: null },
  ];
  for (const second of racers) {
    const store = scripted([{ status: 'ok', value: IDLESS }, second]);
    const w = windowOn(store);
    const answer = await w.get();
    assert.strictEqual(store.locks, 1, JSON.stringify(second));
    assert.deepStrictEqual(answer, { status: 'ok', layout: IDLESS }, 'the list as it was read, not a null the lock produced');
    assert.strictEqual(store.writes, 0, JSON.stringify(second));
    assert.deepStrictEqual(w.sent, [], 'no push of a list that was never written');
    assert.strictEqual(w.sync.last, undefined, 'the watcher is not told a list that never existed');
  }
});

test('S25: an id-less list that is still a list under the lock is given its ids, written once, and pushed', async () => {
  const store = scripted([{ status: 'ok', value: IDLESS }, { status: 'ok', value: IDLESS }]);
  const w = windowOn(store);
  const answer = await w.get();
  assert.strictEqual(store.writes, 1);
  assert.deepStrictEqual(answer.layout.map(p => p.id), ['n1', 'n2']);
  assert.strictEqual(w.sent.length, 1);
  assert.strictEqual(w.sync.last, JSON.stringify(answer.layout));
});

// ---- session-model: only THIS session's transcripts are read ------------------------------------------------------

const NL = String.fromCharCode(10);
const CWD = 'C:/w/proj';
const assistant = (model, at) => ({ type: 'assistant', timestamp: at, message: { model, id: 'msg_' + model } });
const writeLines = (file, lines) => fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join(NL) + NL);

test('S25: a project holding another session\'s transcripts (top-level and subagent) reads only the asked session\'s model and agents', async () => {
  const projectsDir = tmpDir('cc-session-kills-');
  const projectDir = projectDirName(CWD);
  const dir = path.join(projectsDir, projectDir);
  fs.mkdirSync(dir, { recursive: true });

  writeLines(path.join(dir, 'mine.jsonl'), [assistant('model-mine', '2026-01-01T00:00:00.000Z')]);
  writeLines(path.join(dir, 'other.jsonl'), [assistant('model-other', '2026-02-01T00:00:00.000Z')]);

  for (const [sid, model] of [['mine', 'sub-mine'], ['other', 'sub-other']]) {
    const sd = path.join(dir, sid, 'subagents');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'agent-x.meta.json'), JSON.stringify({ agentType: `runner-${sid}` }));
    writeLines(path.join(sd, 'agent-x.jsonl'), [assistant(model, '2026-03-01T00:00:00.000Z')]);
  }

  const r = await readSessionModel({ projectsDir, projectDir, sessionId: 'mine' });
  assert.strictEqual(r.errors, 0);
  assert.strictEqual(r.session.model, 'model-mine', 'the other session\'s newer model must not become this one\'s');
  assert.deepStrictEqual(Object.keys(r.agents), ['runner-mine']);
  assert.strictEqual(r.agents['runner-mine'].model, 'sub-mine');
});
