'use strict';
// `claude-custom <folder> --stop` (Windowless sessions PR 3): every session
// serving a folder is stopped by PR 1's rules before the folder is removed.
const test = require('node:test');
const assert = require('node:assert');
const { serves, stopFolder, stopExitCode, stopReportLines } = require('../host/stop-folder');

const row = (over = {}) => ({ install: 'C:\\cc\\dev', build: 'dev', own: true, port: 7701, pid: 101,
  cwd: 'C:\\proj\\feat-a', startedAt: 1, processStartedAt: '1', exact: true, windows: 0, ...over });

test('serves: the folder itself, any spelling, and folders inside it', () => {
  assert.strictEqual(serves(row(), 'C:\\proj\\feat-a'), true);
  assert.strictEqual(serves(row(), 'c:/PROJ/feat-a/'), true);
  assert.strictEqual(serves(row({ cwd: 'C:\\proj\\feat-a\\src' }), 'C:\\proj\\feat-a'), true);
});

test('serves: never a sibling that shares a prefix, nor the folder above', () => {
  assert.strictEqual(serves(row({ cwd: 'C:\\proj\\feat-ab' }), 'C:\\proj\\feat-a'), false);
  assert.strictEqual(serves(row({ cwd: 'C:\\proj' }), 'C:\\proj\\feat-a'), false);
  assert.strictEqual(serves(row({ cwd: null }), 'C:\\proj\\feat-a'), false);
});

test('stopFolder: stops only the sessions serving the folder, one at a time, in list order', async () => {
  const a = row({ pid: 1, cwd: 'C:\\proj\\feat-a' });
  const b = row({ pid: 2, cwd: 'C:\\proj\\feat-b' });
  const c = row({ pid: 3, cwd: 'C:\\proj\\feat-a\\sub' });
  const asked = [];
  let inFlight = 0;
  const rep = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => ({ rows: [a, b, c], verified: true }),
    stopHost: async (r) => {
      inFlight += 1;
      assert.strictEqual(inFlight, 1, 'one at a time');
      asked.push(r.pid);
      await new Promise(res => setImmediate(res));
      inFlight -= 1;
      return { outcome: 'stopped', text: 'Stopped that session.' };
    },
  });
  assert.deepStrictEqual(asked, [1, 3]);
  assert.deepStrictEqual(rep.results.map(r => [r.row.pid, r.outcome]), [[1, 'stopped'], [3, 'stopped']]);
  assert.strictEqual(rep.kept, 0);
  assert.strictEqual(stopExitCode(rep), 0);
});

test('stopFolder: a session with a window, or one it could not prove, is kept, and the exit code says so', async () => {
  const outcomes = { 1: 'has-window', 2: 'gone', 3: 'unproven' };
  const rep = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => ({ rows: [row({ pid: 1 }), row({ pid: 2 }), row({ pid: 3 })], verified: true }),
    stopHost: async r => ({ outcome: outcomes[r.pid], text: `t${r.pid}` }),
  });
  assert.strictEqual(rep.kept, 2);
  assert.strictEqual(stopExitCode(rep), 3);
});

test('stopFolder: a stopHost that throws is a failure for that session, and the others still run', async () => {
  const rep = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => ({ rows: [row({ pid: 1 }), row({ pid: 2 })], verified: true }),
    stopHost: async (r) => { if (r.pid === 1) throw new Error('boom'); return { outcome: 'stopped', text: 'ok' }; },
  });
  assert.deepStrictEqual(rep.results.map(r => r.outcome), ['failed', 'stopped']);
  assert.match(rep.results[0].text, /boom/);
  assert.strictEqual(stopExitCode(rep), 3);
});

test('stopFolder: nothing serving the folder is success -- unless the list could not be checked', async () => {
  const none = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => ({ rows: [row({ cwd: 'C:\\elsewhere' })], verified: true }),
    stopHost: async () => assert.fail('nothing to stop'),
  });
  assert.strictEqual(none.results.length, 0);
  assert.strictEqual(stopExitCode(none), 0);
  const unsure = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => ({ rows: [], verified: false }),
    stopHost: async () => assert.fail('nothing to stop'),
  });
  assert.strictEqual(stopExitCode(unsure), 3, 'a session may be missing from the list: never claim the folder is free');
});

// Found by the real-host probe: one stale identity whose pid Windows reused for
// a process with an unreadable start time made EVERY --stop exit 3. A doubt
// only matters to the folder it could be serving.
test('stopFolder: a doubt about a session in ANOTHER folder does not make this folder unsure', async () => {
  const rep = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => ({ rows: [], verified: false, doubts: [{ install: 'C:\\cc\\dev', cwd: 'C:\\Temp\\old-probe' }] }),
    stopHost: async () => assert.fail('nothing to stop'),
  });
  assert.strictEqual(rep.verified, true);
  assert.strictEqual(stopExitCode(rep), 0);
});

test('stopFolder: a doubt about this folder, or one inside it, keeps it unsure', async () => {
  for (const cwd of ['C:\\proj\\feat-a', 'c:\\PROJ\\feat-a\\sub']) {
    const rep = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
      list: async () => ({ rows: [], verified: false, doubts: [{ install: 'C:\\cc\\dev', cwd }] }),
      stopHost: async () => assert.fail('nothing to stop'),
    });
    assert.strictEqual(stopExitCode(rep), 3, cwd);
  }
});

test('stopFolder: a doubt with no folder (an install it could not list) could be serving any folder', async () => {
  const rep = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => ({ rows: [], verified: false, doubts: [{ install: 'C:\\cc\\dev', cwd: null }] }),
    stopHost: async () => assert.fail('nothing to stop'),
  });
  assert.strictEqual(stopExitCode(rep), 3);
});

test('stopFolder: unverified with no doubts listed stays unverified (nothing to scope by)', async () => {
  const rep = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => ({ rows: [], verified: false }),
    stopHost: async () => assert.fail('nothing to stop'),
  });
  assert.strictEqual(stopExitCode(rep), 3);
});

test('stopFolder: a list that throws is unverified, never "nothing running"', async () => {
  const rep = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => { throw new Error('no powershell'); },
    stopHost: async () => assert.fail('nothing to stop'),
  });
  assert.strictEqual(rep.verified, false);
  assert.strictEqual(stopExitCode(rep), 3);
});

test('stopReportLines: one line per session with folder, build, pid and what happened', async () => {
  const rep = { folder: 'C:\\proj\\feat-a', verified: true, kept: 1, results: [
    { row: row({ pid: 1 }), outcome: 'stopped', text: 'Stopped that session.' },
    { row: row({ pid: 2, build: 'feat-x' }), outcome: 'has-window', text: "That session has a window open, so it wasn't stopped." },
  ] };
  const lines = stopReportLines(rep);
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^stopped: C:\\proj\\feat-a \(build dev, pid 1\) -- Stopped that session\.$/);
  assert.match(lines[1], /^kept: .*build feat-x, pid 2.*window open/);
});

test('stopReportLines: says so when nothing is serving the folder, and when the list was incomplete', () => {
  assert.deepStrictEqual(stopReportLines({ folder: 'C:\\f', verified: true, kept: 0, results: [] }),
    ['no claude-custom session is serving C:\\f']);
  const lines = stopReportLines({ folder: 'C:\\f', verified: false, kept: 0, results: [] });
  assert.strictEqual(lines.length, 2);
  assert.match(lines[1], /couldn't check every session/i);
});
