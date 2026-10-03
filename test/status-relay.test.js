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
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { buildHarnessSettings, findUserStatusLine } = require('../host/settings-writer');
const { createHookBridge } = require('../host/hook-bridge');
const { tmpDir } = require('./tmp-dir');

const RELAY = path.join(__dirname, '..', 'host', 'status-relay.js');
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

test('the relay command survives a real POSIX shell with its arguments intact', () => {
  const { spawnSync } = require('child_process');
  const user = { type: 'command', command: 'node "C:\\a b\\s.js"', padding: 0 };
  const cmd = buildHarnessSettings(relayOpts(user)).statusLine.command;
  // Replace the program with printf so the shell shows what it would pass.
  const argsOnly = cmd.replace(/^"[^"]*"/, 'printf "%s\\n"');
  const r = spawnSync('bash', ['-c', argsOnly], { encoding: 'utf8' });
  if (r.error) return;
  const argv = r.stdout.trim().split('\n');
  assert.strictEqual(argv[0], 'C:/cc/host/status-relay.js');
  assert.strictEqual(argv[argv.indexOf('--pipe') + 1], 'claude-custom-abc');
  assert.strictEqual(Buffer.from(argv[argv.indexOf('--then') + 1], 'base64').toString('utf8'), user.command);
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
  return { home, cwd, root };
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

// --- the relay, end to end ---------------------------------------------------

function runRelay(args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RELAY, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
    child.stdin.end(input);
  });
}
let n = 0;
const pipeName = () => `cc-relay-test-${process.pid}-${n++}`;
const DOC = JSON.stringify({ model: { id: 'claude-sonnet-5' }, effort: { level: 'high' } });

test('the relay forwards the document to the host as a Status event', async () => {
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: `\\\\.\\pipe\\${name}` });
  await bridge.listening;
  // A deadline, or a relay that never forwards hangs the suite instead of
  // failing it.
  const got = new Promise(r => {
    bridge.once('event', r);
    setTimeout(() => r(null), 3000).unref();
  });
  const res = await runRelay(['--pipe', name], DOC);
  const ev = await got;
  await bridge.close();
  assert.ok(ev, 'no Status event reached the host within 3s');
  assert.strictEqual(ev.event, 'Status');
  assert.strictEqual(ev.payload.model.id, 'claude-sonnet-5');
  assert.strictEqual(res.code, 0);
});

test("the user's command gets the same stdin, and its output is the status line", async () => {
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: `\\\\.\\pipe\\${name}` });
  await bridge.listening;
  const echo = `"${process.execPath}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('USER:'+JSON.parse(s).model.id))"`;
  const res = await runRelay(['--pipe', name, '--then', b64(echo)], DOC);
  await bridge.close();
  assert.strictEqual(res.out, 'USER:claude-sonnet-5');
});

test("no host listening: the user's status line still renders", async () => {
  // Process start-up (the relay, then cmd.exe, then the user's node) is what a
  // wall-clock bound here really measured, and it blew 5 s under full-suite
  // load. "Promptly" is asserted deterministically in the next test instead.
  const echo = `"${process.execPath}" -e "process.stdout.write('still here')"`;
  const res = await runRelay(['--pipe', pipeName(), '--then', b64(echo)], DOC);
  assert.strictEqual(res.out, 'still here');
  assert.strictEqual(res.code, 0);
});

test('no host listening: forward settles on the connect error, never on its deadline', { timeout: 60000 }, async (t) => {
  // With setTimeout mocked and never ticked, a forward that waited for its
  // FORWARD_TIMEOUT_MS deadline would never settle. This one must settle from
  // the connection failure alone, so a missing host costs no wait at all.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await forward(pipeName(), DOC);
});

test('unparseable stdin is not forwarded, and the user command still runs', async () => {
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: `\\\\.\\pipe\\${name}` });
  await bridge.listening;
  let events = 0;
  bridge.on('event', () => { events++; });
  const echo = `"${process.execPath}" -e "process.stdout.write('ok')"`;
  const res = await runRelay(['--pipe', name, '--then', b64(echo)], 'not json');
  await new Promise(r => setTimeout(r, 200));
  await bridge.close();
  assert.strictEqual(events, 0);
  assert.strictEqual(res.out, 'ok');
});

// --- a user command that never exits (Dexter r2 N6) ---------------------------

const { runUser, forward } = require('../host/status-relay');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a hung user statusLine is killed, grandchild and all, and the relay still exits", async () => {
  // shell:true puts a shell between the relay and the user's command. Killing
  // only the shell (child.kill) leaves the real command running, one more
  // orphan every time the status line re-fires.
  const dir = tmpDir('relay-hang');
  const pidFile = path.join(dir, 'pid').replace(/\\/g, '/');
  const hang = `"${process.execPath}" -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`;
  const t0 = Date.now();
  const code = await runUser(b64(hang), DOC, { timeoutMs: 1500 });
  assert.ok(Date.now() - t0 < 6000, 'the relay must not wait on a hung command');
  assert.notStrictEqual(code, 0, 'a killed command is not a success');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) { gone = !alive(pid); if (!gone) await new Promise(r => setTimeout(r, 150)); }
  if (!gone) try { process.kill(pid); } catch {}
  assert.ok(gone, `the user's command (pid ${pid}) is still running`);
});

test('a user command that finishes in time is not killed', async () => {
  const quick = `"${process.execPath}" -e "process.exit(0)"`;
  assert.strictEqual(await runUser(b64(quick), DOC, { timeoutMs: 5000 }), 0);
});

test('the whole relay SCRIPT exits promptly on a hung user command (Miguel #51 1)', async () => {
  const dir = tmpDir('relay-hang-script');
  const pidFile = path.join(dir, 'pid').replace(/\\/g, '/');
  const hang = `"${process.execPath}" -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`;
  const t0 = Date.now();
  const res = await runRelay(['--pipe', pipeName(), '--then', b64(hang)], DOC);
  assert.ok(Date.now() - t0 < 12000, `the relay took ${Date.now() - t0}ms`);
  assert.notStrictEqual(res.code, 0);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) { gone = !alive(pid); if (!gone) await new Promise(r => setTimeout(r, 150)); }
  if (!gone) try { process.kill(pid); } catch {}
  assert.ok(gone, `the user's command (pid ${pid}) outlived the relay`);
});

const RELAY_SRC = fs.readFileSync(RELAY, 'utf8');

test('the relay exits explicitly, so a kill that failed cannot keep it alive (Miguel #51 2)', () => {
  assert.match(RELAY_SRC, /process\.exit\(code\)/);
});

test('the user command stays in the relay\'s process group (Dexter #51 F7)', () => {
  // detached:true moved it into its own group on POSIX, so a CLI that kills
  // the relay's group no longer reached it: worse than before the timeout.
  assert.doesNotMatch(RELAY_SRC, /detached:/);
});

// --- #27: --quiet-when ------------------------------------------------------
// The person moved the status line into the tab header (PLAN_LAYOUT_L2.md):
// the relay still forwards every document, but prints nothing, so the CLI
// drops its status row (MEASURED, verify/probe-footer-rows.js).
const writeChrome = (dir, value) => {
  const file = path.join(dir, 'chrome-global.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};
const ECHO = `"${process.execPath}" -e "process.stdout.write('USER-ROW')"`;

test('#27: statusInHeader true -> the user command does not run and nothing is printed', async () => {
  const file = writeChrome(tmpDir('relay-quiet'), { statusInHeader: true });
  const res = await runRelay(['--pipe', pipeName(), '--then', b64(ECHO), '--quiet-when', file], DOC);
  assert.strictEqual(res.out, '');
  assert.strictEqual(res.code, 0);
});

test('#27: statusInHeader false, missing, or not exactly true -> the user row prints as before', async () => {
  const dir = tmpDir('relay-loud');
  for (const value of [{ statusInHeader: false }, {}, { statusInHeader: 'true' }, { statusInHeader: 1 }, null, [true]]) {
    const file = writeChrome(dir, value);
    const res = await runRelay(['--pipe', pipeName(), '--then', b64(ECHO), '--quiet-when', file], DOC);
    assert.strictEqual(res.out, 'USER-ROW', JSON.stringify(value));
  }
});

test('#27: a missing or corrupt toggle file -> the user row prints (fail toward showing)', async () => {
  const dir = tmpDir('relay-bad');
  const corrupt = path.join(dir, 'chrome-global.json');
  fs.writeFileSync(corrupt, '{not json');
  for (const file of [path.join(dir, 'nope.json'), corrupt]) {
    const res = await runRelay(['--pipe', pipeName(), '--then', b64(ECHO), '--quiet-when', file], DOC);
    assert.strictEqual(res.out, 'USER-ROW', file);
  }
});

test('#27: quiet still forwards the document to the host', async () => {
  const name = pipeName();
  const bridge = createHookBridge({ pipeName: `\\\\.\\pipe\\${name}` });
  await bridge.listening;
  const got = new Promise(r => { bridge.once('event', r); setTimeout(() => r(null), 3000).unref(); });
  const file = writeChrome(tmpDir('relay-quiet-fwd'), { statusInHeader: true });
  await runRelay(['--pipe', name, '--then', b64(ECHO), '--quiet-when', file], DOC);
  const ev = await got;
  await bridge.close();
  assert.ok(ev && ev.event === 'Status', 'the header needs the document even when the row is quiet');
});

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
