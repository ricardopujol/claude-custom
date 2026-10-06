'use strict';
/* BACKLOG #23, measured: with CLAUDE_CONFIG_DIR set, the REAL `claude` writes its transcript under that dir, and
 * the harness's readers (defaultProjectsDir, listRecentProjects, readSessionModel) find it there.
 *
 *     node verify/probe-config-dir.js
 *
 * It runs one tiny `claude -p` turn, so it needs auth that does NOT live in the config dir: ANTHROPIC_API_KEY.
 * A fresh config dir is logged out, and copying ~/.claude/.credentials.json across is not an option (the CLI may
 * refresh the token in the copy and burn the original's refresh token). With no key it says SKIPPED, exit 2.
 *
 * Traps, both in CLAUDE.md: the child must not inherit ELECTRON_RUN_AS_NODE or any CLAUDE_CUSTOM_* var.
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('SKIPPED: no ANTHROPIC_API_KEY (a fresh CLAUDE_CONFIG_DIR is logged out, and credentials are not copied)');
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-config-dir-'));
const cfg = path.join(root, 'cfg');
const proj = path.join(root, 'proj');
fs.mkdirSync(cfg); fs.mkdirSync(proj);

const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CUSTOM_')) delete env[k];

let failed = false;
const check = (ok, what) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + what); if (!ok) failed = true; };

(async () => {
  const sessionId = crypto.randomUUID();
  const r = spawnSync('claude', ['-p', 'Reply with the single word ok.', '--model', 'haiku', '--session-id', sessionId],
    { cwd: proj, env, encoding: 'utf8', timeout: 120000, shell: process.platform === 'win32' });
  console.log(`claude exit ${r.status}; stdout: ${(r.stdout || '').trim().slice(0, 80)}`);
  if (r.status !== 0) console.log((r.stderr || '').slice(0, 300));

  // The readers, resolved the way the host resolves them: from this process's env.
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const { projectDirName } = require('../host/project-dir');
  const { claudeProjectsDir } = require('../host/claude-config-dir');
  const sessionModel = require('../host/session-model');
  const recent = require('../host/recent');

  const projectsDir = claudeProjectsDir();
  const dirName = projectDirName(proj);
  const file = path.join(cfg, 'projects', dirName, sessionId + '.jsonl');
  check(projectsDir === path.join(cfg, 'projects'), 'resolver points at <CLAUDE_CONFIG_DIR>/projects');
  check(fs.existsSync(file), `the CLI wrote the transcript under the config dir: ${file}`);
  check(!fs.existsSync(path.join(os.homedir(), '.claude', 'projects', dirName)),
    'and nothing for this project landed in ~/.claude/projects');
  check(sessionModel.defaultProjectsDir() === projectsDir, 'session-model reads the same dir');

  const model = await sessionModel.readSessionModel({ projectsDir: sessionModel.defaultProjectsDir(), projectDir: dirName, sessionId });
  check(!!(model.session && model.session.model), `readSessionModel finds the session's model: ${model.session && model.session.model}`);

  const rec = recent.listRecentProjects();
  const norm = p => String(p).replace(/\\/g, '/').toLowerCase();
  const rows = Array.isArray(rec) ? rec : (rec && rec.projects) || [];
  check(rows.some(p => p && norm(p.cwd || p.path) === norm(fs.realpathSync(proj)) || norm(p.cwd || p.path) === norm(proj)),
    'listRecentProjects (no arguments) lists the project');
})().catch(e => { console.log('FAIL  probe threw: ' + (e && e.stack || e)); failed = true; })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
    process.exit(failed ? 1 : 0);
  });
