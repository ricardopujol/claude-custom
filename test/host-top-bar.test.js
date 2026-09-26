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

test('a repeated, unchanged effort level does not broadcast again', () => {
  // Mirrors the existing mode/usage/quota pattern in this file: broadcast
  // only on a CHANGE, so an idle session stays silent on the wire.
  const idx = HOST.indexOf('.effort');
  assert.ok(idx !== -1, 'effort must be read for this check to mean anything');
  const region = HOST.slice(Math.max(0, idx - 400), idx + 400);
  assert.ok(/!==\s*lastEffort|lastEffort\s*!==/.test(region),
    'the effort broadcast must be gated on a change, not fired on every hook event');
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
