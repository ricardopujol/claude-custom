'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStopByPid } = require('../host/stop-by-pid');

const file = (over = {}) => ({ port: 7701, parsed: { port: 7701, cwd: 'C:\\x', pid: 4242, processStartedAt: '133800000000000000' }, ...over });
const make = (entries, kill) => {
  const calls = [];
  const stop = createStopByPid({ identities: () => entries, kill: async (pid, start) => { calls.push([pid, start]); return kill ? kill(pid, start) : 'killed'; } });
  return { stop, calls };
};

test('a file for the port: its pid and start time go to the proven kill, and the kill\'s word comes back', async () => {
  for (const word of ['killed', 'gone', 'mismatch', 'failed', 'unknown']) {
    const { stop, calls } = make([file()], () => word);
    assert.strictEqual(await stop(7701), word);
    assert.deepStrictEqual(calls, [[4242, '133800000000000000']]);
  }
});

test('only the named port is killed, never a neighbour\'s', async () => {
  const { stop, calls } = make([file({ port: 7700, parsed: { port: 7700, cwd: 'C:\\y', pid: 1111, processStartedAt: '1' } }), file()]);
  await stop(7701);
  assert.deepStrictEqual(calls, [[4242, '133800000000000000']]);
});

test('no file for the port: gone, and nothing is killed', async () => {
  const { stop, calls } = make([file({ port: 7799 })]);
  assert.strictEqual(await stop(7701), 'gone');
  assert.deepStrictEqual(calls, []);
});

test('a file that cannot be proved kills nothing: unreadable, no start time, a bare or odd pid, a list that failed', async () => {
  const bad = [
    [file({ parsed: null, unreadable: true })],
    [file({ parsed: { port: 7701, cwd: 'C:\\x', pid: 4242 } })],
    [file({ parsed: { port: 7701, cwd: 'C:\\x', pid: 4242, processStartedAt: 'yesterday' } })],
    [file({ parsed: { port: 7701, cwd: 'C:\\x', pid: 0, processStartedAt: '1' } })],
    [file({ parsed: { port: 7701, cwd: 'C:\\x', pid: '4242', processStartedAt: '1' } })],
    null,
  ];
  for (const entries of bad) {
    const { stop, calls } = make(entries);
    assert.strictEqual(await stop(7701), 'unknown', JSON.stringify(entries));
    assert.deepStrictEqual(calls, []);
  }
});

test('a kill that throws or answers nonsense is unknown, never a rejection', async () => {
  assert.strictEqual(await make([file()], () => { throw new Error('powershell gone'); }).stop(7701), 'unknown');
  assert.strictEqual(await make([file()], () => 42).stop(7701), 'unknown');
  const listThrows = createStopByPid({ identities: () => { throw new Error('denied'); }, kill: async () => 'killed' });
  assert.strictEqual(await listThrows(7701), 'unknown');
});
