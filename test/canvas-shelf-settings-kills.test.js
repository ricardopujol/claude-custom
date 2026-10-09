'use strict';
/**
 * Kill tests for Mortimer's release-gate survivors S21 (2026-10-09), host/canvas-shelf.js and host/canvas-settings.js:
 * the response-shape guards of the shelf's payload reader (`isStr`, `failed`, `textsOf`), `readShelf`'s shape guard,
 * the dedupe in `addToShelf`, and the settings object-shape guards in canvasMcpEnabled / readMcpSetting / writeMcpSetting.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const shelf = require('../host/canvas-shelf');
const settings = require('../host/canvas-settings');
const { tmpDir } = require('./tmp-dir');

const NOW = new Date('2026-10-09T12:00:00.000Z');
const URL1 = 'https://claude.ai/artifact/abc123';
const publish = (resp, over = {}) => ({ tool_name: 'Artifact', tool_input: {}, tool_response: resp, ...over });
const from = (p) => shelf.artifactFromPayload(p, NOW);

// ---- artifactFromPayload ---------------------------------------------------------------------------------------------

test('S21 shelf: a structured response with a plain https url is kept, with the time given', () => {
  assert.deepStrictEqual(from(publish({ url: URL1, title: 'T' })), { title: 'T', url: URL1, time: NOW.toISOString() });
});

test('S21 shelf: a failed result is never a publish, however its message quotes an address (each failure marker alone)', () => {
  const quoted = `Published at ${URL1}`;
  for (const [label, p] of [
    ['payload.is_error', publish({ url: URL1 }, { is_error: true })],
    ['payload.isError', publish({ url: URL1 }, { isError: true })],
    ['payload.error', publish({ url: URL1 }, { error: 'boom' })],
    ['payload.error = null still defined', publish({ url: URL1 }, { error: null })],
    ['response.is_error', publish({ url: URL1, is_error: true })],
    ['response.isError', publish({ url: URL1, isError: true })],
    ['response.error string', publish({ url: URL1, error: 'denied' })],
    ['response.error object', publish({ url: URL1, error: {} })],
    ['text form with is_error', publish(quoted, { is_error: true })],
  ]) assert.strictEqual(from(p), null, label);
  // The controls: a null / false response.error is NOT a failure.
  assert.ok(from(publish({ url: URL1, error: null })), 'response.error null');
  assert.ok(from(publish({ url: URL1, error: false })), 'response.error false');
  assert.ok(from(publish({ url: URL1, is_error: false })), 'response.is_error false');
});

test('S21 shelf: only an Artifact tool call from an object payload counts', () => {
  for (const p of [null, undefined, 'x', [], 5, publish({ url: URL1 }, { tool_name: 'Bash' }), publish({ url: URL1 }, { tool_name: undefined })]) {
    assert.strictEqual(from(p), null, JSON.stringify(p));
  }
});

test('S21 shelf: the text forms are read (a string, content blocks, result, text, message) and only the platform host counts', () => {
  const text = `Published a.html at ${URL1} (Version 1)`;
  for (const [label, resp] of [
    ['a string', text],
    ['content array of strings', { content: [text] }],
    ['content array of text blocks', { content: [{ type: 'text', text }] }],
    ['a bare array of blocks', [{ text }]],
    ['content as a string', { content: text }],
    ['result', { result: text }],
    ['text', { text }],
    ['message', { message: text }],
  ]) {
    const a = from(publish(resp));
    assert.ok(a, label);
    assert.strictEqual(a.url, URL1, label);
  }
  assert.strictEqual(from(publish('Published at https://evil.example/artifact/abc')), null, 'another host');
  assert.strictEqual(from(publish({ content: [{ type: 'text', text: 5 }, 7, null] })), null, 'non-string blocks are ignored');
  assert.strictEqual(from(publish({ result: 5, text: {}, message: [] })), null, 'non-string fields are ignored');
});

test('S21 shelf: the first text that holds a good address wins; a bad first match does not hide a later good one', () => {
  const a = from(publish({ content: ['no address here', `see https://claude.ai/artifact/first and ${URL1}`, 'https://claude.ai/artifact/later'] }));
  assert.strictEqual(a.url, 'https://claude.ai/artifact/first');
});

test('S21 shelf: an address with credentials, another scheme or no host is dropped; the structured url wins over the text', () => {
  for (const url of ['http://claude.ai/artifact/x', 'https://u:p@claude.ai/artifact/x', 'https://u@claude.ai/artifact/x', 'https://:p@claude.ai/artifact/x', 'ftp://x', 'not a url', 5, null]) {
    assert.strictEqual(from(publish({ url })), null, String(url));
  }
  const both = from(publish({ url: 'https://claude.ai/artifact/structured', text: `at ${URL1}` }));
  assert.strictEqual(both.url, 'https://claude.ai/artifact/structured');
  assert.strictEqual(from(publish({ url: ' https://claude.ai/artifact/padded ' })).url, 'https://claude.ai/artifact/padded');
});

test('S21 shelf: the title comes from the response, then the input title, description, file name, then "Artifact"; one line, 120 characters', () => {
  const base = { url: URL1 };
  assert.strictEqual(from(publish({ ...base, title: 'From response' }, { tool_input: { title: 'in' } })).title, 'From response');
  assert.strictEqual(from(publish(base, { tool_input: { title: 'Input title', description: 'd' } })).title, 'Input title');
  assert.strictEqual(from(publish(base, { tool_input: { description: 'Described' } })).title, 'Described');
  assert.strictEqual(from(publish(base, { tool_input: { file_path: 'C:\\x\\y\\report.html' } })).title, 'report.html');
  assert.strictEqual(from(publish(base, { tool_input: { file_path: '/x/y/page.html' } })).title, 'page.html');
  assert.strictEqual(from(publish(base)).title, 'Artifact');
  assert.strictEqual(from(publish(base, { tool_input: [1] })).title, 'Artifact', 'a non-object input is ignored');
  assert.strictEqual(from(publish(base, { tool_input: { file_path: 5, title: 5 } })).title, 'Artifact');
  assert.strictEqual(from(publish({ ...base, title: 'a\u0000b\n\tc   d' })).title, 'a b c d');
  assert.strictEqual(from(publish({ ...base, title: 'x'.repeat(300) })).title.length, 120);
  assert.strictEqual(from(publish({ ...base, title: '   ' }, { tool_input: { title: 'fallback' } })).title, 'fallback');
});

// ---- cleanShelfList / readShelf / addToShelf -------------------------------------------------------------------------

const item = (n, over = {}) => ({ title: `T${n}`, url: `https://claude.ai/artifact/a${n}`, time: `2026-10-09T00:00:${String(n % 60).padStart(2, '0')}Z`, ...over });

test('S21 shelf: cleanShelfList keeps only entries with a non-empty string title, a string time and a clean https url', () => {
  const good = item(1);
  const out = shelf.cleanShelfList([
    good, null, 5, 'x', [], { ...item(2), title: '' }, { ...item(3), title: 5 }, { ...item(4), time: 5 }, { ...item(5), time: undefined },
    { ...item(6), url: 'http://claude.ai/artifact/x' }, { ...item(7), url: 'https://u:p@claude.ai/artifact/x' },
  ]);
  assert.deepStrictEqual(out, [good]);
  assert.deepStrictEqual(shelf.cleanShelfList('x'), []);
  assert.deepStrictEqual(shelf.cleanShelfList(null), []);
  assert.deepStrictEqual(shelf.cleanShelfList({ length: 1, 0: good }), []);
});

test('S21 shelf: cleanShelfList normalises the address and the title, and caps at MAX_SHELF exactly', () => {
  const out = shelf.cleanShelfList([{ title: ' a\nb ', url: ' HTTPS://CLAUDE.AI/artifact/X ', time: 't' }, { title: '\n\n', url: URL1, time: 't' }]);
  assert.deepStrictEqual(out, [
    { title: 'a b', url: 'https://claude.ai/artifact/X', time: 't' },
    { title: 'Artifact', url: URL1, time: 't' },
  ]);
  const many = Array.from({ length: shelf.MAX_SHELF + 5 }, (_, i) => item(i));
  assert.strictEqual(shelf.cleanShelfList(many).length, shelf.MAX_SHELF);
  assert.strictEqual(shelf.cleanShelfList(many.slice(0, shelf.MAX_SHELF)).length, shelf.MAX_SHELF);
  assert.strictEqual(shelf.cleanShelfList(many.slice(0, shelf.MAX_SHELF - 1)).length, shelf.MAX_SHELF - 1);
});

const dirOf = () => tmpDir('cc-shelf-kills-');
const writeRaw = (dir, raw) => fs.writeFileSync(path.join(dir, 'shelf.json'), typeof raw === 'string' ? raw : JSON.stringify(raw));

test('S21 shelf: readShelf answers an empty shelf for a missing file, corrupt JSON, or any wrong shape; and drops bad entries', () => {
  const dir = dirOf();
  assert.deepStrictEqual(shelf.readShelf(dir), []);
  for (const raw of ['{not json', 'null', '5', '[]', '[1,2]', { items: 'x' }, { items: { 0: item(1) } }, { version: 1 }]) {
    writeRaw(dir, raw);
    assert.deepStrictEqual(shelf.readShelf(dir), [], JSON.stringify(raw));
  }
  // An array that carries an `items` property is still not a shelf object.
  writeRaw(dir, '[]');
  writeRaw(dir, { items: [item(1), { title: '' }, item(2)] });
  assert.deepStrictEqual(shelf.readShelf(dir).map(i => i.title), ['T1', 'T2']);
});

test('S21 shelf: addToShelf puts the entry on top, updates the same url in place (no duplicate), caps the shelf, and writes valid JSON', () => {
  const dir = dirOf();
  shelf.addToShelf(dir, item(1));
  shelf.addToShelf(dir, item(2));
  const third = shelf.addToShelf(dir, item(3));
  assert.deepStrictEqual(third.map(i => i.title), ['T3', 'T2', 'T1']);
  const again = shelf.addToShelf(dir, item(1, { title: 'T1 updated', time: 'later' }));
  assert.deepStrictEqual(again.map(i => i.title), ['T1 updated', 'T3', 'T2'], 'moved to the top, not duplicated');
  assert.strictEqual(again.length, 3);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'shelf.json'), 'utf8'));
  assert.strictEqual(onDisk.version, 1);
  assert.deepStrictEqual(onDisk.items.map(i => i.title), ['T1 updated', 'T3', 'T2']);
});

test('S21 shelf: addToShelf creates a missing folder, and keeps at most MAX_SHELF entries (the oldest fall off)', () => {
  const dir = path.join(dirOf(), 'deep', 'er');
  for (let i = 0; i < shelf.MAX_SHELF + 3; i++) shelf.addToShelf(dir, item(i));
  const list = shelf.readShelf(dir);
  assert.strictEqual(list.length, shelf.MAX_SHELF);
  assert.strictEqual(list[0].title, `T${shelf.MAX_SHELF + 2}`);
  assert.ok(!list.some(i => i.title === 'T0'));
});

test('S21 shelf: isShelfEvent wants a PostToolUse or PostToolUseFailure event for Artifact, with an object payload', () => {
  const ev = (event, payload) => ({ event, payload });
  assert.strictEqual(shelf.isShelfEvent(ev('PostToolUse', { tool_name: 'Artifact' })), true);
  assert.strictEqual(shelf.isShelfEvent(ev('PostToolUseFailure', { tool_name: 'Artifact' })), true);
  for (const bad of [ev('PreToolUse', { tool_name: 'Artifact' }), ev('PostToolUse', { tool_name: 'Bash' }), ev('PostToolUse', null), ev('PostToolUse', []), null, [], 'x']) {
    assert.strictEqual(shelf.isShelfEvent(bad), false, JSON.stringify(bad));
  }
});

// ---- canvas-settings ---------------------------------------------------------------------------------------------------

const settingsDir = (raw) => {
  const dir = tmpDir('cc-canvas-settings-kills-');
  if (raw !== undefined) fs.writeFileSync(path.join(dir, 'canvas-settings.json'), typeof raw === 'string' ? raw : JSON.stringify(raw));
  return dir;
};

test('S21 settings: only an object with mcp === false turns the injection off; arrays, null and other values leave it on', () => {
  assert.strictEqual(settings.canvasMcpEnabled({ env: {}, stateDir: settingsDir({ mcp: false }) }), false);
  for (const raw of [{ mcp: true }, { mcp: 0 }, { mcp: 'false' }, {}, null, [], Object.assign([], { mcp: false }), '5', 'not json {', undefined]) {
    const dir = settingsDir(raw === undefined ? undefined : (typeof raw === 'string' && raw.startsWith('not') ? raw : raw));
    assert.strictEqual(settings.canvasMcpEnabled({ env: {}, stateDir: dir }), true, JSON.stringify(raw));
  }
});

test('S21 settings: the environment words and the binary override', () => {
  for (const w of ['0', 'off', 'FALSE', ' No ']) assert.strictEqual(settings.canvasMcpEnabled({ env: { CLAUDE_CUSTOM_CANVAS_MCP: w } }), false, w);
  for (const w of ['1', 'on', 'true', 'yes', 'maybe', '']) assert.strictEqual(settings.canvasMcpEnabled({ env: { CLAUDE_CUSTOM_CANVAS_MCP: w } }), true, w);
  assert.strictEqual(settings.canvasMcpEnabled({ env: { CLAUDE_CUSTOM_BIN: 'C:\\fake.cmd' } }), false, 'an overridden binary is not assumed to take --mcp-config');
  assert.strictEqual(settings.canvasMcpEnabled({ env: { CLAUDE_CUSTOM_BIN: 'C:\\fake.cmd', CLAUDE_CUSTOM_CANVAS_MCP: 'yes' } }), true, 'unless it is asked for');
  assert.strictEqual(settings.canvasMcpEnabled({ env: { CLAUDE_CUSTOM_BIN: '' } }), true, 'an empty override is none');
  assert.strictEqual(settings.canvasMcpEnabled({ env: { CLAUDE_CUSTOM_BIN: 5 } }), true);
  assert.strictEqual(settings.canvasMcpEnabled({ env: {}, stateDir: '' }), true);
  assert.strictEqual(settings.canvasMcpEnabled({ env: null }), true);
  assert.strictEqual(settings.canvasMcpEnabled({ env: { CLAUDE_CUSTOM_CANVAS_MCP: 'off' }, stateDir: settingsDir({ mcp: true }) }), false, 'the environment wins in the off direction');
});

test('S21 settings: readMcpSetting is the file\'s own choice: false only for { mcp: false }; true for no file or a non-settings value; null when unreadable or no folder', () => {
  assert.strictEqual(settings.readMcpSetting(settingsDir({ mcp: false })), false);
  for (const raw of [{ mcp: true }, {}, null, [], Object.assign([], { mcp: false }), 'not json {', undefined]) {
    assert.strictEqual(settings.readMcpSetting(settingsDir(raw)), true, JSON.stringify(raw));
  }
  for (const bad of ['', undefined, null, 5, {}]) assert.strictEqual(settings.readMcpSetting(bad), null, String(bad));
  const dirAsFile = settingsDir();
  fs.mkdirSync(path.join(dirAsFile, 'canvas-settings.json'));
  assert.strictEqual(settings.readMcpSetting(dirAsFile), null, 'a read error that is not "missing" or "corrupt" is unknown');
});

test('S21 settings: writeMcpSetting writes only a boolean into a real folder, keeps other keys of an object file, and starts again over junk', () => {
  const dir = settingsDir({ other: 1, mcp: true });
  assert.strictEqual(settings.writeMcpSetting(dir, false), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'canvas-settings.json'), 'utf8')), { other: 1, mcp: false });
  assert.strictEqual(settings.writeMcpSetting(dir, true), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'canvas-settings.json'), 'utf8')).other, 1);

  for (const junk of [[1, 2], null, 'not json {', '5']) {
    const d = settingsDir(junk);
    assert.strictEqual(settings.writeMcpSetting(d, false), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, 'canvas-settings.json'), 'utf8')), { mcp: false }, JSON.stringify(junk));
  }

  const fresh = path.join(settingsDir(), 'not', 'yet');
  assert.strictEqual(settings.writeMcpSetting(fresh, true), true, 'creates the folder');
  assert.strictEqual(fs.existsSync(path.join(fresh, 'canvas-settings.json')), true);

  for (const [d, on] of [[dir, 'false'], [dir, 1], [dir, null], ['', true], [undefined, true], [5, true]]) {
    assert.strictEqual(settings.writeMcpSetting(d, on), null, `${String(d)} ${String(on)}`);
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'canvas-settings.json'), 'utf8')).mcp, true, 'a refused write changed nothing');
});
