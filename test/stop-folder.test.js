'use strict';
// `claude-custom <folder> --stop` (Windowless sessions PR 3): every session
// serving a folder is stopped by PR 1's rules before the folder is removed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { serves, inFolder, stopFolder, stopRows, stopExitCode, stopReportLines } = require('../host/stop-folder');
const { tmpDir } = require('./tmp-dir');

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

// Dexter, PR #83 F2 (High): a host running FROM a build inside the folder holds
// it too, whatever folder it serves; removing the folder orphans that host.
test('serves: a session whose build lives inside the folder, whatever folder it works in', () => {
  const r = row({ install: 'C:\\VibeCode\\claude-custom\\feat-x', cwd: 'C:\\VibeCode\\sfx-manager\\dev' });
  assert.strictEqual(serves(r, 'C:\\VibeCode\\claude-custom\\feat-x'), true);
  assert.strictEqual(serves(r, 'C:\\VibeCode\\claude-custom\\feat-xy'), false);
  assert.strictEqual(inFolder(r.cwd, 'C:\\VibeCode\\claude-custom'), false, 'inFolder is the cwd alone');
});

// Dexter, PR #83 F4: the same folder reached through a junction (or a short
// name) is still that folder.
test('serves: a folder reached through a junction is the same folder, both ways round', () => {
  const base = tmpDir('stop-folder-junction-');
  const real = path.join(base, 'real-lane');
  fs.mkdirSync(path.join(real, 'src'), { recursive: true });
  const link = path.join(base, 'linked');
  fs.symlinkSync(real, link, 'junction');
  assert.strictEqual(serves(row({ install: 'C:\\elsewhere', cwd: path.join(link, 'src') }), real), true);
  assert.strictEqual(serves(row({ install: 'C:\\elsewhere', cwd: path.join(real, 'src') }), link), true);
  assert.strictEqual(inFolder(path.join(link, 'src'), real), true);
});

test('stopRows: one at a time; a throw is a failure for that row, with one full stop at the end (Miguel G1)', async () => {
  const res = await stopRows([row({ pid: 1 }), row({ pid: 2 })], async (r) => {
    if (r.pid === 1) throw new Error('it hung up.');
    return { outcome: 'stopped', text: 'Stopped that session.', how: 'stop-if-idle' };
  });
  assert.deepStrictEqual(res.map(x => x.outcome), ['failed', 'stopped']);
  assert.strictEqual(res[0].text, "Couldn't stop that session: it hung up.");
  assert.strictEqual(res[1].how, 'stop-if-idle');
});

// Dexter, PR #83 F5: a session that starts for the folder while others are
// being stopped (each up to 15 s) must not be missed.
test('stopFolder: lists again after stopping, and stops a session that started meanwhile', async () => {
  const a = row({ pid: 1 });
  const b = row({ pid: 2, processStartedAt: '2' });
  let lists = 0;
  const asked = [];
  const rep = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => { lists += 1; return { rows: lists === 1 ? [a] : [a, b], verified: true }; },
    stopHost: async (r) => { asked.push(r.pid); return { outcome: 'stopped', text: 'ok' }; },
  });
  assert.deepStrictEqual(asked, [1, 2]);
  assert.strictEqual(stopExitCode(rep), 0);
});

test('stopFolder: sessions that keep arriving end in exit 3, never an endless loop', async () => {
  let n = 0;
  const rep = await stopFolder({ folder: 'C:\\proj\\feat-a' }, {
    list: async () => { n += 1; return { rows: [row({ pid: 100 + n, processStartedAt: String(n) })], verified: true }; },
    stopHost: async () => ({ outcome: 'stopped', text: 'ok' }),
  });
  assert.ok(n <= 5, `listed ${n} times`);
  assert.strictEqual(rep.late > 0, true);
  assert.strictEqual(stopExitCode(rep), 3);
  assert.match(stopReportLines(rep).join('\n'), /kept starting/);
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

test('stopReportLines: says so when nothing is serving the folder', () => {
  assert.deepStrictEqual(stopReportLines({ folder: 'C:\\f', verified: true, kept: 0, late: 0, results: [] }),
    ['no claude-custom session is serving C:\\f']);
});

// Miguel, PR #83 Y1: "nothing is serving it" is a claim; an incomplete list
// can't make it.
test('stopReportLines: an incomplete list never claims nothing is serving the folder', () => {
  const lines = stopReportLines({ folder: 'C:\\f', verified: false, kept: 0, late: 0, results: [] });
  assert.strictEqual(lines.length, 1);
  assert.doesNotMatch(lines[0], /^no claude-custom session is serving/);
  assert.match(lines[0], /not every session could be checked/i);
  const withRows = stopReportLines({ folder: 'C:\\f', verified: false, kept: 0, late: 0,
    results: [{ row: row(), outcome: 'stopped', text: 'Stopped that session.' }] });
  assert.match(withRows[withRows.length - 1], /not every session could be checked/i);
});
