'use strict';
/**
 * FF12's host-side half: effort is session-scoped and arrives on every hook
 * payload as `effort.level` (hooks.md "common input fields") -- the truth
 * source a pending /effort switch resolves against. `permission_mode` arrives
 * the same way, and is read here only as a fallback for the very first
 * `hello` before the TUI has drawn a status line (the scrape stays
 * authoritative afterwards -- see host/mode.js).
 *
 * These are SOURCE assertions, in the style of test/host-listen.test.js:
 * host.js is module-level wiring that spawns a real pty and cannot be
 * required in a unit test. Coarse, and the only thing that fails when the
 * wiring regresses.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOST = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('the hook bridge reads effort.level and broadcasts it on change', () => {
  // The rules (subagents silent, absent effort is null) live in
  // host/hook-session.js and are tested there; this pins that host.js uses it.
  assert.ok(/readSessionHook\(ev\.payload\)/.test(HOST),
    'host.js must read the bridge event through host/hook-session.js');
  assert.ok(/type:\s*['"]effort['"]/.test(HOST),
    'host.js must broadcast a {type:"effort"} control message');
});

test('lastEffort is carried in the hello handshake', () => {
  const helloIdx = HOST.indexOf("type: 'hello'");
  assert.ok(helloIdx !== -1, 'the hello handshake must exist for this check to mean anything');
  const helloEnd = HOST.indexOf('});', helloIdx);
  const hello = HOST.slice(helloIdx, helloEnd);
  assert.ok(/effort:\s*lastEffort/.test(hello),
    'hello must carry effort so a client attaching after boot is not stuck reading "reading…"');
});

test('permission_mode read from the hook payload never replaces the TUI scrape', () => {
  // The scrape (parsePermissionMode / refreshPermissionMode) must still be
  // present and doing the ongoing work -- this PR only adds a fallback for
  // the handshake, per the brief's explicit "DON'T remove the scrape".
  assert.ok(/parsePermissionMode/.test(HOST), 'the TUI scrape must still be present');
  assert.ok(/refreshPermissionMode/.test(HOST), 'the TUI scrape must still run on its own timer');
});

test('every type host.js broadcasts by hand is a real WebSocket message, not a typo caught nowhere', () => {
  // The general shape check test/control.test.js applies to the CLIENT->HOST
  // vocabulary applies just as well to the new HOST->CLIENT one: `effort` is
  // a real type the renderer must have a branch for.
  const rendererPath = path.join(__dirname, '..', 'app', 'renderer.js');
  const renderer = fs.readFileSync(rendererPath, 'utf8');
  assert.ok(/msg\.type === ['"]effort['"]/.test(renderer),
    'app/renderer.js must handle the {type:"effort"} broadcast host.js now sends');
});

test('a Status event is handled first and RETURNS: it is not a hook', () => {
  // It arrives on every status redraw. Falling through would feed the mood
  // engine and the process panel a non-hook, and log a [hook] line each time.
  const handler = HOST.indexOf("hookBridge.on('event'");
  const status = HOST.indexOf("ev.event === 'Status'", handler);
  const firstOther = HOST.indexOf("ev.event === 'SessionStart'", handler);
  assert.ok(handler !== -1 && status !== -1, 'the bridge must handle Status');
  assert.ok(status < firstOther, 'Status must be handled before any hook branch');
  const branch = HOST.slice(status, firstOther);
  assert.ok(/readStatus\(ev\.payload\)/.test(branch), 'read through host/hook-session.js');
  assert.ok(/\breturn;/.test(branch), 'the Status branch must return');
});

test('effort and live model broadcast only on change, stamped with the host clock', () => {
  for (const [fn, type] of [['setEffort', 'effort'], ['setLiveModel', 'liveModel']]) {
    const start = HOST.indexOf(`function ${fn}(`);
    assert.ok(start !== -1, `${fn} must exist`);
    const body = HOST.slice(start, HOST.indexOf('\n}', start));
    assert.ok(/===\s*last\w+\)\s*return/.test(body), `${fn} must be gated on a change`);
    assert.ok(new RegExp(`type:\\s*'${type}'[^}]*at:\\s*Date\\.now\\(\\)`).test(body),
      `${fn} must broadcast {type:'${type}', ..., at}`);
  }
});

test('hello carries the live model, so a window attaching mid-session is not blank', () => {
  const helloIdx = HOST.indexOf("type: 'hello'");
  const hello = HOST.slice(helloIdx, HOST.indexOf('});', helloIdx));
  assert.ok(/liveModel:\s*lastLiveModel/.test(hello));
});

test("the settings file is written with the status relay, chained to the user's statusLine", () => {
  const i = HOST.indexOf('writeHarnessSettings(HARNESS_DIR');
  const call = HOST.slice(i, HOST.indexOf('}, PORT);', i));
  assert.ok(/statusRelay:/.test(call), 'no statusRelay passed');
  assert.ok(/status-relay\.js/.test(call), 'the relay script is not named');
  assert.ok(/findUserStatusLine\(/.test(call), "the user's statusLine is not looked up");
});
