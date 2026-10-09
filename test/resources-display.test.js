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
  assert.match(D.chipView(payload()).title, /Machine total and the last hour\. Click for the graphs\./);
});

test('chipView: the two figures come apart (a sparkline sits after each), and an unmeasured one is a dash', () => {
  const c = D.chipView(payload());
  assert.strictEqual(c.cpuText, 'CPU 71%');
  assert.strictEqual(c.memText, '21.4 GB / 32.0 GB');
  assert.strictEqual(D.chipView(null).cpuText, 'CPU —');
  assert.strictEqual(D.chipView(null).memText, '— / —');
  assert.strictEqual(D.chipView(payload({ machine: { cpu: null, mem: { usedBytes: 4 * GB, totalBytes: 8 * GB } } })).cpuText, 'CPU —');
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
  assert.match(h, /Every 10 s · paused while minimised/);
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

test('N5: a Stop that ended the process but not all its children says so, with the PIDs', () => {
  let s = D.toggle(stateWith(), 's:k-main');
  const req = { pid: 18432, start: '777', name: 'node.exe' };
  const one = D.stopResult(D.askStop(s, req), req, { ok: true, pid: 18432, failedChildren: [{ pid: 18500, text: 'Access is denied' }] });
  assert.match(D.html(D.view(one)), /Stopped \(PID 18432\); couldn't stop 1 child \(PID 18500\)/);
  const two = D.stopResult(D.askStop(s, req), req, { ok: true, pid: 18432, failedChildren: [{ pid: 18500 }, { pid: 18501 }] });
  assert.match(D.html(D.view(two)), /couldn't stop 2 children \(PIDs 18500, 18501\)/);
  const clean = D.stopResult(D.askStop(s, req), req, { ok: true, pid: 18432, failedChildren: [] });
  assert.doesNotMatch(D.html(D.view(clean)), /couldn/);
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

test('Q5: a child is ONE line: name, CPU, memory, then a small square Stop with its accessible label; the command is the hover text', () => {
  const h = D.html(D.view(D.toggle(stateWith(), 's:k-main')));
  const row = /<div class="res-child" title="server\.js --port 80">(.*?)<\/div>/.exec(h);
  assert.ok(row, 'the command line is the row\'s title');
  const order = [...row[1].matchAll(/class="(res-cname|res-fig|res-stop)"/g)].map(m => m[1]);
  assert.deepStrictEqual(order, ['res-cname', 'res-fig', 'res-fig', 'res-stop']);
  assert.match(row[1], /aria-label="Stop node\.exe, PID 18432" title="Stop node\.exe, PID 18432">■<\/button>/);
  assert.doesNotMatch(h, /res-ccmd/, 'no line of its own for the command');
  assert.doesNotMatch(row[1], />server\.js/, 'and not repeated as text');
});

test('Q5: a child that may not be stopped keeps the line\'s shape (an empty slot, no button)', () => {
  const s = stateWith(payload({ model: model({ project: { ...model().project, rows: [session({ children: [child({ canStop: false })] })] } }) }));
  const h = D.html(D.view(D.toggle(s, 's:k-main')));
  assert.match(h, /res-stop-gap/);
  assert.doesNotMatch(h, /ask-stop/);
});

test('a child row\'s hover text is its FULL command line, and its Stop label names what the row shows', () => {
  const s = stateWith(payload({ model: model({ project: { ...model().project, rows: [session({ children: [child({ pid: 77, name: 'burn.js', cmd: '.../burn.js 8', full: 'node "C:/a b/burn.js" 8 out.pid 100' })] })] } }) }));
  const h = D.html(D.view(D.toggle(s, 's:k-main')));
  assert.match(h, /<div class="res-child" title="node &quot;C:\/a b\/burn\.js&quot; 8 out\.pid 100"><span class="res-cname">burn\.js</);
  assert.match(h, /aria-label="Stop burn\.js, PID 77"/);
});

test('D8: the page\'s chip on/off: a payload with a real boolean wins, anything else keeps what the page had', () => {
  assert.strictEqual(D.nextChipOn(true, { chipOn: false }), false);
  assert.strictEqual(D.nextChipOn(false, { chipOn: true }), true);
  for (const p of [null, undefined, {}, { chipOn: 'false' }, { chipOn: 0 }, { chipOn: null }]) {
    assert.strictEqual(D.nextChipOn(false, p), false, JSON.stringify(p));
    assert.strictEqual(D.nextChipOn(true, p), true, JSON.stringify(p));
  }
});

test('S5: the empty spacer that keeps the Stop column aligned is hidden from assistive tech', () => {
  const s = stateWith(payload({ model: model({ project: { ...model().project, rows: [session({ children: [child({ pid: 5, name: 'bash.exe', start: '9', canStop: false })] })] } }) }));
  const h = D.html(D.view(D.toggle(s, 's:k-main')));
  assert.match(h, /<span class="res-stop-gap" aria-hidden="true"><\/span>/);
});

// ---- Leftovers (BACKLOG #74 item 6, option A) -----------------------------------------------------------------------

const MINUTE = 60_000;
const lrow = (over = {}) => ({ kind: 'probe-window', pid: 100, start: '5', name: 'electron.exe', what: 'probe-x', label: 'probe-x', bytes: 230 * MB, ageMs: 12 * MINUTE, provable: true, reapable: true, reapInMs: 3 * MINUTE, nested: false, ...over });
const unproven = (over = {}) => lrow({ provable: false, reapable: false, reapInMs: null, ...over });
const leftovers = (over = {}) => ({ stuck: [], probes: [], shells: [], mcp: [], stopped: [], reapAfterMs: 15 * MINUTE, ...over });
const leftoverView = (l, state = {}) => D.view({ ...stateWith(payload({ leftovers: l })), ...state }).leftovers;
const leftoverHtml = (l, state = {}) => D.html(D.view({ ...stateWith(payload({ leftovers: l })), ...state }));

test('Leftovers: no section when there is nothing to show (null), and nothing is drawn for it', () => {
  assert.strictEqual(D.view(stateWith(payload())).leftovers, null);
  assert.strictEqual(leftoverView(null), null);
  assert.strictEqual(leftoverView('nope'), null);
  assert.strictEqual(leftoverView(leftovers()), null, 'every list empty is the same as none');
  const html = D.html(D.view(stateWith(payload())));
  assert.ok(!html.includes('Leftovers') && !html.includes('left over'));
});

test('Leftovers (S6): a payload with only "stopped" still makes a section, with no groups and no chip', () => {
  const v = leftoverView(leftovers({ stopped: [{ kind: 'probe-window', pid: 7, what: 'probe-y', bytes: 120 * MB, at: 1 }] }));
  assert.deepStrictEqual(v.stopped.map(s => s.text), ['Stopped probe-y (PID 7), 120 MB freed']);
  assert.strictEqual(v.groups.length, 0);
  assert.strictEqual(v.chip, null);
  assert.ok(D.html(D.view(stateWith(payload({ leftovers: leftovers({ stopped: [{ pid: 7, what: 'p', bytes: MB }] }) })))).includes('Stopped'));
});

test('Leftovers: the four kinds are grouped under their own titles, in order, empty groups left out, each with its left-edge colour', () => {
  const v = leftoverView(leftovers({
    mcp: [unproven({ kind: 'mcp', what: 'chrome-devtools-mcp', session: 'main' })],
    stuck: [unproven({ kind: 'stuck', what: 'Electron' })],
    probes: [lrow()],
    shells: [unproven({ kind: 'shell', what: 'bash.exe' })],
  }));
  assert.deepStrictEqual(v.groups.map(g => [g.title, g.edge]), [
    ['Stuck closing', 'res-edge-red'], ['Probe windows nobody is running', 'res-edge-yellow'], ['Agent shells still running', 'res-edge-yellow'], ['MCP servers', 'res-edge-grey'],
  ]);
});

test('Leftovers: the title carries an "N left over" chip, counting listed rows', () => {
  const v = leftoverView(leftovers({ probes: [lrow(), lrow({ pid: 101 })], mcp: [unproven({ kind: 'mcp' })] }));
  assert.strictEqual(v.chip, '3 left over');
  const html = leftoverHtml(leftovers({ probes: [lrow()] }));
  assert.match(html, /<div class="res-title">Resources <span class="res-chip">1 left over<\/span><\/div>/);
  assert.ok(html.indexOf('res-title') < html.indexOf('<h3>Leftovers'));
});

test('Leftovers: a row reads name, then memory, then age (MB before age), and the figures are dashes when not measured', () => {
  const html = leftoverHtml(leftovers({ probes: [lrow({ ageMs: 5 * 3600_000 + 10 * MINUTE })] }));
  assert.ok(html.indexOf('230 MB') < html.indexOf('5 h'), 'memory before age');
  const v = leftoverView(leftovers({ probes: [lrow({ ageMs: 5 * 3600_000 + 10 * MINUTE }), lrow({ pid: 7, bytes: null, ageMs: null }), lrow({ pid: 8, ageMs: 20_000 })] }));
  assert.deepStrictEqual(v.groups[0].rows.map(r => [r.memFig, r.ageFig]), [['230 MB', '5 h'], ['—', '—'], ['230 MB', '<1 min']]);
});

test('Leftovers: a row says what happens to it: when it stops, that Windows is closing it, or that it is kept', () => {
  const v = leftoverView(leftovers({
    stuck: [unproven({ kind: 'stuck', what: 'Electron' })],
    probes: [lrow({ reapInMs: 3 * MINUTE }), lrow({ pid: 101, reapInMs: 0 }), lrow({ pid: 102, reapInMs: 90_000 })],
    shells: [unproven({ kind: 'shell', what: 'bash.exe' }), lrow({ pid: 40, kind: 'agent-shell', reapable: false, reapInMs: null })],
  }));
  const notes = Object.fromEntries(v.groups.map(g => [g.title, g.rows.map(r => r.note)]));
  assert.deepStrictEqual(notes['Stuck closing'], [''], 'the stuck explanation is stated once under the group, not per row');
  assert.deepStrictEqual(notes['Probe windows nobody is running'], ['stops in 3 min', 'stopping…', 'stops in 2 min']);
  assert.deepStrictEqual(notes['Agent shells still running'], ["kept: can't tell whether an agent still needs it", "kept: can't tell whether an agent still needs it"], 'a provable shell is kept too: never stopped on its own');
});

test('Leftovers (B): a Stop button only on a provable row, "Stop N" only on a group that has some; MCP and stuck rows never get one', () => {
  const v = leftoverView(leftovers({
    stuck: [unproven({ kind: 'stuck' })], mcp: [unproven({ kind: 'mcp' })],
    probes: [lrow(), lrow({ pid: 101 })], shells: [unproven({ kind: 'shell' }), lrow({ pid: 40, kind: 'agent-shell', reapable: false, reapInMs: null })],
  }));
  const g = Object.fromEntries(v.groups.map(x => [x.id, x]));
  assert.deepStrictEqual(g.probes.rows.map(r => r.canStop), [true, true]);
  assert.deepStrictEqual(g.shells.rows.map(r => r.canStop), [false, true]);
  assert.deepStrictEqual(g.stuck.rows.map(r => r.canStop), [false]);
  assert.deepStrictEqual(g.mcp.rows.map(r => r.canStop), [false]);
  assert.deepStrictEqual([g.probes.stopCount, g.shells.stopCount, g.stuck.stopCount, g.mcp.stopCount], [2, 1, 0, 0]);
  const html = leftoverHtml(leftovers({ probes: [lrow(), lrow({ pid: 101 })], mcp: [unproven({ kind: 'mcp' })] }));
  assert.match(html, /data-res-act="left-stop-group" data-res-group="probes"[^>]*>Stop 2</);
  assert.strictEqual((html.match(/data-res-act="left-stop"/g) || []).length, 2);
  assert.ok(!/left-stop-group" data-res-group="mcp"/.test(html));
});

test('Leftovers (B): a row without a usable start gets no Stop button (nothing to prove it by)', () => {
  const v = leftoverView(leftovers({ probes: [lrow({ start: null }), lrow({ pid: 5, start: 'abc' })] }));
  assert.deepStrictEqual(v.groups[0].rows.map(r => r.canStop), [false, false]);
});

test('Leftovers (B): actionOf reads the two Stop clicks strictly', () => {
  assert.deepStrictEqual(D.actionOf({ resAct: 'left-stop', resPid: '100', resStart: '777' }), { act: 'left-stop', pid: 100, start: '777' });
  assert.deepStrictEqual(D.actionOf({ resAct: 'left-stop-group', resGroup: 'probes' }), { act: 'left-stop-group', group: 'probes' });
  assert.deepStrictEqual(D.actionOf({ resAct: 'left-stop-group', resGroup: 'shells' }), { act: 'left-stop-group', group: 'shells' });
  for (const bad of [
    { resAct: 'left-stop', resPid: '0', resStart: '1' }, { resAct: 'left-stop', resPid: '-3', resStart: '1' }, { resAct: 'left-stop', resPid: '4', resStart: 'x' },
    { resAct: 'left-stop', resPid: '4' }, { resAct: 'left-stop-group', resGroup: 'mcp' }, { resAct: 'left-stop-group', resGroup: 'stuck' }, { resAct: 'left-stop-group' },
  ]) assert.strictEqual(D.actionOf(bad), null, JSON.stringify(bad));
});

test('Leftovers (B): while a Stop is in flight every Leftovers button is disabled and the group button reads Stopping…; one Stop at a time', () => {
  const l = leftovers({ probes: [lrow()] });
  let state = stateWith(payload({ leftovers: l }));
  assert.ok(!/<button[^>]*disabled/.test(leftoverHtml(l)));
  state = D.beginLeftStop(state);
  assert.strictEqual(state.leftBusy, true);
  const html = D.html(D.view(state));
  assert.strictEqual((html.match(/<button[^>]*left-stop[^>]*disabled/g) || []).length, 2);
  assert.match(html, /Stopping…/);
  assert.strictEqual(D.beginLeftStop(state), state, 'a second press does nothing');
});

test('Leftovers (B): the answer re-enables the buttons; a failure is a plain sentence, and it lasts one sample', () => {
  const base = D.beginLeftStop(stateWith(payload({ leftovers: leftovers({ probes: [lrow()] }) })));
  assert.strictEqual(D.leftStopResult(base, { ok: true, stopped: 1, failed: 0 }).leftBusy, false);
  assert.strictEqual(D.leftStopResult(base, { ok: true, stopped: 1, failed: 0 }).leftNote, null);
  assert.strictEqual(D.leftStopResult(base, { ok: true, stopped: 0, failed: 2 }).leftNote, "Couldn't stop 2 of them; they are still listed.");
  assert.strictEqual(D.leftStopResult(base, { ok: false, text: 'stopping is not available' }).leftNote, "Couldn't stop: stopping is not available.");
  assert.strictEqual(D.leftStopResult(base, null).leftNote, "Couldn't stop: the request did not get through.");
  const failed = D.leftStopResult(base, { ok: false, text: 'x' });
  assert.match(D.html(D.view(failed)), /Couldn&#39;t stop: x\./);
  assert.strictEqual(D.withPayload(failed, payload()).leftNote, null);
});

test('Leftovers: the heading sums memory once per process: a nested row is not added again, and a missing figure makes it "at least"', () => {
  const nested = leftoverView(leftovers({ probes: [lrow({ bytes: 200 * MB }), lrow({ pid: 9, bytes: 50 * MB, nested: true })] }));
  assert.strictEqual(nested.sum.memFig, '200 MB');
  assert.strictEqual(nested.sum.count, 2);
  assert.strictEqual(leftoverView(leftovers({ probes: [lrow({ bytes: 20 * MB }), lrow({ pid: 9, bytes: null })] })).sum.memFig, '≥ 20 MB');
  assert.strictEqual(leftoverView(leftovers({ stuck: [unproven({ kind: 'stuck', bytes: null })] })).sum.memFig, '—');
});

test('Leftovers: rows from the machine are escaped in the HTML, the section sits above Machine, and the group buttons carry only a group name', () => {
  const html = leftoverHtml(leftovers({ mcp: [unproven({ kind: 'mcp', what: '<img src=x onerror=alert(1)>', session: '"><b>' })], probes: [lrow({ what: '<script>x</script>' })] }));
  assert.ok(!html.includes('<img') && !html.includes('<script>x') && !html.includes('"><b>'));
  assert.ok(html.indexOf('Leftovers') < html.indexOf('<h3>Machine'));
});

test('Leftovers (mock A wording): stuck closing says finish on their own on its title line and the tearing-down sentence once under its rows', () => {
  const html = leftoverHtml(leftovers({ stuck: [unproven({ kind: 'stuck', what: 'Electron' }), unproven({ kind: 'stuck', pid: 12, what: 'Electron' })] }));
  assert.ok(html.includes('finish on their own, slowly'));
  assert.strictEqual(html.split('Windows is still tearing these down. Nothing can stop them faster.').length - 1, 1);
  assert.ok(!html.includes("can't be stopped from here"));
  assert.ok(html.indexOf('finish on their own, slowly') < html.indexOf('Electron'), 'the note is on the title line');
  assert.ok(html.indexOf('Electron') < html.indexOf('Nothing can stop them faster'), 'the sentence is under the rows');
});

test('Leftovers (mock A wording): probe rows carry a dim "launcher gone" after the name, and keep their status line', () => {
  const html = leftoverHtml(leftovers({ probes: [lrow()], shells: [unproven({ kind: 'shell', what: 'bash.exe' })] }));
  assert.match(html, /probe-x <span class="res-lsub">launcher gone<\/span>/);
  assert.strictEqual(html.split('launcher gone').length - 1, 1, 'only on probe rows');
  assert.ok(html.includes('stops in 3 min'));
});

test('Leftovers (mock A wording): MCP servers say "N sessions × MB MB" when every row names a session and has a figure, otherwise nothing, and never "never called"', () => {
  const mcp = (session, bytes) => unproven({ kind: 'mcp', session, bytes });
  const side = l => leftoverView(leftovers({ mcp: l })).groups[0].side;
  assert.strictEqual(side([mcp('main', 120 * MB), mcp('feat', 100 * MB), mcp('feat', 80 * MB)]), '2 sessions × 150 MB');
  assert.strictEqual(side([mcp('main', 117 * MB)]), '1 session × 117 MB');
  assert.strictEqual(side([mcp('main', 117 * MB), mcp(undefined, 100 * MB)]), null);
  assert.strictEqual(side([mcp('main', null)]), null);
  const html = leftoverHtml(leftovers({ mcp: [mcp('main', 117 * MB)] }));
  assert.ok(html.includes('1 session × 117 MB') && !html.includes('never called'));
  assert.ok(!leftoverHtml(leftovers({ mcp: [mcp(undefined, 100 * MB)] })).includes('res-side'));
});

test('Leftovers (mock A wording): the titles are the mock\'s', () => {
  const v = leftoverView(leftovers({ probes: [lrow()], shells: [unproven({ kind: 'shell' })], mcp: [unproven({ kind: 'mcp' })], stuck: [unproven({ kind: 'stuck' })] }));
  assert.deepStrictEqual(v.groups.map(g => g.title), ['Stuck closing', 'Probe windows nobody is running', 'Agent shells still running', 'MCP servers']);
});

// ---- Leftovers: big task-output files (BACKLOG #74 F(3)) ------------------------------------------------------

const trow = (over = {}) => ({ key: '1:10', name: 'a1.output', project: 'p', sessions: ['e3ca0a04-d506-4379-8249-2062c4f76c5c'], bytes: 5.1 * 1024 * MB, ageMs: 40 * MINUTE, deletable: true, why: 'delete', ...over });

test('task logs: the group is "Task logs over 100 MB", with the clock rule on its title line, and each row reads session, file, size, age', () => {
  const v = leftoverView(leftovers({ taskLogs: [trow()] }));
  assert.deepStrictEqual([v.groups[0].title, v.groups[0].side], ['Task logs over 100 MB', 'deleted after 15 idle minutes once their session has ended']);
  assert.deepStrictEqual(v.groups[0].rows.map(r => [r.name, r.memFig, r.ageFig]), [['e3ca0a04 · a1.output', '5.1 GB', '40 min']]);
  assert.strictEqual(v.chip, '1 left over');
});

test('task logs: a row says what happens to it by its why', () => {
  const notes = why => leftoverView(leftovers({ taskLogs: [trow({ why, deletable: why === 'delete' })] })).groups[0].rows[0].note;
  assert.strictEqual(notes('delete'), 'deleting within a minute');
  assert.strictEqual(notes('alive'), 'kept: its session is still running');
  assert.strictEqual(notes('young'), 'kept: written to in the last 15 min');
  assert.strictEqual(notes('unknown'), "kept: can't tell whether its session ended");
});

test('task logs: a linked file names its first session and how many more', () => {
  const r = leftoverView(leftovers({ taskLogs: [trow({ sessions: ['aaaaaaaa-1', 'bbbbbbbb-2', 'cccccccc-3'] })] })).groups[0].rows[0];
  assert.strictEqual(r.name, 'aaaaaaaa · a1.output +2');
});

test('task logs: Delete only on a deletable row, with the key; no Stop N on the group; escaped', () => {
  const html = leftoverHtml(leftovers({ taskLogs: [trow(), trow({ key: '1:11', deletable: false, why: 'alive', name: '<b>x</b>.output' })] }));
  assert.strictEqual((html.match(/data-res-act="left-delete"/g) || []).length, 1);
  assert.match(html, /data-res-act="left-delete" data-res-key="1:10"/);
  assert.ok(!/left-stop-group" data-res-group="taskLogs"/.test(html));
  assert.ok(!html.includes('<b>x'));
});

test('task logs: an unknown file that is idle gets a manual Delete and says the choice is the persons choice; one that is not idle gets neither', () => {
  const v = leftoverView(leftovers({ taskLogs: [trow({ why: 'unknown', deletable: false, manualDelete: true }), trow({ key: '1:11', why: 'unknown', deletable: false, manualDelete: false })] }));
  assert.deepStrictEqual(v.groups[0].rows.map(r => r.canDelete), [true, false]);
  assert.deepStrictEqual(v.groups[0].rows.map(r => r.note), ["can't tell whether its session ended: Delete is yours to choose", "kept: can't tell whether its session ended"]);
});

test('task logs: actionOf reads the Delete click strictly', () => {
  assert.deepStrictEqual(D.actionOf({ resAct: 'left-delete', resKey: '1:10' }), { act: 'left-delete', key: '1:10' });
  for (const bad of [{ resAct: 'left-delete' }, { resAct: 'left-delete', resKey: '' }, { resAct: 'left-delete', resKey: '..\\x' }, { resAct: 'left-delete', resKey: '1:x' }]) {
    assert.strictEqual(D.actionOf(bad), null, JSON.stringify(bad));
  }
});

test('task logs: Delete buttons are disabled while a request is in flight', () => {
  const l = leftovers({ taskLogs: [trow()] });
  const html = D.html(D.view(D.beginLeftStop(stateWith(payload({ leftovers: l })))));
  assert.match(html, /<button[^>]*left-delete[^>]*disabled/);
});

test('task logs: deleted files read "Deleted <file>, <MB> MB freed" under Stopped; with no process rows the heading shows the disk total', () => {
  const v = leftoverView(leftovers({ taskLogs: [trow({ bytes: 300 * MB })], deleted: [{ name: 'b.output', bytes: 600 * MB, at: 1 }] }));
  assert.deepStrictEqual(v.stopped.map(s => s.text), ['Deleted b.output, 600 MB freed']);
  assert.strictEqual(v.sum.memFig, '300 MB on disk');
  const only = leftoverView(leftovers({ deleted: [{ name: 'b.output', bytes: 600 * MB, at: 1 }] }));
  assert.strictEqual(only.groups.length, 0);
  assert.strictEqual(only.chip, null);
  const mixed = leftoverView(leftovers({ probes: [lrow({ bytes: 200 * MB })], taskLogs: [trow()] }));
  assert.strictEqual(mixed.sum.memFig, '200 MB', 'RAM only: a file on disk is not memory');
});

test('task logs: the "N left over" chip counts only files that are left over, not ones whose session is alive or that were just written; the group is still listed', () => {
  const only = leftoverView(leftovers({ taskLogs: [trow({ why: 'alive', deletable: false }), trow({ key: '1:11', why: 'young', deletable: false })] }));
  assert.strictEqual(only.chip, null);
  assert.strictEqual(only.sum.count, 0);
  assert.strictEqual(only.groups[0].rows.length, 2);
  const mixed = leftoverView(leftovers({ taskLogs: [trow(), trow({ key: '1:11', why: 'alive', deletable: false }), trow({ key: '1:12', why: 'unknown', deletable: false })] }));
  assert.strictEqual(mixed.chip, '2 left over');
  assert.ok(!/left over/.test(D.html(D.view(stateWith(payload({ leftovers: leftovers({ taskLogs: [trow({ why: 'alive', deletable: false })] }) }))))), 'no chip is drawn');
});
