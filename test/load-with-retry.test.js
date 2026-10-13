'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithRetry } = require('../verify/lib/load-with-retry');

const fakeWin = (log) => ({ destroyed: false, destroy() { this.destroyed = true; log.push('destroy'); } });

test('loadWithRetry: a first load that works returns that window, nothing destroyed', async () => {
  const log = [];
  const win = await loadWithRetry({ open: () => fakeWin(log), load: async () => {} });
  assert.equal(win.destroyed, false);
  assert.deepEqual(log, []);
});

test('loadWithRetry: a rejected load is retried in a fresh window and the failed one is destroyed', async () => {
  const log = [];
  const wins = [];
  let n = 0;
  const win = await loadWithRetry({
    open: () => { const w = fakeWin(log); wins.push(w); return w; },
    load: async () => { if (++n === 1) throw new Error('ERR_FAILED (-2)'); },
  });
  assert.equal(wins.length, 2);
  assert.equal(win, wins[1]);
  assert.equal(wins[0].destroyed, true);
  assert.equal(wins[1].destroyed, false);
});

test('loadWithRetry: a load that never settles times out and is retried', async () => {
  const wins = [];
  let n = 0;
  const win = await loadWithRetry({
    open: () => { const w = fakeWin([]); wins.push(w); return w; },
    load: () => (++n === 1 ? new Promise(() => {}) : Promise.resolve()),
    timeoutMs: 20,
  });
  assert.equal(wins.length, 2);
  assert.equal(wins[0].destroyed, true);
  assert.equal(win, wins[1]);
});

test('loadWithRetry: every attempt failing throws, naming the attempts and the last error, with no window left open', async () => {
  const wins = [];
  await assert.rejects(
    loadWithRetry({
      open: () => { const w = fakeWin([]); wins.push(w); return w; },
      load: async () => { throw new Error('boom'); },
      attempts: 3,
    }),
    /failed after 3 attempts: boom/);
  assert.equal(wins.length, 3);
  assert.ok(wins.every(w => w.destroyed));
});

test('loadWithRetry: a load that throws synchronously is retried too', async () => {
  let n = 0;
  const win = await loadWithRetry({ open: () => fakeWin([]), load: () => { if (++n === 1) throw new Error('sync'); } });
  assert.equal(n, 2);
  assert.equal(win.destroyed, false);
});
