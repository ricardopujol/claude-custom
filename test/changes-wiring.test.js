'use strict';
/**
 * The Changes panel's host wiring (BACKLOG #119 A3): a frame of an unlisted control type is TYPED into the pty as JSON (it has
 * happened twice in this repo), so `changes` must be listed, dispatched and answered on the asking socket; and the hook events
 * that can change a file must reach the notifier.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseControlFrame, CONTROL_TYPES, handleFrame } = require('../host/control');

const HOST_SRC = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

test('the changes frame is a known control type, never pty input', () => {
  assert.ok(CONTROL_TYPES.has('changes'));
  assert.deepStrictEqual(parseControlFrame(JSON.stringify({ type: 'changes', action: 'list', scope: 'auto', seq: 1 })), { type: 'changes', action: 'list', scope: 'auto', seq: 1 });
  const typed = [];
  const r = handleFrame(JSON.stringify({ type: 'changes', action: 'base', path: 'a.js' }), () => { throw new Error('boom'); }, (t) => typed.push(t));
  assert.strictEqual(r.handled, true);
  assert.deepStrictEqual(typed, [], 'a throwing handler never reaches the pty');
});

test('hello lists it, because the page sends nothing until the host says it accepts `changes`', () => {
  const at = HOST_SRC.indexOf("type: 'hello'");
  assert.match(HOST_SRC.slice(at, HOST_SRC.indexOf('});', at)), /controls:\s*\[\.\.\.CONTROL_TYPES\]/);
});

test('host.js dispatches changes to the service and answers on the same socket, before it could fall through', () => {
  const at = HOST_SRC.indexOf("msg.type === 'changes'");
  assert.ok(at !== -1, 'dispatchControl must handle changes');
  const branch = HOST_SRC.slice(at, HOST_SRC.indexOf('if (msg.type ===', at + 10));
  assert.match(branch, /changesService\.handle\(msg\)/);
  assert.match(branch, /ws\.send\(JSON\.stringify\(reply\)\)/);
  assert.match(branch, /return;/);
});

test('the service is built on this host\'s own worktree, and a changed notice goes to every window', () => {
  assert.match(HOST_SRC, /createChangesService\(\{\s*root: CWD\s*\}\)/);
  assert.match(HOST_SRC, /createChangesNotifier\(\{\s*announce: \(msg\) => broadcastControl\(msg\)\s*\}\)/);
});

test('every hook event reaches the notifier, next to the other consumers that see all events', () => {
  const at = HOST_SRC.indexOf('occupancy.handle(ev);');
  assert.ok(at !== -1);
  assert.match(HOST_SRC.slice(at, at + 400), /changesNotifier\.handle\(ev\);/);
});

test('the notifier is closed with the host', () => {
  assert.match(HOST_SRC, /changesNotifier\.close\(\)/);
});
