'use strict';
/**
 * verify/probe-quit-linger.js's pure parts (BACKLOG #74 A): the type of a process from its command line, and the per-process
 * summary of the 250 ms samples (when it left, how long it was 1 thread / 0 handles, the path of its counts).
 */
const test = require('node:test');
const assert = require('node:assert');
const { classify, summarise } = require('../verify/probe-quit-linger');

test('classify: a --type= switch names it; the root is the browser; the host and its watchdog are told apart; no command line is unreadable', () => {
  assert.strictEqual(classify('"C:\\x\\electron.exe" --type=gpu-process --user-data-dir="C:\\u"', false), 'gpu-process');
  assert.strictEqual(classify('"C:\\x\\electron.exe" --type=renderer --enable-features=X', false), 'renderer');
  assert.strictEqual(classify('C:\\x\\electron.exe C:\\repo --user-data-dir=C:\\u', true), 'browser');
  assert.strictEqual(classify('C:\\x\\electron.exe C:\\repo\\host\\host.js', false), 'host');
  assert.strictEqual(classify('C:\\x\\electron.exe C:\\repo/host/host.js --port 1', false), 'host');
  assert.strictEqual(classify('C:\\x\\electron.exe C:\\repo\\host\\bounded-watchdog.js 12 45000', false), 'host-watchdog');
  assert.strictEqual(classify('C:\\x\\electron.exe C:\\repo\\verify\\lib\\thing.js', false), 'node:thing.js');
  assert.strictEqual(classify('C:\\x\\electron.exe', false), 'node');
  assert.strictEqual(classify('', false), 'unreadable');
  assert.strictEqual(classify(null, true), 'unreadable');
  // A --type= wins even for the root (a root is never a child type, but the switch is what the process says it is).
  assert.strictEqual(classify('electron.exe --type=utility', true), 'utility');
});

const row = (thr, hnd, extra = {}) => ({ thr, hnd, privMB: 10, base: 8, ready: 0, running: 0, minPri: 4, maxPri: 8, ...extra });
const sample = (t, entries) => ({ t, rows: new Map(entries), cpu: null });

test('summarise: gone at the first sample that misses it, in seconds after the close; samples before the close are ignored', () => {
  const tracked = [{ pid: 1, type: 'browser', privMB: 90 }, { pid: 2, type: 'renderer', privMB: 50 }];
  const samples = [
    sample(900, [[1, row(40, 800)], [2, row(10, 400)]]),     // before the close (t0 = 1000): ignored, even though 2 is listed
    sample(1250, [[1, row(40, 800)]]),                       // 2 already gone
    sample(1500, [[1, row(40, 790)]]),
    sample(4000, []),
  ];
  const [b, r] = summarise(tracked, samples, 1000);
  assert.strictEqual(r.goneAfterS, 0.25);
  assert.strictEqual(b.goneAfterS, 3);
  assert.strictEqual(b.privMBBefore, 90);
  assert.deepStrictEqual(b.path.length, 2, 'one entry per change of the counts');
});

test('summarise: never missing is goneAfterS null (still there at the end of the watch)', () => {
  const [p] = summarise([{ pid: 7, type: 'gpu-process', privMB: 150 }], [sample(1100, [[7, row(1, 600)]]), sample(1350, [[7, row(1, 600)]])], 1000);
  assert.strictEqual(p.goneAfterS, null);
});

test('summarise: the zombie stretch is the latest unbroken run of 1 thread / 0 handles, in seconds', () => {
  const samples = [
    sample(1000, [[3, row(1, 0)]]),
    sample(1500, [[3, row(1, 0)]]),
    sample(2000, [[3, row(2, 5)]]),      // broken: not zombie-shaped
    sample(3000, [[3, row(1, 0)]]),
    sample(5000, [[3, row(1, 0)]]),
    sample(6000, []),
  ];
  const [p] = summarise([{ pid: 3, type: 'utility', privMB: 14 }], samples, 1000);
  assert.strictEqual(p.zombieS, 2);
  assert.strictEqual(p.goneAfterS, 5);
});

test('summarise: the path records threads, handles, base priority, ready threads and the priority range at each change', () => {
  const samples = [
    sample(1250, [[4, row(47, 630, { base: 10, ready: 0, minPri: 1, maxPri: 13 })]]),
    sample(1500, [[4, row(47, 630, { base: 10, ready: 0, minPri: 1, maxPri: 13 })]]),
    sample(3000, [[4, row(25, 587, { base: 10, ready: 25, minPri: 1, maxPri: 4 })]]),
  ];
  const [p] = summarise([{ pid: 4, type: 'gpu-process', privMB: 150 }], samples, 1000);
  assert.deepStrictEqual(p.path, ['0.25s:47t/630h/10MB/b10/r0/run0/p1-13', '2.00s:25t/587h/10MB/b10/r25/run0/p1-4']);
});
