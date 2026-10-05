'use strict';
/**
 * app/resources-display.js (BACKLOG #63): the Resources panel and the top-bar chip, as pure decisions and HTML
 * strings. The rule it keeps: a figure that was not measured reads "—" (or "measuring…" before the second sample),
 * never 0.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const D = require('../app/resources-display');

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const child = (over = {}) => ({ pid: 18432, name: 'node.exe', cmd: 'server.js --port 80', cpu: 30, bytes: 400 * MB, start: '777', canStop: true, ...over });
const session = (over = {}) => ({
  key: 'k-main', label: 'main', hostPid: 20, cpu: 37, bytes: 704 * MB, claude: { pid: 22, cpu: 5, bytes: 300 * MB },
  children: [child(), child({ pid: 5, name: 'bash.exe', cmd: 'bash', cpu: 2, bytes: MB, start: '9' })], more: { count: 2, underOnePct: true }, ...over,
});
const model = (over = {}) => ({
  measuring: false,
  machine: { cpu: 71, mem: { usedBytes: 21.4 * GB, totalBytes: 32 * GB }, ours: { cpu: 12, bytes: 3 * GB } },
  project: {
    cpu: 40, bytes: 1.2 * GB, rows: [session(), session({ key: 'k-feat', label: 'feat', hostPid: 30, cpu: 1, children: [], more: { count: 0, underOnePct: true } })],
    self: { cpu: 4, bytes: 400 * MB, parts: [{ id: 'main', label: 'Electron main', cpu: 1, bytes: 100 * MB, count: 1 }, { id: 'renderers', label: 'Renderers', cpu: 3, bytes: 200 * MB, count: 4 }, { id: 'hosts', label: 'Session hosts', cpu: 0, bytes: 100 * MB, count: 4 }] },
  },
  windows: [{ rootPid: 50, label: 'proj', cpu: 10, bytes: 390 * MB, sessions: 1 }],
  background: { sessions: 1, cpu: 6, bytes: 310 * MB },
  ...over,
});
const payload = (over = {}) => ({ model: model(), status: { stale: false, expired: false, ageMs: 0 }, machine: { cpu: 71, mem: { usedBytes: 21.4 * GB, totalBytes: 32 * GB } }, ...over });
const stateWith = (p = payload(), extra = {}) => ({ ...D.withPayload(D.emptyState(), p), ...extra });

test('fmtCpu: null is a dash, a real zero is 0%, under 1% says so, small values keep a decimal', () => {
  assert.strictEqual(D.fmtCpu(null), '—');
  assert.strictEqual(D.fmtCpu(undefined), '—');
  assert.strictEqual(D.fmtCpu(NaN), '—');
  assert.strictEqual(D.fmtCpu('5'), '—');
  assert.strictEqual(D.fmtCpu(0), '0%');
  assert.strictEqual(D.fmtCpu(0.4), '<1%');
  assert.strictEqual(D.fmtCpu(6.25), '6.3%');
  assert.strictEqual(D.fmtCpu(71.4), '71%');
  assert.strictEqual(D.fmtCpu(100), '100%');
});

test('fmtBytes: null is a dash, MB below a GB, GB with one decimal above', () => {
  assert.strictEqual(D.fmtBytes(null), '—');
  assert.strictEqual(D.fmtBytes(-1), '—');
  assert.strictEqual(D.fmtBytes(0), '0 MB');
  assert.strictEqual(D.fmtBytes(412 * MB), '412 MB');
  assert.strictEqual(D.fmtBytes(21.4 * GB), '21.4 GB');
  assert.strictEqual(D.fmtBytes(32 * GB), '32.0 GB');
});

test('chipView: the machine total, amber from 40%, red from 75%', () => {
  const c = D.chipView(payload());
  assert.strictEqual(c.text, 'CPU 71%  21.4 GB / 32.0 GB');
  assert.strictEqual(c.level, 'amber');
  assert.strictEqual(D.chipView(payload({ machine: { cpu: 75, mem: null } })).level, 'red');
  assert.strictEqual(D.chipView(payload({ machine: { cpu: 74.9, mem: null } })).level, 'amber');
  assert.strictEqual(D.chipView(payload({ machine: { cpu: 39.9, mem: null } })).level, null);
  assert.strictEqual(D.chipView(payload({ machine: { cpu: 40, mem: null } })).level, 'amber');
  assert.match(D.chipView(payload()).title, /Machine total\. Open the Resources panel for who's using it\./);
});

test('chipView: before anything is measured, and with a missing part, the chip says so with dashes, never 0', () => {
  assert.strictEqual(D.chipView(null).text, 'CPU —  — / —');
  assert.strictEqual(D.chipView(null).level, null);
  assert.strictEqual(D.chipView(payload({ machine: { cpu: null, mem: { usedBytes: 4 * GB, totalBytes: 8 * GB } } })).text, 'CPU —  4.0 GB / 8.0 GB');
  assert.strictEqual(D.chipView(payload({ machine: null })).text, 'CPU —  — / —');
});

test('chipView: dimmed while a sample is overdue, a dash for everything once three have failed', () => {
  const stale = D.chipView(payload({ status: { stale: true, expired: false, ageMs: 20000 } }));
  assert.strictEqual(stale.dim, true);
  assert.strictEqual(stale.text, 'CPU 71%  21.4 GB / 32.0 GB', 'the last good figures stay');
  const dead = D.chipView(payload({ status: { stale: true, expired: true, ageMs: 40000 } }));
  assert.strictEqual(dead.text, 'CPU —  — / —');
  assert.strictEqual(dead.level, null);
});

test('the panel: machine bars, this project with a row per tab and claude-custom itself, other windows, the footer', () => {
  const h = D.html(D.view(stateWith()));
  assert.match(h, /Machine/);
  assert.match(h, /This project/);
  assert.match(h, /data-res-key="s:k-main"/);
  assert.match(h, />main</);
  assert.match(h, />feat</);
  assert.match(h, /claude-custom itself/);
  assert.match(h, /Other windows/);
  assert.match(h, />proj</);
  assert.match(h, /background sessions/);
  assert.match(h, /Every 10 s while this panel is shown · paused when hidden/);
});

test('the legend gives both figures: claude-custom and everything else', () => {
  const v = D.view(stateWith());
  assert.match(v.machine.cpuLegend, /claude-custom 12%/);
  assert.match(v.machine.cpuLegend, /everything else 59%/);
  assert.match(v.machine.memLegend, /claude-custom 3\.0 GB/);
  assert.match(v.machine.memLegend, /everything else 18\.4 GB/);
  assert.strictEqual(v.machine.cpuBar.ours, 12);
  assert.strictEqual(v.machine.cpuBar.rest, 59);
});

test('first sample: memory is shown, CPU reads "measuring…" and no bar claims a zero', () => {
  const m = model({ measuring: true,
    machine: { cpu: null, mem: { usedBytes: 10 * GB, totalBytes: 32 * GB }, ours: { cpu: null, bytes: 3 * GB } },
    project: { cpu: null, bytes: GB, rows: [session({ cpu: null, claude: { pid: 22, cpu: null, bytes: 1 }, children: [child({ cpu: null })] })], self: { cpu: null, bytes: 1, parts: [] } },
    windows: [], background: null });
  const v = D.view(stateWith(payload({ model: m, machine: { cpu: null, mem: m.machine.mem } })));
  assert.strictEqual(v.machine.cpuFig, 'measuring…');
  assert.strictEqual(v.machine.cpuBar, null);
  assert.strictEqual(v.project.rows[0].cpuFig, 'measuring…');
  assert.strictEqual(v.machine.memFig, '10.0 GB / 32.0 GB');
  const h = D.html(v);
  assert.doesNotMatch(h, /\b0%/);
});

test('stale: the last good figures stay, dimmed, with "last updated 20 s ago"; expired: dashes', () => {
  const stale = D.view(stateWith(payload({ status: { stale: true, expired: false, ageMs: 20400 } })));
  assert.strictEqual(stale.stale.dim, true);
  assert.strictEqual(stale.stale.text, 'last updated 20 s ago');
  assert.strictEqual(stale.machine.cpuFig, '71%');
  assert.match(D.html(stale), /res-dim/);
  const dead = D.view(stateWith(payload({ status: { stale: true, expired: true, ageMs: 40000 } })));
  assert.strictEqual(dead.machine.cpuFig, '—');
  assert.strictEqual(dead.project.rows[0].cpuFig, '—');
  assert.strictEqual(dead.project.rows[0].memFig, '—');
  assert.strictEqual(dead.stale.text, 'last updated 40 s ago');
  const fresh = D.view(stateWith());
  assert.strictEqual(fresh.stale.dim, false);
  assert.strictEqual(fresh.stale.text, null);
});

test('no payload yet: a loading note, no figures', () => {
  const h = D.html(D.view(D.emptyState()));
  assert.match(h, /measuring…|reading/i);
  assert.doesNotMatch(h, /res-row/);
});

test('a row expands to its top children with name, short command, CPU, memory and Stop, and "+N more, under 1% each"', () => {
  const closed = D.html(D.view(stateWith()));
  assert.doesNotMatch(closed, /server\.js --port 80/);
  const open = D.html(D.view(D.toggle(stateWith(), 's:k-main')));
  assert.match(open, /node\.exe/);
  assert.match(open, /server\.js --port 80/);
  assert.match(open, /data-res-act="ask-stop"/);
  assert.match(open, /\+2 more, under 1% each/);
  assert.match(open, /aria-expanded="true"/);
  assert.strictEqual(D.view(D.toggle(D.toggle(stateWith(), 's:k-main'), 's:k-main')).project.rows[0].expanded, false);
});

test('"+N more" does not claim under 1% when it is not so, and a row with no more has no note', () => {
  const s = stateWith(payload({ model: model({ project: { ...model().project, rows: [session({ more: { count: 3, underOnePct: false } })] } }) }));
  assert.match(D.html(D.view(D.toggle(s, 's:k-main'))), /\+3 more(?!, under)/);
  const none = stateWith(payload({ model: model({ project: { ...model().project, rows: [session({ more: { count: 0, underOnePct: true } })] } }) }));
  assert.doesNotMatch(D.html(D.view(D.toggle(none, 's:k-main'))), /more/);
});

test('a child that may not be stopped has no Stop button', () => {
  const s = stateWith(payload({ model: model({ project: { ...model().project, rows: [session({ children: [child({ canStop: false })] })] } }) }));
  assert.doesNotMatch(D.html(D.view(D.toggle(s, 's:k-main'))), /ask-stop/);
});

test('Stop asks inline: the process, its pid, what stops with it, and two buttons', () => {
  let s = D.toggle(stateWith(), 's:k-main');
  s = D.askStop(s, { pid: 18432, start: '777', name: 'node.exe' });
  const h = D.html(D.view(s));
  assert.match(h, /Stop node\.exe, PID 18432\? Only this process stops, and anything it started stops with it\./);
  assert.match(h, /data-res-act="confirm-stop"[^>]*>Stop it</);
  assert.match(h, /data-res-act="cancel-stop"[^>]*>Cancel</);
  assert.strictEqual(D.view(D.cancelStop(s)).project.rows[0].children[0].confirm, false);
  assert.strictEqual(D.view(s).project.rows[0].children[0].confirm, true);
});

test('after a Stop the row reads "Stopped (PID n)" until the next sample, then it is gone', () => {
  let s = D.toggle(stateWith(), 's:k-main');
  s = D.askStop(s, { pid: 18432, start: '777', name: 'node.exe' });
  s = D.stopResult(s, { pid: 18432, start: '777', name: 'node.exe' }, { ok: true, pid: 18432 });
  assert.strictEqual(s.confirm, null);
  assert.match(D.html(D.view(s)), /Stopped \(PID 18432\)/);
  const next = D.withPayload(s, payload({ model: model({ project: { ...model().project, rows: [session({ children: [child({ pid: 5, name: 'bash.exe', start: '9' })] })] } }) }));
  assert.doesNotMatch(D.html(D.view(next)), /Stopped \(PID/);
  assert.doesNotMatch(D.html(D.view(next)), /node\.exe/);
});

test('a refused Stop says why and keeps the row: "Couldn\'t stop PID n: reason." and "Already exited"', () => {
  let s = D.toggle(stateWith(), 's:k-main');
  const req = { pid: 18432, start: '777', name: 'node.exe' };
  const refused = D.stopResult(D.askStop(s, req), req, { ok: false, reason: 'reused', text: 'that PID now belongs to a different process' });
  const h = D.html(D.view(refused));
  assert.match(h, /Couldn&#39;t stop PID 18432: that PID now belongs to a different process\./);
  assert.match(h, /node\.exe/, 'the row is still there');
  const gone = D.stopResult(D.askStop(s, req), req, { ok: false, reason: 'gone', text: 'Already exited' });
  assert.match(D.html(D.view(gone)), /Already exited/);
  assert.doesNotMatch(D.html(D.view(gone)), /Couldn/);
});

test('a confirm whose process has left the table is dropped by the next sample', () => {
  let s = D.askStop(D.toggle(stateWith(), 's:k-main'), { pid: 18432, start: '777', name: 'node.exe' });
  s = D.withPayload(s, payload({ model: model({ project: { ...model().project, rows: [session({ children: [] })] } }) }));
  assert.strictEqual(s.confirm, null);
});

test('everything the machine says about a process is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const s = stateWith(payload({ model: model({
    project: { ...model().project, rows: [session({ label: evil, children: [child({ name: evil, cmd: evil })] })] },
    windows: [{ rootPid: 50, label: evil, cpu: 1, bytes: 1, sessions: 1 }],
  }) }));
  const h = D.html(D.view(D.toggle(s, 's:k-main')));
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('actionOf reads a click\'s data attributes strictly', () => {
  assert.deepStrictEqual(D.actionOf({ resAct: 'toggle', resKey: 's:k' }), { act: 'toggle', key: 's:k' });
  assert.deepStrictEqual(D.actionOf({ resAct: 'ask-stop', resPid: '18432', resStart: '777', resName: 'node.exe' }), { act: 'ask-stop', pid: 18432, start: '777', name: 'node.exe' });
  assert.deepStrictEqual(D.actionOf({ resAct: 'confirm-stop' }), { act: 'confirm-stop' });
  assert.deepStrictEqual(D.actionOf({ resAct: 'cancel-stop' }), { act: 'cancel-stop' });
  assert.strictEqual(D.actionOf({ resAct: 'ask-stop', resPid: 'abc', resStart: '1', resName: 'x' }), null);
  assert.strictEqual(D.actionOf({ resAct: 'ask-stop', resPid: '0', resStart: '1', resName: 'x' }), null);
  assert.strictEqual(D.actionOf({ resAct: 'ask-stop', resPid: '5', resStart: 'x', resName: 'x' }), null);
  assert.strictEqual(D.actionOf({ resAct: 'toggle' }), null);
  assert.strictEqual(D.actionOf({ resAct: 'rm -rf' }), null);
  assert.strictEqual(D.actionOf(null), null);
  assert.strictEqual(D.actionOf({}), null);
});

test('property: no view ever prints NaN, undefined or null, whatever the payload holds', () => {
  const num = fc.oneof(fc.constant(null), fc.double({ min: 0, max: 400, noNaN: true }), fc.constant(undefined));
  const byt = fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 2 ** 40 }), fc.constant(undefined));
  fc.assert(fc.property(num, byt, fc.boolean(), fc.boolean(), (cpu, bytes, measuring, expired) => {
    const m = model({ measuring,
      machine: { cpu, mem: bytes === null || bytes === undefined ? null : { usedBytes: bytes, totalBytes: bytes + 1 }, ours: { cpu, bytes: bytes || 0 } },
      project: { cpu, bytes: bytes || 0, rows: [session({ cpu, bytes: bytes || 0, claude: { pid: 1, cpu, bytes: bytes || 0 }, children: [child({ cpu, bytes: bytes || 0 })] })], self: { cpu, bytes: bytes || 0, parts: [{ id: 'main', label: 'm', cpu, bytes: bytes || 0, count: 1 }] } },
      windows: [{ rootPid: 5, label: 'w', cpu, bytes: bytes || 0, sessions: 1 }], background: { sessions: 1, cpu, bytes: bytes || 0 } });
    const p = payload({ model: m, machine: m.machine, status: { stale: expired, expired, ageMs: 1000 } });
    const s = D.toggle(D.toggle(stateWith(p), 's:k-main'), 'self');
    const h = D.html(D.view(s));
    assert.doesNotMatch(h, /NaN|undefined|\bnull\b|Infinity/);
    assert.doesNotMatch(D.chipView(p).text, /NaN|undefined|null/);
  }));
});

// ---- PR #113 review round 1 (Miguel I2, I3, S2; Dexter 9, 10) ----

test('I2: after "Stop it" the request is pending: the buttons are disabled and read "Stopping…", and a second press changes nothing', () => {
  let s = D.askStop(D.toggle(stateWith(), 's:k-main'), { pid: 18432, start: '777', name: 'node.exe' });
  s = D.beginStop(s);
  assert.deepStrictEqual(s.pending, { pid: 18432, start: '777', name: 'node.exe' });
  const h = D.html(D.view(s));
  assert.match(h, /data-res-act="confirm-stop" disabled>Stopping…</);
  assert.match(h, /data-res-act="cancel-stop" disabled>Cancel</);
  assert.strictEqual(D.beginStop(s), s, 'a second begin is a no-op');
  assert.strictEqual(D.cancelStop(s), s, 'Cancel cannot withdraw a request already sent');
  const done = D.stopResult(s, { pid: 18432, start: '777', name: 'node.exe' }, { ok: true });
  assert.strictEqual(done.pending, null);
  assert.strictEqual(D.beginStop(D.emptyState()).pending, null, 'nothing to begin without a question asked');
});

test('I3: a bar segment that was not measured is not drawn, never a zero or "everything else is all of it"', () => {
  const m = model({ machine: { cpu: 71, mem: { usedBytes: 21.4 * GB, totalBytes: 32 * GB }, ours: { cpu: null, bytes: null } } });
  const v = D.view(stateWith(payload({ model: m })));
  assert.strictEqual(v.machine.cpuBar, null);
  assert.strictEqual(v.machine.memBar, null);
  assert.match(D.html(v), /res-bar res-bar-empty/);
  assert.match(v.machine.cpuLegend, /claude-custom — · everything else —/);
});

test('D10: when claude-custom\'s private bytes exceed the machine\'s physical use the difference means nothing: "—", not 0 B', () => {
  const m = model({ machine: { cpu: 10, mem: { usedBytes: 16 * GB, totalBytes: 32 * GB }, ours: { cpu: 5, bytes: 20 * GB } } });
  const v = D.view(stateWith(payload({ model: m })));
  assert.match(v.machine.memLegend, /claude-custom 20\.0 GB · everything else —$/);
  assert.strictEqual(v.machine.memBar, null);
  assert.doesNotMatch(v.machine.memLegend, /0 MB|0\.0 GB$/);
  const fine = D.view(stateWith());
  assert.match(fine.machine.memLegend, /everything else 18\.4 GB/);
});

test('D9: a child whose memory is unknown reads "—", not "0 MB"', () => {
  const s = stateWith(payload({ model: model({ project: { ...model().project, rows: [session({ children: [child({ bytes: null })] })] } }) }));
  const v = D.view(D.toggle(s, 's:k-main'));
  assert.strictEqual(v.project.rows[0].children[0].memFig, '—');
});

test('S2: a quote in a process name or command cannot break out of an attribute', () => {
  const evil = '" onmouseover="alert(1)';
  const s = stateWith(payload({ model: model({ project: { ...model().project, rows: [session({ children: [child({ name: evil, cmd: evil })] })] } }) }));
  const h = D.html(D.view(D.toggle(s, 's:k-main')));
  assert.match(h, /data-res-name="&quot; onmouseover=&quot;alert\(1\)"/);
  assert.match(h, /title="&quot; onmouseover=&quot;alert\(1\)"/);
  assert.doesNotMatch(h, /"\s+onmouseover="/);
});
