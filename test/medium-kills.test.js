'use strict';
/**
 * Kill tests for the Medium survivors of Mortimer's release gate (2026-10-09): S13 settings-writer, S14 claude-config-dir, S16 canvas-origin,
 * S18 task-logs classify, and the S19 pieces of status-relay that are reachable (forward, runUser's empty paths).
 * (S15, `defaultProjectsDir` emptied, is equivalent: `scanProjects(undefined)` falls back to roster-index's own default, the same dir.)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { buildClaudeArgs, findUserStatusLine } = require('../host/settings-writer');
const { claudeConfigDir, setConfigAnchor } = require('../host/claude-config-dir');
const { hostOrigin } = require('../host/canvas-origin');
const T = require('../host/task-logs');
const { forward, runUser } = require('../host/status-relay');

// ---- S13 ---------------------------------------------------------------------------------------------------------------------------

const FULL = { nodePath: 'C:\\n\\node.exe', scriptPath: 'C:\\cc\\host\\canvas-mcp.js', root: 'C:\\s\\canvas', pointerFile: 'C:\\s\\canvas\\_tab-1.json' };
const mcpArg = (c, helperExists = true) => { const a = buildClaudeArgs({ settingsFile: 'x.json', helperExists, canvasMcp: c }); const i = a.indexOf('--mcp-config'); return i === -1 ? null : a[i + 1]; };

test('S13: the MCP config is offered only when node, script, root and pointer are all non-empty strings', () => {
  const ok = JSON.parse(mcpArg(FULL));
  assert.strictEqual(ok.mcpServers.canvas.command, FULL.nodePath);
  assert.deepStrictEqual(ok.mcpServers.canvas.args, ['C:/cc/host/canvas-mcp.js']);
  assert.deepStrictEqual(ok.mcpServers.canvas.env, { CLAUDE_CUSTOM_CANVAS_ROOT: 'C:/s/canvas', CLAUDE_CUSTOM_CANVAS_POINTER: 'C:/s/canvas/_tab-1.json' });
  for (const key of Object.keys(FULL)) {
    for (const bad of [undefined, '', 5, null, {}]) {
      assert.strictEqual(mcpArg({ ...FULL, [key]: bad }), null, `${key} = ${JSON.stringify(bad)}`);
    }
  }
  for (const c of [null, undefined, 'x', 5, []]) assert.strictEqual(mcpArg(c), null, JSON.stringify(c));
  assert.strictEqual(mcpArg(FULL, false), null, 'no hook helper: the tools are not offered');
});

test('S13: findUserStatusLine skips a layer that is not an object with a statusLine, and works with no configDir', () => {
  const cwd = tmpDir('cc-medium-sl-');
  fs.mkdirSync(path.join(cwd, '.claude'));
  assert.strictEqual(findUserStatusLine({ cwd }), null, 'no settings anywhere, no configDir: null, no throw');
  assert.strictEqual(findUserStatusLine({}), null);
  assert.strictEqual(findUserStatusLine(), null);
  const sl = { type: 'command', command: 'echo hi' };
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ statusLine: sl }));
  for (const junk of ['null', '5', '{}', '"x"', '[]', '{nope']) {
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), junk);
    assert.deepStrictEqual(findUserStatusLine({ cwd }), sl, `a local layer of ${junk} is skipped`);
  }
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: null }));
  assert.strictEqual(findUserStatusLine({ cwd }), null, 'a layer that defines a non-runnable statusLine ends the search');
  const cfg = tmpDir('cc-medium-cfg-');
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ statusLine: sl }));
  assert.deepStrictEqual(findUserStatusLine({ configDir: cfg }), sl);
});

// ---- S14 ---------------------------------------------------------------------------------------------------------------------------

test('S14: setConfigAnchor takes a non-empty string only; anything else clears it, and a relative value then resolves against cwd', () => {
  const env = { CLAUDE_CONFIG_DIR: '.cc' };
  try {
    const anchor = path.resolve(tmpDir('cc-medium-anchor-'));
    setConfigAnchor(anchor);
    assert.strictEqual(claudeConfigDir({ env }), path.join(anchor, '.cc'));
    for (const bad of ['', 123, null, undefined, {}]) {
      setConfigAnchor(anchor);
      setConfigAnchor(bad);
      assert.strictEqual(claudeConfigDir({ env }), path.resolve(process.cwd(), '.cc'), `anchor cleared by ${JSON.stringify(bad)}`);
    }
  } finally { setConfigAnchor(null); }
});

// ---- S16 ---------------------------------------------------------------------------------------------------------------------------

test('S16: credentials in a URL, with either half, refuse it; a one-character host is a host', () => {
  assert.strictEqual(hostOrigin('https://user@example.com'), null);
  assert.strictEqual(hostOrigin('https://:pw@example.com'), null);
  assert.strictEqual(hostOrigin('https://user:pw@example.com'), null);
  assert.strictEqual(hostOrigin('a'), 'https://a');
  assert.strictEqual(hostOrigin('ab'), 'https://ab');
  assert.strictEqual(hostOrigin('a-b.c'), 'https://a-b.c');
  assert.strictEqual(hostOrigin('-a'), null);
  assert.strictEqual(hostOrigin('a-'), null);
});

// ---- S18 ---------------------------------------------------------------------------------------------------------------------------

const MB = 1024 * 1024;
const NOW = 1_800_000_000_000;
const IDLE = 15 * 60_000;
const file = (o = {}) => ({ path: `C:\\t\\claude\\proj\\${o.session || 's1'}\\tasks\\${o.name || 'a1.output'}`, project: 'proj', session: 's1', name: 'a1.output',
  bytes: 200 * MB, mtimeMs: NOW - 20 * 60_000, dev: '1', ino: '10', nlink: 1, ...o });
const reg = { ok: true, entries: [{ pid: 5, sessionId: 'other' }] };
const seenS1 = new Map([['s1', [{ pid: 424242, start: null }]]]);
const classify = (files, extra = {}) => T.classify({ files, registry: reg, listedPids: new Set([5]), seen: seenS1, now: NOW, ...extra });

test('S18: a size that is not a finite number is not a figure', () => {
  assert.deepStrictEqual(classify([file({ bytes: NaN }), file({ bytes: Infinity, ino: '11' }), file({ bytes: '300000000', ino: '12' })]), []);
  assert.strictEqual(classify([file({ bytes: T.MIN_BYTES })]).length, 1, 'exactly the floor is listed');
  assert.strictEqual(classify([file({ bytes: T.MIN_BYTES - 1 })]).length, 0);
});

test('S18: the monotonic idle clock gates the automatic delete at exactly idleMs, and a non-number never passes', () => {
  const row = (mono) => classify([file()], { monoAge: () => mono })[0];
  assert.deepStrictEqual([row(IDLE).deletable, row(IDLE).why], [true, 'delete']);
  assert.deepStrictEqual([row(IDLE - 1).deletable, row(IDLE - 1).why, row(IDLE - 1).manualDelete], [false, 'settling', true]);
  for (const bad of [NaN, undefined, null, '900000', Infinity * 0]) assert.strictEqual(row(bad).deletable, false, String(bad));
  assert.strictEqual(classify([file()])[0].deletable, true, 'no clock given: the wall clock stands');
});

test('S18: a file written right now is young, one dated in the future is unknown and reads age 0', () => {
  const now0 = classify([file({ mtimeMs: NOW })])[0];
  assert.deepStrictEqual([now0.why, now0.ageMs, now0.manualDelete], ['young', 0, false]);
  const future = classify([file({ mtimeMs: NOW + 1 })])[0];
  assert.deepStrictEqual([future.why, future.ageMs, future.manualDelete, future.deletable], ['unknown', 0, false, false]);
  const idleEdge = classify([file({ mtimeMs: NOW - IDLE })])[0];
  assert.strictEqual(idleEdge.manualDelete, true, 'exactly idleMs old is idle');
  assert.strictEqual(classify([file({ mtimeMs: NOW - IDLE + 1 })])[0].manualDelete, false);
  assert.strictEqual(classify([file({ mtimeMs: null })])[0].ageMs, null);
});

test('S18: aliveEntries ignores a registry or process table it cannot trust', () => {
  const entries = [{ sessionId: 's1', pid: 5 }, { sessionId: 7, pid: 5 }, null, { sessionId: 's2', pid: 6 }];
  assert.deepStrictEqual(T.aliveEntries({ ok: true, entries }, new Set([5])), [{ sessionId: 's1', pid: 5, start: null }]);
  assert.deepStrictEqual(T.aliveEntries({ ok: true, entries }, new Map([[5, '123'], [6, 'x']])), [{ sessionId: 's1', pid: 5, start: '123' }, { sessionId: 's2', pid: 6, start: null }]);
  for (const [r, l] of [[null, new Set([5])], [{ ok: false, entries }, new Set([5])], [{ ok: 'true', entries }, new Set([5])], [{ ok: true, entries: 'x' }, new Set([5])], [{ ok: true, entries }, [5]], [{ ok: true, entries }, null]]) {
    assert.deepStrictEqual(T.aliveEntries(r, l), [], JSON.stringify(r));
  }
});

test('S18: equal sizes sort by key, bigger first otherwise', () => {
  const rows = classify([file({ ino: '9', path: 'p9' }), file({ ino: '10', path: 'p10' }), file({ ino: '2', bytes: 300 * MB, path: 'p2' })]);
  assert.deepStrictEqual(rows.map(r => r.key), ['1:2', '1:10', '1:9']);
});

// ---- S19 ---------------------------------------------------------------------------------------------------------------------------

test('S19: forward sends a parseable document to the pipe and nothing for unparseable input or no pipe', async () => {
  const dir = tmpDir('cc-medium-pipe-');
  const name = `cc-kills-${process.pid}-${Date.now()}`;
  const listenOn = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(dir, name);
  const arg = process.platform === 'win32' ? name : listenOn;
  const got = [];
  const server = net.createServer((sock) => { let b = ''; sock.on('data', d => { b += d; }); sock.on('end', () => got.push(b)); sock.on('error', () => {}); });
  await new Promise(r => server.listen(listenOn, r));
  try {
    const t0 = Date.now();
    await forward(arg, 'not json');
    await forward(null, '{"a":1}');
    await forward('', '{"a":1}');
    assert.ok(Date.now() - t0 < 250, 'both resolved at once, not on the deadline');
    await forward(arg, '{"model":"m"}');
    await new Promise(r => setTimeout(r, 100));
    assert.deepStrictEqual(got, [JSON.stringify({ event: 'Status', payload: { model: 'm' } }) + '\n']);
  } finally { await new Promise(r => server.close(r)); }
});

test('S19: runUser with nothing to run answers 0 at once', async () => {
  for (const enc of ['', undefined, null]) assert.strictEqual(await runUser(enc, '{}'), 0, String(enc));
});
