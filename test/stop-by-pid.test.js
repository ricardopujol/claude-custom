'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStopByPid } = require('../host/stop-by-pid');

const CWD = 'C:\\Users\\ricar\\proj\\feat-a';
const WHO = { cwd: CWD, side: false, shell: false };
const file = (over = {}) => ({ port: 7701, parsed: { port: 7701, cwd: CWD, pid: 4242, processStartedAt: '133800000000000000' }, ...over });
const parsedWith = (over) => file({ parsed: { port: 7701, cwd: CWD, pid: 4242, processStartedAt: '133800000000000000', ...over } });
const make = (entries, kill, opts = {}) => {
  const calls = [];
  const stop = createStopByPid({ identities: () => entries, kill: async (pid, start) => { calls.push([pid, start]); return kill ? kill(pid, start) : 'killed'; }, ...opts });
  return { stop, calls };
};

test('a file for the port: its pid and start time go to the proven kill, and the kill\'s word comes back', async () => {
  for (const word of ['killed', 'gone', 'mismatch', 'failed', 'unknown']) {
    const { stop, calls } = make([file()], () => word);
    assert.strictEqual(await stop(7701, WHO), word);
    assert.deepStrictEqual(calls, [[4242, '133800000000000000']]);
  }
});

test('only the named port is killed, never a neighbour\'s', async () => {
  const { stop, calls } = make([file({ port: 7700, parsed: { port: 7700, cwd: 'C:\\y', pid: 1111, processStartedAt: '1' } }), file()]);
  await stop(7701, WHO);
  assert.deepStrictEqual(calls, [[4242, '133800000000000000']]);
});

test('no file for the port: nofile, and nothing is killed (it is the shell that decides what a missing file means)', async () => {
  const { stop, calls } = make([file({ port: 7799 })]);
  assert.strictEqual(await stop(7701, WHO), 'nofile');
  assert.deepStrictEqual(calls, []);
});

// --- Dexter 1 / Miguel B1 (PR #231): the proof has to bind to THIS tab's host, not to the port ---------------------------

test('Dexter 1: the file for the port names ANOTHER folder (its host took the port since): a stranger, and nothing is killed', async () => {
  const { stop, calls } = make([parsedWith({ cwd: 'C:\\Users\\ricar\\proj\\feat-b' })], () => 'killed');
  assert.strictEqual(await stop(7701, WHO), 'stranger');
  assert.deepStrictEqual(calls, []);
});

test('Dexter 1: the same folder but another KIND of host (a side session or a shell on the folder) is a stranger too', async () => {
  for (const over of [{ side: true }, { kind: 'shell' }]) {
    const { stop, calls } = make([parsedWith(over)]);
    assert.strictEqual(await stop(7701, WHO), 'stranger', JSON.stringify(over));
    assert.deepStrictEqual(calls, []);
  }
  const side = make([parsedWith({ side: true })]);
  assert.strictEqual(await side.stop(7701, { cwd: CWD, side: true, shell: false }), 'killed', 'a side tab\'s own host is its own');
  const shell = make([parsedWith({ kind: 'shell' })]);
  assert.strictEqual(await shell.stop(7701, { cwd: CWD, side: false, shell: true }), 'killed');
  const asBranch = make([file()]);
  assert.strictEqual(await asBranch.stop(7701, { cwd: CWD, side: true, shell: false }), 'stranger', 'a side tab never ends the branch host');
});

test('Dexter 1: the folder is compared as the shell compares folders (case, slashes, a trailing slash)', async () => {
  const { stop, calls } = make([parsedWith({ cwd: 'c:/users/RICAR/proj/feat-a/' })]);
  assert.strictEqual(await stop(7701, WHO), 'killed');
  assert.strictEqual(calls.length, 1);
});

test('Dexter 1: without a folder to compare, or with a file whose port is not its name\'s, nothing is killed', async () => {
  for (const who of [undefined, null, {}, { cwd: '' }, { cwd: 5 }]) {
    const { stop, calls } = make([file()]);
    assert.strictEqual(await stop(7701, who), 'unknown', JSON.stringify(who));
    assert.deepStrictEqual(calls, []);
  }
  const moved = make([parsedWith({ port: 7702 })]);
  assert.strictEqual(await moved.stop(7701, WHO), 'unknown', 'something moved this file: nothing in it is worth trusting');
  assert.deepStrictEqual(moved.calls, []);
});

test('a file that cannot be proved kills nothing: unreadable, no start time, a bare or odd pid, a list that failed', async () => {
  const bad = [
    [file({ parsed: null, unreadable: true })],
    [parsedWith({ processStartedAt: undefined })],
    [parsedWith({ processStartedAt: 'yesterday' })],
    [parsedWith({ pid: 0 })],
    [parsedWith({ pid: '4242' })],
    null,
  ];
  for (const entries of bad) {
    const { stop, calls } = make(entries);
    assert.strictEqual(await stop(7701, WHO), 'unknown', JSON.stringify(entries));
    assert.deepStrictEqual(calls, []);
  }
});

test('a kill that throws or answers nonsense is unknown, never a rejection', async () => {
  assert.strictEqual(await make([file()], () => { throw new Error('powershell gone'); }).stop(7701, WHO), 'unknown');
  assert.strictEqual(await make([file()], () => 42).stop(7701, WHO), 'unknown');
  const listThrows = createStopByPid({ identities: () => { throw new Error('denied'); }, kill: async () => 'killed' });
  assert.strictEqual(await listThrows(7701, WHO), 'unknown');
});

test('Dexter 6 / Miguel G2: a file naming this process or the one that started it is never killed (stop-holder\'s rule)', async () => {
  for (const pid of [4242, 99]) {
    const { stop, calls } = make([parsedWith({ pid })], null, { ownPids: [pid === 4242 ? 4242 : 7, pid === 99 ? 99 : 8] });
    assert.strictEqual(await stop(7701, WHO), 'unknown', String(pid));
    assert.deepStrictEqual(calls, []);
  }
  const other = make([file()], null, { ownPids: [1, 2] });
  assert.strictEqual(await other.stop(7701, WHO), 'killed');
});
