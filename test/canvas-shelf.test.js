'use strict';
/**
 * host/canvas-shelf.js: the artifact shelf (BACKLOG #71, design call 8). The shelf is filled by claude-custom, not by Claude: the
 * host sees each `Artifact` publish through the CLI's own PostToolUse hook and appends `{ title, url, time }` to
 * <state>/canvas/<session-id>/shelf.json, so it survives restarts and Claude cannot forge an entry.
 *
 * THE PAYLOAD'S SHAPE. A real publish result, read from a session transcript (verify/probe-artifact-payload.js), is a structured
 * object `{ url, path, artifact_id, title, updated, icon, audience, seq, version, ... }` and the text the model sees ("Published
 * <path> at https://claude.ai/artifact/<id> (Version 1 ...)"). The hook's `tool_response` for other tools (ScheduleWakeup's
 * `scheduledFor`) is the structured form, so that is the first reading; the text and a content-array form are read too, because
 * the success payload of this tool could not be captured offline and the cost of a miss is an empty shelf, never a wrong one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');
const { isShelfEvent, artifactFromPayload, readShelf, addToShelf, MAX_SHELF } = require('../host/canvas-shelf');

const URL1 = 'https://claude.ai/artifact/KMEhoNQin1Sp7g9TvQgnmZ';
const NOW = new Date('2026-10-05T12:00:00.000Z');

test('only a PostToolUse or PostToolUseFailure of the Artifact tool is a shelf event', () => {
  assert.strictEqual(isShelfEvent({ event: 'PostToolUse', payload: { tool_name: 'Artifact' } }), true);
  assert.strictEqual(isShelfEvent({ event: 'PostToolUseFailure', payload: { tool_name: 'Artifact' } }), true);
  for (const ev of [{ event: 'PreToolUse', payload: { tool_name: 'Artifact' } }, { event: 'PostToolUse', payload: { tool_name: 'Bash' } },
    { event: 'PostToolUse', payload: {} }, { event: 'PostToolUse' }, null, undefined, 'x']) assert.strictEqual(isShelfEvent(ev), false, JSON.stringify(ev));
});

test('a structured result gives its url and title', () => {
  const item = artifactFromPayload({ tool_name: 'Artifact', tool_input: { file_path: 'C:\\x\\a.html', icon: 'layout', description: 'Three options' },
    tool_response: { url: URL1, title: 'Live Panel Options', artifact_id: 'x', seq: 1 } }, NOW);
  assert.deepStrictEqual(item, { title: 'Live Panel Options', url: URL1, time: '2026-10-05T12:00:00.000Z' });
});

test('the text form is read too: the url in "Published <path> at <url> (Version 1 ...)"', () => {
  const text = `Published C:\\x\\a.html at ${URL1} (Version 1, version id 17-9) Icon: "layout".\n\nLive subscription: arming`;
  for (const resp of [text, { content: [{ type: 'text', text }] }, [{ type: 'text', text }], { result: text }]) {
    const item = artifactFromPayload({ tool_name: 'Artifact', tool_input: { file_path: 'C:\\x\\a.html', description: 'Three options' }, tool_response: resp }, NOW);
    assert.strictEqual(item && item.url, URL1, JSON.stringify(resp).slice(0, 40));
  }
});

test('the title falls back: the input title, then the description, then the file name, then "Artifact"', () => {
  const t = (input, resp) => artifactFromPayload({ tool_name: 'Artifact', tool_input: input, tool_response: { url: URL1, ...resp } }, NOW).title;
  assert.strictEqual(t({}, { title: 'From result' }), 'From result');
  assert.strictEqual(t({ title: 'From input' }, {}), 'From input');
  assert.strictEqual(t({ description: 'A long description of the page' }, {}), 'A long description of the page');
  assert.strictEqual(t({ file_path: 'C:\\work\\plans\\roadmap.html' }, {}), 'roadmap.html');
  assert.strictEqual(t({ file_path: '/home/me/roadmap.html' }, {}), 'roadmap.html');
  assert.strictEqual(t({}, {}), 'Artifact');
});

test('a title is one line of plain text, capped', () => {
  const t = artifactFromPayload({ tool_name: 'Artifact', tool_input: {}, tool_response: { url: URL1, title: 'a\nb\u0000c\t' + 'x'.repeat(500) } }, NOW).title;
  assert.ok(!/[\u0000-\u001f]/.test(t));
  assert.ok(t.length <= 120);
});

test('no entry for a failure, no url, or a url that is not a plain https address', () => {
  const none = (resp, input = {}) => artifactFromPayload({ tool_name: 'Artifact', tool_input: input, tool_response: resp }, NOW);
  assert.strictEqual(none(undefined), null);
  assert.strictEqual(none('Error: not signed in'), null);
  assert.strictEqual(none({ error: 'nope' }), null);
  assert.strictEqual(none({ url: 'javascript:alert(1)' }), null);
  assert.strictEqual(none({ url: 'http://claude.ai/artifact/x' }), null, 'https only');
  assert.strictEqual(none({ url: 'https://user:pw@claude.ai/artifact/x' }), null);
  assert.strictEqual(none({ url: 'file:///c:/x' }), null);
  assert.strictEqual(none({ url: 5 }), null);
  assert.strictEqual(artifactFromPayload(null, NOW), null);
  assert.strictEqual(artifactFromPayload({ tool_name: 'Bash', tool_response: { url: URL1 } }, NOW), null);
});

test('property: an entry always has an https url and a one-line title, whatever the payload', () => {
  fc.assert(fc.property(fc.anything(), fc.anything(), (input, resp) => {
    const item = artifactFromPayload({ tool_name: 'Artifact', tool_input: input, tool_response: resp }, NOW);
    if (item === null) return;
    assert.match(item.url, /^https:\/\/[^\s/@]+\//);
    assert.ok(!/[\u0000-\u001f]/.test(item.title) && item.title.length >= 1 && item.title.length <= 120);
  }), { numRuns: 400 });
});

test('readShelf: missing, corrupt or the wrong shape is an empty shelf; bad entries are dropped', () => {
  const dir = tmpDir('cc-shelf-');
  assert.deepStrictEqual(readShelf(dir), []);
  fs.writeFileSync(path.join(dir, 'shelf.json'), '{nope');
  assert.deepStrictEqual(readShelf(dir), []);
  fs.writeFileSync(path.join(dir, 'shelf.json'), JSON.stringify({ version: 1, items: [{ title: 'ok', url: URL1, time: 't' }, { title: 5, url: URL1 }, { title: 'x', url: 'javascript:1', time: 't' }, null, 'x'] }));
  assert.deepStrictEqual(readShelf(dir), [{ title: 'ok', url: URL1, time: 't' }]);
});

test('addToShelf: newest first, persisted, and the same url is updated in place at the top, not duplicated', () => {
  const dir = tmpDir('cc-shelf-');
  addToShelf(dir, { title: 'A', url: 'https://claude.ai/artifact/aaa', time: 't1' });
  addToShelf(dir, { title: 'B', url: 'https://claude.ai/artifact/bbb', time: 't2' });
  assert.deepStrictEqual(readShelf(dir).map(i => i.title), ['B', 'A']);
  const after = addToShelf(dir, { title: 'A v2', url: 'https://claude.ai/artifact/aaa', time: 't3' });
  assert.deepStrictEqual(after.map(i => [i.title, i.time]), [['A v2', 't3'], ['B', 't2']]);
  assert.deepStrictEqual(readShelf(dir), after);
});

test('addToShelf: the shelf is capped, oldest dropped', () => {
  const dir = tmpDir('cc-shelf-');
  for (let i = 0; i < MAX_SHELF + 5; i++) addToShelf(dir, { title: `T${i}`, url: `https://claude.ai/artifact/id${i}`, time: `t${i}` });
  const shelf = readShelf(dir);
  assert.strictEqual(shelf.length, MAX_SHELF);
  assert.strictEqual(shelf[0].title, `T${MAX_SHELF + 4}`);
  assert.ok(!shelf.some(i => i.title === 'T0'));
});

test('addToShelf creates the folder and leaves no temp file behind', () => {
  const root = tmpDir('cc-shelf-');
  const dir = path.join(root, 'canvas', 'sid');
  addToShelf(dir, { title: 'A', url: URL1, time: 't' });
  assert.deepStrictEqual(fs.readdirSync(dir), ['shelf.json']);
});

// PR #125 Dexter #7 / Miguel M2: a failed publish, and an address that is not the platform's, never reach the shelf.
const ERR_TEXT = 'Version conflict for https://claude.ai/artifact/abc; re-read and retry';
test('a result flagged as an error never shelves, in any of its shapes, even when its message quotes an artifact address', () => {
  const base = { tool_name: 'Artifact', tool_input: { file_path: 'a.html' } };
  for (const tool_response of [
    { isError: true, content: [{ type: 'text', text: ERR_TEXT }] },
    { is_error: true, content: [{ type: 'text', text: ERR_TEXT }] },
    { is_error: true, url: URL1 },
    { error: 'boom', url: URL1 },
  ]) assert.strictEqual(artifactFromPayload({ ...base, tool_response }, NOW), null, JSON.stringify(tool_response));
  for (const extra of [{ is_error: true }, { isError: true }, { error: 'Version conflict' }]) {
    assert.strictEqual(artifactFromPayload({ ...base, ...extra, tool_response: ERR_TEXT }, NOW), null, JSON.stringify(extra));
  }
  assert.ok(artifactFromPayload({ ...base, tool_response: { isError: false, url: URL1 } }, NOW), 'an explicit false is not a failure');
});

test('the text fallback takes only the platform host: a quoted foreign address, or one after a hostile path, is not a publish', () => {
  const base = { tool_name: 'Artifact', tool_input: { file_path: 'a.html' } };
  for (const text of ['Published /tmp/https://evil.example/artifact/x.html at https://evil.example/artifact/x (Version 1)', 'see https://evil.example/artifact/zzz',
    'https://claude.ai.evil.example/artifact/zzz', 'http://claude.ai/artifact/zzz']) {
    assert.strictEqual(artifactFromPayload({ ...base, tool_response: text }, NOW), null, text);
  }
  const ok = artifactFromPayload({ ...base, tool_response: 'Published /tmp/https://evil.example/artifact/x.html at ' + URL1 + ' (Version 1)' }, NOW);
  assert.strictEqual(ok && ok.url, URL1, 'the claude.ai address after the hostile path is the one kept');
});

test('property: whatever the text, an entry from the text fallback is on claude.ai', () => {
  fc.assert(fc.property(fc.string(), fc.constantFrom('', 'https://evil.example/artifact/q ', ' ' + URL1, 'http://claude.ai/artifact/q'), (noise, extra) => {
    const item = artifactFromPayload({ tool_name: 'Artifact', tool_response: noise + extra + noise }, NOW);
    if (item) assert.strictEqual(new URL(item.url).hostname, 'claude.ai');
  }), { numRuns: 300 });
});

test('PR #125 Miguel M1: a shelf write that fails leaves no temp file in the session folder', () => {
  const dir = tmpDir('cc-shelf-fail-');
  fs.mkdirSync(path.join(dir, 'shelf.json'));          // the rename onto it is refused
  assert.throws(() => addToShelf(dir, { title: 't', url: URL1, time: NOW.toISOString() }));
  assert.deepStrictEqual(fs.readdirSync(dir), ['shelf.json']);
});
