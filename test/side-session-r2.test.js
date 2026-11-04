'use strict';
/**
 * PR #149 round 2 (Dexter R2-1, R2-3): the side session's tool set is an ALLOW-list ("every tool the CLI offers minus an
 * explicit read-only set"), so a tool the CLI adds tomorrow is off until someone reads it and classifies it.
 * The lifecycle half (R2-2, and R2-3 in the shell) is in test/tab-shell-side.test.js.
 *
 * The CLI mechanism was measured, with no billed call: `claude -p ... --output-format stream-json --verbose` prints its
 * `init` message (with the tool list) before any model request, and with ANTHROPIC_BASE_URL on a dead port nothing can be
 * sent. `--tools "<names>"` makes that list exactly the named built-in tools (naming PowerShell or Monitor turns them ON,
 * which an unrestricted -p session doesn't show: they are gated), and `--strict-mcp-config` with no `--mcp-config` loads none.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const side = require('../host/side-session');
const { buildClaudeArgs } = require('../host/settings-writer');

const argValue = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const sideArgs = (over = {}) => buildClaudeArgs({ settingsFile: 's.json', helperExists: true, side: true, ...over });

test('the side session is offered ONLY the read-only built-in tools, through the CLI\'s own --tools', () => {
  const args = sideArgs();
  assert.strictEqual(argValue(args, '--tools'), side.SIDE_ALLOWED_TOOLS.join(','));
  assert.strictEqual(args.filter(a => a === '--tools').length, 1);
  assert.deepStrictEqual([...side.SIDE_ALLOWED_TOOLS].sort(), ['Glob', 'Grep', 'Read', 'TodoWrite', 'WebFetch', 'WebSearch']);
});

test('no tool that runs a command or writes is allowed: PowerShell, Monitor, Bash and the rest are not in the allow-list', () => {
  for (const t of ['Bash', 'PowerShell', 'Monitor', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'EnterWorktree', 'ExitWorktree', 'Task', 'Agent', 'Workflow', 'Skill', 'ScheduleWakeup', 'CronCreate', 'RemoteTrigger']) {
    assert.ok(!side.SIDE_ALLOWED_TOOLS.includes(t), t);
  }
});

test('and the explicit deny stays as a second wall: PowerShell and Monitor are denied by name (never rely on the CLI\'s Bash => PowerShell fallback)', () => {
  const denied = (argValue(sideArgs(), '--disallowedTools') || '').split(',');
  for (const t of ['Bash', 'PowerShell', 'Monitor', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']) assert.ok(denied.includes(t), t);
  for (const t of side.SIDE_ALLOWED_TOOLS) assert.ok(!denied.includes(t), `${t} is both allowed and denied`);
});

test('no MCP server is loaded in a side session (--strict-mcp-config, with no --mcp-config)', () => {
  const args = sideArgs({ canvasMcp: { nodePath: 'node', scriptPath: 'C:/x/panel-server.js', root: 'C:/s', pointerFile: 'C:/s/p.json' } });
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--mcp-config'));
});

test('an ordinary session gets none of this', () => {
  const args = buildClaudeArgs({ settingsFile: 's.json', helperExists: true });
  for (const f of ['--tools', '--disallowedTools', '--strict-mcp-config', '--permission-mode']) assert.ok(!args.includes(f), f);
});

test('the three lists never overlap, and every name in them was reviewed', () => {
  const { SIDE_ALLOWED_TOOLS: allowed, SIDE_DENIED_TOOLS: denied, SIDE_REVIEWED_TOOLS: reviewed } = side;
  for (const t of allowed) assert.ok(!denied.includes(t), t);
  for (const t of [...allowed, ...denied]) assert.ok(reviewed.includes(t), `${t} is not in SIDE_REVIEWED_TOOLS`);
  assert.strictEqual(new Set(reviewed).size, reviewed.length, 'no duplicates');
});

// --- the CLI's own tool list: a new tool fails here until it is classified ----------------------------------------------------

const CLI_DTS = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'sdk-tools.d.ts');
// the input type's name is not always the tool's
const TOOL_NAME = { FileEdit: 'Edit', FileRead: 'Read', FileWrite: 'Write', Mcp: 'mcp' };

test('every tool the installed CLI declares is classified (reviewed) here: a new one fails this test until someone reads it', { skip: !fs.existsSync(CLI_DTS) && 'the CLI\'s sdk-tools.d.ts is not installed here' }, () => {
  const text = fs.readFileSync(CLI_DTS, 'utf8');
  const start = text.indexOf('export type ToolInputSchemas =');
  const end = text.indexOf('export type ToolOutputSchemas', start);
  assert.ok(start >= 0 && end > start, 'the union was found');
  const names = [...text.slice(start, end).matchAll(/\|\s*(\w+)Input\b/g)].map(m => TOOL_NAME[m[1]] || m[1]);
  assert.ok(names.length > 20, `found ${names.length} tools`);
  const unknown = names.filter(n => !side.SIDE_REVIEWED_TOOLS.includes(n));
  assert.deepStrictEqual(unknown, [], 'new CLI tools: decide read-only (add to SIDE_ALLOWED_TOOLS) or not (leave off), then list them in SIDE_REVIEWED_TOOLS');
});

// --- R2-3: "couldn't read" is not "nothing there" ---------------------------------------------------------------------------

test('sideHostsOf: an identity file that could not be read, or no list at all, is UNKNOWN (null), never "no side host"', () => {
  assert.strictEqual(side.sideHostsOf([{ port: 7702, parsed: null, unreadable: true }]), null);
  assert.strictEqual(side.sideHostsOf([{ port: 7701, parsed: { port: 7701, cwd: 'C:\\w', pid: 1, side: true } }, { port: 7702, parsed: null, unreadable: true }]), null);
  assert.strictEqual(side.sideHostsOf(null), null);
  assert.strictEqual(side.sideHostsOf(undefined), null);
  assert.deepStrictEqual(side.sideHostsOf([]), [], 'a listing that worked and found nothing is an answer');
  assert.deepStrictEqual(side.sideHostsOf([{ port: 7701, parsed: null }]), [], 'a half-written file (rename is atomic, so not a live host\'s) is not "unreadable"');
});

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

test('main.js: a listing that throws is unknown (null) for the side-host lookup, so the shell walks every tab', () => {
  const at = MAIN.indexOf('function ownIdentities()');
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.match(body, /catch \{ return null; \}/);
  assert.match(MAIN, /readerSessions: \(\) => readerSessionIds\(ownIdentities\(\) \|\| \[\]\)/);
});

test('laneHostsOf: the branch hosts only (not a side or shell session), and null when the identity files cannot be told', () => {
  const ids = [
    { port: 7701, parsed: { cwd: 'C:' + String.fromCharCode(92) + 'w' + String.fromCharCode(92) + 'a' } },
    { port: 7702, parsed: { cwd: 'C:x', side: true } },
    { port: 7703, parsed: { cwd: 'C:y', kind: 'shell' } },
    { port: 0, parsed: { cwd: 'C:z' } },
    { port: 7704, parsed: null },
  ];
  assert.deepStrictEqual(side.laneHostsOf(ids), [{ port: 7701, cwd: 'C:' + String.fromCharCode(92) + 'w' + String.fromCharCode(92) + 'a' }]);
  assert.strictEqual(side.laneHostsOf([{ port: 7701, parsed: null, unreadable: true }]), null);
  assert.strictEqual(side.laneHostsOf(null), null);
});
