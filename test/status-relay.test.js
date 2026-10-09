'use strict';
/**
 * The statusLine relay and how the settings file wires it.
 *
 * WHY statusLine: its stdin document carries model.id and effort.level and is
 * MEASURED to re-fire ~1s after /model and /effort with no turn
 * (verify/probe-top-bar-truth.js) -- the only truth FF12 can resolve a switch
 * against that is causally downstream of the switch.
 *
 * WHY a relay and not just a second statusLine: `--settings` replaces a
 * single-valued key WHOLESALE (verify/probe-settings.js), so the harness's
 * statusLine REPLACES the user's. The relay forwards the document to the host
 * and then runs the user's own command on the same stdin, passing its output
 * through -- the user's status line keeps rendering exactly as before.
 *
 * The tests that run the relay or a user command as a real process are in test/status-relay-process.test.js (not in Stryker's command).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { forward, sweepPids } = require('../host/status-relay');
const { buildHarnessSettings, findUserStatusLine } = require('../host/settings-writer');
const { createHookBridge } = require('../host/hook-bridge');
const { tmpDir } = require('./tmp-dir');

const opts = { helperPath: 'C:/h/hook-helper.exe', pipeName: '\\\\.\\pipe\\claude-custom-abc' };
const relayOpts = (userStatusLine) => ({
  ...opts,
  statusRelay: { nodePath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\cc\\host\\status-relay.js', userStatusLine },
});
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

// --- settings ---------------------------------------------------------------

test('with no status relay the settings are exactly { hooks }, as before', () => {
  assert.deepStrictEqual(Object.keys(buildHarnessSettings(opts)), ['hooks']);
});

test('with a status relay the settings add statusLine, and only that', () => {
  const s = buildHarnessSettings(relayOpts(null));
  assert.deepStrictEqual(Object.keys(s).sort(), ['hooks', 'statusLine']);
  assert.strictEqual(s.statusLine.type, 'command');
});

test("the relay command chains to the user's own statusLine command", () => {
  const user = { type: 'command', command: 'node "C:\\Users\\me\\statusline.js"', padding: 0 };
  const cmd = buildHarnessSettings(relayOpts(user)).statusLine.command;
  const then = /--then\s+(\S+)/.exec(cmd);
  assert.ok(then, `no --then in ${cmd}`);
  assert.strictEqual(Buffer.from(then[1], 'base64').toString('utf8'), user.command);
});

test("the user's other statusLine fields survive; only command is ours", () => {
  // A partial statusLine once wiped the user's command (settings-writer.js
  // header). The reverse holds too: dropping their padding changes their line.
  const user = { type: 'command', command: 'x', padding: 2, refreshInterval: 5 };
  const s = buildHarnessSettings(relayOpts(user)).statusLine;
  assert.strictEqual(s.padding, 2);
  assert.strictEqual(s.refreshInterval, 5);
  assert.notStrictEqual(s.command, 'x');
});

test('with no user statusLine the relay has no --then, and padding defaults to 0', () => {
  const s = buildHarnessSettings(relayOpts(null)).statusLine;
  assert.ok(!/--then/.test(s.command), s.command);
  assert.strictEqual(s.padding, 0);
});

test('the relay command carries no backslash, quote or $ for a shell to eat', () => {
  // The same trap as the hook pipe name (see settings-writer.test.js): a POSIX
  // shell on Windows eats backslashes inside double quotes.
  const user = { type: 'command', command: 'node "C:\\a b\\s.js" $HOME `x`', padding: 0 };
  const cmd = buildHarnessSettings(relayOpts(user)).statusLine.command;
  assert.ok(!cmd.includes('\\'), cmd);
  const unquoted = cmd.replace(/"[^"]*"/g, '');
  assert.ok(!/[$`'"]/.test(unquoted), unquoted);
});

test('a user statusLine that is already our relay is never chained to itself', () => {
  const self = buildHarnessSettings(relayOpts(null)).statusLine;
  const s = buildHarnessSettings(relayOpts(self)).statusLine;
  assert.ok(!/--then/.test(s.command), 'the relay would run itself forever');
});

// --- finding the user's statusLine ------------------------------------------

function layers(files) {
  const root = tmpDir('cc-sl-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'proj');
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return { configDir: path.join(home, '.claude'), cwd, root };
}
const SL = c => ({ statusLine: { type: 'command', command: c } });

test('project-local beats project beats user, as the CLI layers them', () => {
  let l = layers({ 'home/.claude/settings.json': SL('user'), 'proj/.claude/settings.json': SL('proj'),
    'proj/.claude/settings.local.json': SL('local') });
  assert.strictEqual(findUserStatusLine(l).command, 'local');
  l = layers({ 'home/.claude/settings.json': SL('user'), 'proj/.claude/settings.json': SL('proj') });
  assert.strictEqual(findUserStatusLine(l).command, 'proj');
  l = layers({ 'home/.claude/settings.json': SL('user') });
  assert.strictEqual(findUserStatusLine(l).command, 'user');
});

test('no statusLine anywhere is null', () => {
  assert.strictEqual(findUserStatusLine(layers({ 'home/.claude/settings.json': { model: 'opus' } })), null);
  assert.strictEqual(findUserStatusLine(layers({})), null);
});

test('an unreadable layer is skipped, not fatal', () => {
  const l = layers({ 'proj/.claude/settings.json': '{ not json', 'home/.claude/settings.json': SL('user') });
  assert.strictEqual(findUserStatusLine(l).command, 'user');
});

test('a statusLine that is not a command is null: there is nothing to chain', () => {
  for (const sl of [{ type: 'other', command: 'x' }, { type: 'command' }, { type: 'command', command: '' }, 'x', null]) {
    const l = layers({ 'home/.claude/settings.json': { statusLine: sl } });
    assert.strictEqual(findUserStatusLine(l), null, JSON.stringify(sl));
  }
});

let n = 0;
const pipeName = () => `cc-relay-test-${process.pid}-${n++}`;
const DOC = JSON.stringify({ model: { id: 'claude-sonnet-5' }, effort: { level: 'high' } });

test('no host listening: forward settles on the connect error, never on its deadline', { timeout: 60000 }, async (t) => {
  // With setTimeout mocked and never ticked, a forward that waited for its
  // FORWARD_TIMEOUT_MS deadline would never settle. This one must settle from
  // the connection failure alone, so a missing host costs no wait at all.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await forward(pipeName(), DOC);
});

test('sweepPids reads the last ALIVE line (pid:start pairs only), even from a sweep that was cut short', () => {
  assert.deepStrictEqual(sweepPids('ALIVE 10:1 11:2\r\nALIVE 10:1 11:2 12:3\r\n'), [{ pid: 10, start: '1' }, { pid: 11, start: '2' }, { pid: 12, start: '3' }]);
  // A line cut short mid-number ("ALIVE 10:1 1") would name some other process: only complete lines count.
  assert.deepStrictEqual(sweepPids('ALIVE 10:1 11:2\r\nALIVE 10:1 1'), [{ pid: 10, start: '1' }, { pid: 11, start: '2' }]);
  assert.deepStrictEqual(sweepPids('ALIVE 10:1 1'), []);
  assert.deepStrictEqual(sweepPids('ALIVE 5 & calc'), []);
  assert.deepStrictEqual(sweepPids(''), []);
  assert.deepStrictEqual(sweepPids(undefined), []);
  assert.deepStrictEqual(sweepPids('ALIVE '), []);
});

// (the two source-text assertions on host/status-relay.js moved to test/source-contracts.test.js: this file is in the mutation command)
test('#27: statusRelay.quietWhen adds a quoted --quiet-when with forward slashes', () => {
  const user = { type: 'command', command: 'node C:/u/sl.js' };
  const base = relayOpts(user);
  const s = buildHarnessSettings({ ...base,
    statusRelay: { ...base.statusRelay, quietWhen: 'C:\\cc\\.harness\\state\\chrome-global.json' } }).statusLine;
  assert.match(s.command, /--quiet-when "C:\/cc\/\.harness\/state\/chrome-global\.json"/);
  // It parses back to the same path through the relay's own reader.
  const { parseArgs } = require('../host/status-relay');
  const argv = s.command.match(/"[^"]*"|\S+/g).map(a => a.replace(/^"|"$/g, ''));
  assert.strictEqual(parseArgs(argv).quietWhen, 'C:/cc/.harness/state/chrome-global.json');
});

test('#27: no quietWhen -> no --quiet-when (the relay prints as before)', () => {
  const s = buildHarnessSettings(relayOpts({ type: 'command', command: 'node C:/u/sl.js' })).statusLine;
  assert.ok(!/--quiet-when/.test(s.command), s.command);
});

test('#27: parseArgs reads --quiet-when, and defaults it to null', () => {
  const { parseArgs } = require('../host/status-relay');
  assert.deepStrictEqual(parseArgs(['--pipe', 'p', '--then', 'x', '--quiet-when', 'C:/f.json']),
    { pipe: 'p', then: 'x', quietWhen: 'C:/f.json' });
  assert.deepStrictEqual(parseArgs(['--pipe', 'p']), { pipe: 'p', then: null, quietWhen: null });
});
