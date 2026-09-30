'use strict';
/**
 * app/worktree-status-display.js: what the window says about Extension X1/X4.
 *   - the blocked overlay: another session holds this worktree's lock;
 *   - the header badge: an overridden lock (a second session, on purpose) or
 *     no lock at all because it couldn't be written;
 *   - the terminal banner: other live `claude` sessions in this worktree;
 *   - the health marker: behind develop (a tab), or develop ahead of main (dev).
 * Pure models; the renderer paints them. Unknown is never drawn as a number.
 */
const test = require('node:test');
const assert = require('node:assert');

const ws = require('../app/worktree-status-display');

const NOW = 1790000000000;
const HOLDER = { pid: 21816, startedAt: NOW - 3 * 3600 * 1000, port: 54677, claudePid: 38288 };

test('sinceText: just now, minutes, hours, days -- and null when unknown', () => {
  assert.strictEqual(ws.sinceText(NOW - 20 * 1000, NOW), 'just now');
  assert.strictEqual(ws.sinceText(NOW - 5 * 60 * 1000, NOW), '5 min ago');
  assert.strictEqual(ws.sinceText(NOW - 3 * 3600 * 1000, NOW), '3 h ago');
  assert.strictEqual(ws.sinceText(NOW - 2 * 86400 * 1000, NOW), '2 d ago');
  for (const bad of [null, undefined, '1790', NaN, NOW + 60000]) assert.strictEqual(ws.sinceText(bad, NOW), null, String(bad));
});

test('a blocked window gets the overlay, naming the holder and offering Open anyway', () => {
  const o = ws.lockOverlay({ state: 'blocked', holder: HOLDER }, NOW);
  assert.strictEqual(o.title, 'Another session is running in this worktree');
  assert.match(o.detail, /host pid 21816/);
  assert.match(o.detail, /claude pid 38288/);
  assert.match(o.detail, /port 54677/);
  assert.match(o.detail, /since 3 h ago/);
  assert.match(o.detail, /second claude/i, 'it says what Open anyway does');
  assert.strictEqual(o.canOverride, true);
});

test('a holder that could not be read is said, not invented', () => {
  const o = ws.lockOverlay({ state: 'blocked', holder: { pid: null, startedAt: null, port: null, claudePid: null } }, NOW);
  assert.doesNotMatch(o.detail, /pid null|undefined|NaN/);
  assert.match(o.detail, /could not be read/);
  assert.strictEqual(o.canOverride, true);
  const partial = ws.lockOverlay({ state: 'blocked', holder: { pid: 7, startedAt: null, port: null, claudePid: null } }, NOW);
  assert.doesNotMatch(partial.detail, /since|port|claude pid/);
});

test('no overlay unless blocked', () => {
  for (const lock of [{ state: 'held' }, { state: 'pending' }, { state: 'override', holder: HOLDER },
    { state: 'unlocked', reason: 'not-a-repo' }, null, undefined]) {
    assert.strictEqual(ws.lockOverlay(lock, NOW), null, JSON.stringify(lock));
  }
});

test('the header badge shows an overridden lock and a lock that could not be taken', () => {
  const o = ws.lockBadge({ state: 'override', holder: HOLDER });
  assert.strictEqual(o.text, String.fromCodePoint(0x1f513));
  assert.match(o.title, /second session/i);
  assert.match(o.title, /not saved/i);
  const e = ws.lockBadge({ state: 'unlocked', reason: 'error', code: 'EACCES' });
  assert.match(e.title, /EACCES/);
  assert.match(e.title, /no session lock/i);
});

test('no badge for the ordinary states', () => {
  for (const lock of [{ state: 'held' }, { state: 'pending' }, { state: 'blocked', holder: HOLDER },
    { state: 'unlocked', reason: 'not-a-repo' }, null]) {
    assert.strictEqual(ws.lockBadge(lock), null, JSON.stringify(lock));
  }
});

test('the terminal banner counts other live sessions and names them', () => {
  const b = ws.terminalBanner({ format: 'ok', verified: true, sessions: [
    { pid: 456, sessionId: 'b', status: 'busy', startedAt: null },
    { pid: 123, sessionId: 'a', status: 'idle', startedAt: null },
  ] });
  assert.match(b.text, /^2 other claude sessions are live in this worktree/);
  assert.match(b.text, /pid 123 \(idle\)/);
  assert.match(b.text, /pid 456 \(busy\)/);
  assert.strictEqual(b.key, '123,456', 'the key is the set of pids, sorted, so dismissing lasts until it changes');
  const one = ws.terminalBanner({ format: 'ok', verified: true, sessions: [{ pid: 9, sessionId: null, status: null, startedAt: null }] });
  assert.match(one.text, /^1 other claude session is live in this worktree/);
  assert.doesNotMatch(one.text, /\(null\)/);
});

test('no banner when there is nothing verified to say', () => {
  for (const r of [null, undefined, { format: 'ok', verified: true, sessions: [] },
    { format: 'unknown', verified: false, sessions: [] },
    { format: 'ok', verified: false, sessions: [{ pid: 1 }] }]) {
    assert.strictEqual(ws.terminalBanner(r), null, JSON.stringify(r));
  }
});

test('the health marker: behind develop on a tab, ahead of main on dev', () => {
  assert.deepStrictEqual(ws.healthMarker({ kind: 'tab', behindDevelop: 3 }),
    { text: '↓3', title: '3 commits behind origin/develop', cls: 'wt-behind' });
  assert.deepStrictEqual(ws.healthMarker({ kind: 'tab', behindDevelop: 1 }),
    { text: '↓1', title: '1 commit behind origin/develop', cls: 'wt-behind' });
  assert.deepStrictEqual(ws.healthMarker({ kind: 'dev', developAheadOfMain: 499 }),
    { text: '+499', title: 'develop is 499 commits ahead of origin/main', cls: 'wt-ahead' });
});

test('nothing to act on draws nothing, and unknown is never drawn as a number', () => {
  for (const h of [{ kind: 'tab', behindDevelop: 0 }, { kind: 'dev', developAheadOfMain: 0 },
    { kind: 'tab', behindDevelop: null }, { kind: 'dev', developAheadOfMain: null },
    { kind: 'tab', behindDevelop: '3' }, { kind: 'tab', behindDevelop: 2.5 }, { kind: 'tab', behindDevelop: -1 },
    { kind: 'dev', behindDevelop: 3 }, { kind: 'weird', behindDevelop: 3 }, null, undefined]) {
    assert.strictEqual(ws.healthMarker(h), null, JSON.stringify(h));
  }
});
