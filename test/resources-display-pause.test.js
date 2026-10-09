'use strict';
/**
 * app/resources-display.js (BACKLOG #19): a child row's Pause / Resume. A paused row says "paused" with the time it was paused and
 * offers Resume; a row that can be paused offers Pause; the CLI-limit note rides on the Pause button. No confirm (a pause is
 * undone by Resume), one request in flight at a time, and a refusal is said in words on the row.
 */
const test = require('node:test');
const assert = require('node:assert');
const D = require('../app/resources-display');

const MB = 1024 ** 2;
const child = (over = {}) => ({ pid: 18432, name: 'node.exe', cmd: 'server.js', full: 'node server.js', cpu: 30, bytes: 400 * MB, start: '777', canStop: true, canPause: true, paused: null, ...over });
const model = (children) => ({
  measuring: false,
  machine: { cpu: 10, mem: { usedBytes: 1, totalBytes: 2 }, ours: { cpu: 1, bytes: 1 } },
  project: { cpu: 1, bytes: 1, rows: [{ key: 'k', label: 'main', hostPid: 20, cpu: 1, bytes: 1, claude: null, children, more: { count: 0, underOnePct: true } }], self: { cpu: 0, bytes: 1, parts: [] } },
  windows: [], background: null,
});
const payload = (children, extra = {}) => ({ model: model(children), status: { stale: false, expired: false, ageMs: 0 }, machine: null, ...extra });
const open = (p) => ({ ...D.withPayload(D.emptyState(), p), expanded: ['s:k'] });
const clock = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const SINCE = Date.UTC(2026, 9, 9, 12, 34, 0);

test('actionOf: pause and resume carry a positive pid and a digits start; anything else is null', () => {
  assert.deepStrictEqual(D.actionOf({ resAct: 'pause', resPid: '12', resStart: '777', resName: 'node.exe' }), { act: 'pause', pid: 12, start: '777', name: 'node.exe' });
  assert.deepStrictEqual(D.actionOf({ resAct: 'resume', resPid: '12', resStart: '777', resName: 'node.exe' }), { act: 'resume', pid: 12, start: '777', name: 'node.exe' });
  for (const bad of [
    { resAct: 'pause', resPid: '0', resStart: '777', resName: 'x' }, { resAct: 'pause', resPid: '-1', resStart: '777', resName: 'x' },
    { resAct: 'pause', resPid: '12', resStart: 'abc', resName: 'x' }, { resAct: 'pause', resPid: '12', resStart: '777' },
    { resAct: 'resume', resPid: 'x', resStart: '777', resName: 'x' }, { resAct: 'resume', resPid: '12', resStart: '', resName: 'x' },
  ]) assert.strictEqual(D.actionOf(bad), null, JSON.stringify(bad));
});

test('a running row offers Pause (with the pid in its label); a row that cannot be paused offers none', () => {
  const html = D.html(D.view(open(payload([child()]))));
  assert.match(html, /data-res-act="pause" data-res-pid="18432" data-res-start="777" data-res-name="node\.exe"/);
  assert.match(html, /aria-label="Pause node\.exe, PID 18432"/);
  assert.doesNotMatch(html, /data-res-act="resume"/);
  const none = D.html(D.view(open(payload([child({ canPause: false })]))));
  assert.doesNotMatch(none, /data-res-act="pause"/);
});

test('a paused row says paused with the time, offers Resume and Stop, and no Pause', () => {
  const html = D.html(D.view(open(payload([child({ paused: { since: SINCE }, canPause: false })]))));
  assert.ok(html.includes(`paused ${clock(SINCE)}`), 'the time it was paused');
  assert.match(html, /data-res-act="resume" data-res-pid="18432" data-res-start="777" data-res-name="node\.exe"/);
  assert.match(html, /aria-label="Resume node\.exe, PID 18432"/);
  assert.match(html, /data-res-act="ask-stop"/);
  assert.doesNotMatch(html, /data-res-act="pause"/);
  assert.match(html, /class="res-child res-paused-row"/, 'the row is drawn as paused');
});

test('a paused row whose time is not a number still says paused, without inventing a time', () => {
  const html = D.html(D.view(open(payload([child({ paused: { since: null }, canPause: false })]))));
  assert.match(html, />paused</);
  assert.doesNotMatch(html, /paused \d/);
});

test('the CLI-limit note from the payload rides on the Pause button, and is escaped', () => {
  const html = D.html(D.view(open(payload([child()], { pauseNote: 'the CLI stops it after 9 <min>' }))));
  assert.match(html, /title="Pause node\.exe, PID 18432\. the CLI stops it after 9 &lt;min&gt;"/);
  const plain = D.html(D.view(open(payload([child()]))));
  assert.match(plain, /title="Pause node\.exe, PID 18432"/);
});

test('beginPause marks the request in flight: every Pause / Resume button reads disabled, a second begin does nothing', () => {
  let s = open(payload([child(), child({ pid: 9, start: '5', name: 'b.exe' })]));
  s = D.beginPause(s, { pid: 18432, start: '777', name: 'node.exe' });
  assert.deepStrictEqual(s.pauseBusy, { pid: 18432, start: '777', name: 'node.exe' });
  const again = D.beginPause(s, { pid: 9, start: '5', name: 'b.exe' });
  assert.strictEqual(again, s);
  const html = D.html(D.view(s));
  assert.strictEqual((html.match(/data-res-act="pause"[^>]* disabled/g) || []).length, 2, 'both Pause buttons are disabled while one is in flight');
});

test('pauseResult: success clears the busy mark and shows nothing (the next sample shows "paused"); a refusal is said on the row', () => {
  const req = { pid: 18432, start: '777', name: 'node.exe' };
  let s = D.beginPause(open(payload([child()])), req);
  s = D.pauseResult(s, req, { ok: true, pid: 18432, since: SINCE }, 'pause');
  assert.strictEqual(s.pauseBusy, null);
  assert.strictEqual(s.outcome, null);

  s = D.beginPause(open(payload([child()])), req);
  s = D.pauseResult(s, req, { ok: false, reason: 'protected', text: 'closing the tab ends a session' }, 'pause');
  assert.strictEqual(s.pauseBusy, null);
  assert.deepStrictEqual(s.outcome, { pid: 18432, start: '777', name: 'node.exe', kind: 'refused', text: "Couldn't pause PID 18432: closing the tab ends a session." });
  assert.match(D.html(D.view(s)), /Couldn&#39;t pause PID 18432|Couldn't pause PID 18432/);

  s = D.beginPause(open(payload([child({ paused: { since: SINCE }, canPause: false })])), req);
  s = D.pauseResult(s, req, null, 'resume');
  assert.strictEqual(s.outcome.text, "Couldn't resume PID 18432: the request did not get through.");
});

test('a refusal on a row lasts until the next sample shows the process gone, like Stop\'s', () => {
  const req = { pid: 18432, start: '777', name: 'node.exe' };
  let s = D.pauseResult(D.beginPause(open(payload([child()])), req), req, { ok: false, text: 'x' }, 'pause');
  assert.notStrictEqual(s.outcome, null);
  s = D.withPayload(s, payload([]));
  assert.strictEqual(s.outcome, null);
});

test('"gone" on a pause or resume reads Already exited, as Stop\'s does', () => {
  const req = { pid: 18432, start: '777', name: 'node.exe' };
  const s = D.pauseResult(D.beginPause(open(payload([child()])), req), req, { ok: false, reason: 'gone', text: 'Already exited' }, 'pause');
  assert.strictEqual(s.outcome.kind, 'gone');
  assert.strictEqual(s.outcome.text, 'Already exited');
});

test('a new payload drops a busy mark for a process that left (the answer would never match)', () => {
  const req = { pid: 18432, start: '777', name: 'node.exe' };
  let s = D.beginPause(open(payload([child()])), req);
  s = D.withPayload(s, payload([]));
  assert.strictEqual(s.pauseBusy, null);
});

test('the paused text is the LAST child of its row (the figures and buttons keep their columns: the CSS positions them by child number)', () => {
  const html = D.html(D.view(open(payload([child({ paused: { since: SINCE }, canPause: false })]))));
  const row = /<div class="res-child res-paused-row"[^>]*>([\s\S]*?)<\/div>/.exec(html)[1];
  assert.match(row, /^<span class="res-cname">[^<]*<\/span><span class="res-fig">[^<]*<\/span><span class="res-fig">[^<]*<\/span><button[\s\S]*<\/button><button[\s\S]*<\/button><span class="res-paused">paused \d\d:\d\d<\/span>$/);
});
