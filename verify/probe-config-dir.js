'use strict';
/* BACKLOG #23, measured against the REAL `claude`: does the harness resolve CLAUDE_CONFIG_DIR the way the CLI does?
 *
 *     node verify/probe-config-dir.js
 *
 * TWO PARTS.
 *
 *   A. Unbilled, always runs. `claude auth status` (logged out, no model call) makes the CLI create its state under
 *      the config dir it chose, so WHERE it created it shows how it read the variable. Three odd values are
 *      measured: a relative one, one with a trailing space, and a blank one. Each is compared with what
 *      host/claude-config-dir.js says for the same value and the same cwd.
 *
 *   B. BILLED: one real `claude -p` turn (haiku, a few tokens, billed to ANTHROPIC_API_KEY). Runs only when that
 *      variable is set; otherwise it prints SKIPPED. It shows the transcript landing under the config dir and the
 *      harness readers (defaultProjectsDir, listRecentProjects, readSessionModel) finding it. A fresh config dir
 *      is logged out, and copying ~/.claude/.credentials.json across is NOT an option (the CLI may refresh the
 *      token in the copy and burn the original's refresh token), hence the key.
 *
 * Exit 0 when everything that ran passed (B skipped is not a failure, but the output says so), 1 on any FAIL.
 *
 * Traps (CLAUDE.md): the child must not inherit ELECTRON_RUN_AS_NODE, any CLAUDE_CUSTOM_* var, or the parent
 * session's identity (CLAUDECODE, CLAUDE_CODE_*); ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN are dropped too so
 * the key can't be redirected.
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { claudeConfigDir } = require('../host/claude-config-dir');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-config-dir-'));
let failed = false;
const check = (ok, what) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + what); if (!ok) failed = true; };

function childEnv(configDir, extra = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...extra };
  for (const k of Object.keys(env)) {
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k === 'ANTHROPIC_BASE_URL' || k === 'ANTHROPIC_AUTH_TOKEN'
      || k.startsWith('CLAUDE_CUSTOM_') || k.startsWith('CLAUDE_CODE_')) delete env[k];
  }
  return env;
}

// One command STRING with only space-free arguments: on win32 `claude` is a .cmd shim and needs the shell, and
// Node doesn't quote an args array under it, so anything with a space (the prompt) goes in on stdin instead.
function runClaude(args, { cwd, env, input }) {
  return spawnSync(['claude', ...args].join(' '), { cwd, env, input, encoding: 'utf8', timeout: 120000, shell: true });
}

function partA() {
  console.log('--- A. how the CLI reads odd CLAUDE_CONFIG_DIR values (unbilled: claude auth status) ---');
  const noKey = k => { const e = childEnv(k); delete e.ANTHROPIC_API_KEY; return e; };

  // relative: anchored against the CLI's own cwd
  let cwd = path.join(root, 'rel'); fs.mkdirSync(cwd);
  runClaude(['auth', 'status'], { cwd, env: noKey('rel-cfg') });
  const rel = claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: 'rel-cfg' }, cwd });
  check(fs.existsSync(path.join(cwd, 'rel-cfg')), 'relative: the CLI made the folder under ITS cwd');
  check(fs.existsSync(path.join(rel, '.claude.json')), `relative: the resolver (given that cwd) names the folder the CLI used: ${rel}`);

  // trailing space: kept by the CLI, so the resolver must not trim
  cwd = path.join(root, 'ts'); fs.mkdirSync(cwd);
  const spaced = path.join(root, 'ts-cfg') + ' ';
  runClaude(['auth', 'status'], { cwd, env: noKey(spaced) });
  check(fs.readdirSync(root).includes('ts-cfg '), 'trailing space: the CLI made a folder whose name ends in a space');
  check(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: spaced } }) === spaced, 'trailing space: the resolver returns it untrimmed');

  // blank: the CLI uses its default, so it creates nothing under cwd
  cwd = path.join(root, 'blank'); fs.mkdirSync(cwd);
  runClaude(['auth', 'status'], { cwd, env: noKey('') });
  check(fs.readdirSync(cwd).length === 0, 'blank: the CLI created nothing under its cwd (it used its default)');
  check(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '' }, home: 'H:\\h' }) === path.join('H:\\h', '.claude'), 'blank: the resolver says the default');
}

async function partB() {
  console.log('--- B. BILLED: one real `claude -p` turn, then the harness readers ---');
  if (!process.env.ANTHROPIC_API_KEY) { console.log('SKIPPED: no ANTHROPIC_API_KEY (a fresh config dir is logged out; credentials are not copied)'); return; }
  const cfg = path.join(root, 'cfg');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(cfg); fs.mkdirSync(proj);
  const sessionId = crypto.randomUUID();
  const r = runClaude(['-p', '--model', 'haiku', '--session-id', sessionId],
    { cwd: proj, env: childEnv(cfg), input: 'Reply with the single word ok.' });
  console.log(`claude exit ${r.status}; stdout: ${(r.stdout || '').trim().slice(0, 80)}`);
  if (r.status !== 0) console.log((r.stderr || '').slice(0, 300));

  process.env.CLAUDE_CONFIG_DIR = cfg;
  const { projectDirName } = require('../host/project-dir');
  const { claudeProjectsDir } = require('../host/claude-config-dir');
  const sessionModel = require('../host/session-model');
  const recent = require('../host/recent');

  const dirName = projectDirName(proj);
  const file = path.join(cfg, 'projects', dirName, sessionId + '.jsonl');
  check(claudeProjectsDir() === path.join(cfg, 'projects'), 'resolver points at <CLAUDE_CONFIG_DIR>/projects');
  check(fs.existsSync(file), `the CLI wrote the transcript under the config dir: ${file}`);
  check(!fs.existsSync(path.join(os.homedir(), '.claude', 'projects', dirName)), 'and nothing for this project landed in ~/.claude/projects');
  check(sessionModel.defaultProjectsDir() === claudeProjectsDir(), 'session-model reads the same dir');
  const model = await sessionModel.readSessionModel({ projectsDir: sessionModel.defaultProjectsDir(), projectDir: dirName, sessionId });
  check(!!(model.session && model.session.model), `readSessionModel finds the session's model: ${model.session && model.session.model}`);
  const rec = recent.listRecentProjects();
  const norm = p => String(p).replace(/\\/g, '/').toLowerCase();
  const rows = Array.isArray(rec) ? rec : (rec && rec.projects) || [];
  check(rows.some(p => p && [proj, fs.realpathSync(proj)].map(norm).includes(norm(p.cwd || p.path))), 'listRecentProjects (no arguments) lists the project');
}

(async () => {
  partA();
  await partB();
})().catch(e => { console.log('FAIL  probe threw: ' + ((e && e.stack) || e)); failed = true; })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS (for the parts that ran)');
    process.exit(failed ? 1 : 0);
  });
