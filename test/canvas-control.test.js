'use strict';
/**
 * host/canvas-control.js: the host's side of Claude's panel (BACKLOG #71), the same shape as host/wand-control.js.
 *
 *   hello         carries `canvas: payload()`            { sessionId, status, bytes, signature, hosts, limitBytes }
 *   canvas-get    (no fields)    the window opened the panel and wants the page: answered by a `canvas` frame WITH `html`
 *   canvas-hosts  { action: 'allow'|'deny'|'remove', origin }   the person's answer about a host, kept for this panel
 *   canvas        the frame, BROADCAST: the payload, `html` only for a canvas-get, `changed: true` when the page on disk
 *                 changed (that is what docks the panel the first time Claude renders into it)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { createCanvasControl, CANVAS_TYPES } = require('../host/canvas-control');

const SID = '0f6c8a1e-3b8e-4a5b-9f0e-1d2c3b4a5f6e';

function rig({ sessionId = SID } = {}) {
  const stateDir = tmpDir('cc-canvas-control-');
  const frames = []; const watchers = [];
  const state = { sessionId };
  const control = createCanvasControl({
    stateDir, getSessionId: () => state.sessionId, emit: (f) => frames.push(f), log: () => {},
    watch: (opts) => { const w = { opts, closed: false, close() { this.closed = true; } }; watchers.push(w); return w; },
  });
  const dir = (id = SID) => path.join(stateDir, 'canvas', id);
  const write = (html, id = SID) => { fs.mkdirSync(dir(id), { recursive: true }); fs.writeFileSync(path.join(dir(id), 'index.html'), html); };
  return { control, frames, watchers, state, stateDir, dir, write };
}

test('the message types are exactly the two the window sends', () => {
  assert.deepStrictEqual([...CANVAS_TYPES].sort(), ['canvas-get', 'canvas-hosts']);
});

test('payload: no session yet is an empty panel, not an error', () => {
  const r = rig({ sessionId: null });
  assert.deepStrictEqual(r.control.payload(), { sessionId: null, status: 'empty', bytes: 0, signature: 'empty', hosts: { approved: [], denied: [] }, shelf: [], limitBytes: 1048576 });
});

test('payload: a session with a page reports its status, size and signature, never the page', () => {
  const r = rig();
  r.write('<p>x</p>');
  const p = r.control.payload();
  assert.strictEqual(p.sessionId, SID);
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.bytes, 8);
  assert.strictEqual(p.html, undefined);
});

test('payload: an invalid session id (it came from a hook payload) is no session at all', () => {
  const r = rig({ sessionId: '../../etc' });
  assert.strictEqual(r.control.payload().sessionId, null);
});

test('canvas-get answers with the page, broadcast, and changed false', () => {
  const r = rig();
  r.write('<b>hi</b>');
  assert.strictEqual(r.control.handles('canvas-get'), true);
  r.control.handle({ type: 'canvas-get' });
  assert.strictEqual(r.frames.length, 1);
  assert.strictEqual(r.frames[0].type, 'canvas');
  assert.strictEqual(r.frames[0].html, '<b>hi</b>');
  assert.strictEqual(r.frames[0].changed, false);
});

test('canvas-get for an empty or too-big page carries no html', () => {
  const r = rig();
  r.control.handle({ type: 'canvas-get' });
  assert.strictEqual(r.frames[0].status, 'empty');
  assert.strictEqual('html' in r.frames[0], false);
  r.write('x'.repeat(1048577));
  r.control.handle({ type: 'canvas-get' });
  assert.strictEqual(r.frames[1].status, 'toobig');
  assert.strictEqual(r.frames[1].bytes, 1048577);
  assert.strictEqual('html' in r.frames[1], false);
});

test('canvas-hosts: the answer is kept for this panel and broadcast', () => {
  const r = rig();
  r.control.handle({ type: 'canvas-hosts', action: 'allow', origin: 'https://api.example.com/x' });
  assert.deepStrictEqual(r.frames[0].hosts, { approved: ['https://api.example.com'], denied: [] });
  assert.strictEqual(r.frames[0].ok, true);
  r.control.handle({ type: 'canvas-hosts', action: 'deny', origin: 'https://bad.example.com' });
  r.control.handle({ type: 'canvas-hosts', action: 'remove', origin: 'https://api.example.com' });
  assert.deepStrictEqual(r.frames[2].hosts, { approved: [], denied: ['https://bad.example.com'] });
  assert.deepStrictEqual(r.control.payload().hosts, { approved: [], denied: ['https://bad.example.com'] });
});

test('canvas-hosts: a bad origin or action, or no session, is refused and says so', () => {
  const r = rig();
  r.control.handle({ type: 'canvas-hosts', action: 'allow', origin: '*' });
  r.control.handle({ type: 'canvas-hosts', action: 'wipe', origin: 'https://a.example.com' });
  assert.ok(r.frames.every(f => f.ok === false && typeof f.reason === 'string'));
  const none = rig({ sessionId: null });
  none.control.handle({ type: 'canvas-hosts', action: 'allow', origin: 'https://a.example.com' });
  assert.strictEqual(none.frames[0].ok, false);
  assert.match(none.frames[0].reason, /session/i);
});

test('sessionChanged arms a watch on the session folder, and replaces it when the session changes', () => {
  const r = rig({ sessionId: null });
  r.control.sessionChanged(null);
  assert.strictEqual(r.watchers.length, 0);
  r.state.sessionId = SID;
  r.control.sessionChanged(SID);
  assert.strictEqual(r.watchers.length, 1);
  assert.strictEqual(r.watchers[0].opts.dir, r.dir());
  assert.strictEqual(r.watchers[0].opts.create, true, 'the panel may be written long after the session starts');
  assert.strictEqual(r.watchers[0].opts.match('index.html'), true);
  assert.strictEqual(r.watchers[0].opts.match('shelf.json'), true);
  assert.strictEqual(r.watchers[0].opts.match('notes.txt'), false);
  r.control.sessionChanged(SID);
  assert.strictEqual(r.watchers.length, 1, 'the same session is not re-armed');
  const other = '11111111-2222-3333-4444-555555555555';
  r.state.sessionId = other;
  r.control.sessionChanged(other);
  assert.strictEqual(r.watchers[0].closed, true);
  assert.strictEqual(r.watchers.length, 2);
  assert.strictEqual(r.watchers[1].opts.dir, r.dir(other));
});

test('a new session announces itself (an empty panel), changed false', () => {
  const r = rig({ sessionId: null });
  r.state.sessionId = SID;
  r.control.sessionChanged(SID);
  assert.strictEqual(r.frames.at(-1).sessionId, SID);
  assert.strictEqual(r.frames.at(-1).changed, false);
});

test('a write to the page is announced once with changed true; a watch that fires for nothing says nothing', () => {
  const r = rig();
  r.control.sessionChanged(SID);
  const before = r.frames.length;
  r.watchers[0].opts.onChange();
  assert.strictEqual(r.frames.length, before, 'nothing changed on disk');
  r.write('<p>one</p>');
  r.watchers[0].opts.onChange();
  assert.strictEqual(r.frames.length, before + 1);
  assert.strictEqual(r.frames.at(-1).changed, true);
  assert.strictEqual(r.frames.at(-1).status, 'ok');
  r.watchers[0].opts.onChange();
  assert.strictEqual(r.frames.length, before + 1, 'the same page again is not a change');
  r.write('<p>two</p>');
  r.watchers[0].opts.onChange();
  assert.strictEqual(r.frames.length, before + 2);
});

test('a page that was already there when the session resumed is not a change: only the first write after is', () => {
  const r = rig();
  r.write('<p>from last time</p>');
  r.control.sessionChanged(SID);
  assert.strictEqual(r.frames.at(-1).changed, false);
  r.watchers[0].opts.onChange();
  assert.strictEqual(r.frames.at(-1).changed, false, 'still the same page');
});

test('a page that grows over the cap is announced as too big, and shrinking back is a change again', () => {
  const r = rig();
  r.control.sessionChanged(SID);
  r.write('x'.repeat(1048577));
  r.watchers[0].opts.onChange();
  assert.strictEqual(r.frames.at(-1).status, 'toobig');
  r.write('<p>ok</p>');
  r.watchers[0].opts.onChange();
  assert.strictEqual(r.frames.at(-1).status, 'ok');
  assert.strictEqual(r.frames.at(-1).changed, true);
});

test('close stops the watcher and removes the session folder only if it is empty', () => {
  const r = rig();
  r.control.sessionChanged(SID);
  fs.mkdirSync(r.dir(), { recursive: true });
  r.control.close();
  assert.strictEqual(r.watchers[0].closed, true);
  assert.strictEqual(fs.existsSync(r.dir()), false, 'an unused panel leaves no folder behind');
  const full = rig();
  full.control.sessionChanged(SID);
  full.write('<p>keep</p>');
  full.control.close();
  assert.strictEqual(fs.existsSync(path.join(full.dir(), 'index.html')), true, 'a page is never deleted');
});

test('an unknown type is not handled', () => {
  const r = rig();
  assert.strictEqual(r.control.handles('wand-add'), false);
  assert.strictEqual(r.control.handles(undefined), false);
});

const ARTIFACT_URL = 'https://claude.ai/artifact/KMEhoNQin1Sp7g9TvQgnmZ';
const artifactEvent = (over = {}) => ({ event: 'PostToolUse', payload: { tool_name: 'Artifact', tool_input: { file_path: 'a.html' },
  tool_response: { url: ARTIFACT_URL, title: 'Live Panel Options' }, ...over } });

test('shelfEvent: a published artifact goes on this session shelf and every window is told, with changed false', () => {
  const r = rig();
  assert.strictEqual(r.control.handlesShelfEvent(artifactEvent()), true);
  r.control.shelfEvent(artifactEvent());
  assert.strictEqual(r.frames.length, 1);
  assert.strictEqual(r.frames[0].type, 'canvas');
  assert.strictEqual(r.frames[0].changed, false, 'a shelf entry never docks the panel');
  assert.deepStrictEqual(r.frames[0].shelf.map(i => [i.title, i.url]), [['Live Panel Options', ARTIFACT_URL]]);
  assert.deepStrictEqual(r.control.payload().shelf.map(i => i.url), [ARTIFACT_URL], 'and it is on disk for the hello');
});

test('shelfEvent: a failure, an event with no address, or no session adds nothing and says nothing', () => {
  const r = rig();
  r.control.shelfEvent(artifactEvent({ tool_response: 'Error: not signed in' }));
  r.control.shelfEvent({ event: 'PostToolUseFailure', payload: { tool_name: 'Artifact', error: 'nope' } });
  assert.strictEqual(r.frames.length, 0);
  assert.deepStrictEqual(r.control.payload().shelf, []);
  const none = rig({ sessionId: null });
  none.control.shelfEvent(artifactEvent());
  assert.strictEqual(none.frames.length, 0);
});

test('handlesShelfEvent is only true for an Artifact post event', () => {
  const r = rig();
  assert.strictEqual(r.control.handlesShelfEvent({ event: 'PostToolUse', payload: { tool_name: 'Bash' } }), false);
  assert.strictEqual(r.control.handlesShelfEvent(null), false);
});
