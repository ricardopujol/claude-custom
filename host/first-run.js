'use strict';
/**
 * First-run checks: is this machine ready to run claude-custom?
 *
 * Four checks, each answering one question a new user can't otherwise see:
 *
 *   claude   the `claude` CLI answers `--version`, at or above the version this was built against
 *   helper   .harness/hook-helper.exe exists and starts (without it hooks are off and agents never go Active)
 *   signin   the CLI has credentials (the file's existence or an API key's presence; its contents are never read)
 *   ollama   a local Ollama answers (optional: only the local-model features want it)
 *
 * Every check is pure over what it's handed (a runner, an exists(), a probe), so the tests never spawn anything.
 * ABSENCE IS NEVER OK: a missing runner, a throw, an unreadable answer and an empty value all come out as `fail`
 * for a required check and `info` for the optional one. Nothing here ever shows as ok without having seen it work.
 *
 * Result shape: { id, label, required, status: 'ok' | 'fail' | 'info', detail, fix }.
 * `summarize` turns the list into what the window shows: every row for Diagnostics, and at most ONE banner line (the
 * first failing required check's fix). Never a modal.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// The CLI this was built and probed against is 2.1.x (verify/ probes print the version they ran on). Older ones are untested,
// not known broken, so the line says "untested".
const MIN_CLAUDE_VERSION = '2.1.0';

const isStr = (s) => typeof s === 'string';
const nonEmpty = (s) => isStr(s) && s.trim() !== '';

function parseVersion(text) {
  if (!isStr(text)) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

const result = (id, label, required, status, detail, fix = null) => ({ id, label, required, status, detail, fix });

async function checkClaude({ run } = {}) {
  const label = 'Claude Code CLI';
  const install = 'Claude Code isn\'t installed: run `npm install -g @anthropic-ai/claude-code`';
  if (typeof run !== 'function') return result('claude', label, true, 'fail', 'not checked: no way to run it', install);
  let r;
  try { r = await run(); } catch (err) { r = { ok: false, error: err && err.message }; }
  if (!r || r.ok !== true) {
    return result('claude', label, true, 'fail', `\`claude --version\` failed${r && r.error ? ` (${r.error})` : ''}`, install);
  }
  const v = parseVersion(r.stdout);
  if (!v) return result('claude', label, true, 'fail', 'its version output wasn\'t readable', install);
  const shown = v.join('.');
  if (compareVersions(v, parseVersion(MIN_CLAUDE_VERSION)) < 0) {
    return result('claude', label, true, 'fail', `${shown}, older than ${MIN_CLAUDE_VERSION} (untested)`,
      `Claude Code ${shown} is older than ${MIN_CLAUDE_VERSION} (untested): run \`claude update\``);
  }
  return result('claude', label, true, 'ok', shown);
}

async function checkHelper({ helperPath, exists, run } = {}) {
  const label = 'Hook helper';
  const fix = 'Hooks are off: run `npm run build:helper`';
  if (!nonEmpty(helperPath)) return result('helper', label, true, 'fail', 'no helper path known', fix);
  let there = false;
  try { there = typeof exists === 'function' && exists(helperPath) === true; } catch { there = false; }
  if (!there) return result('helper', label, true, 'fail', `not found at ${helperPath}`, fix);
  if (typeof run !== 'function') return result('helper', label, true, 'fail', 'found, but not run', fix);
  let r;
  try { r = await run(); } catch (err) { r = { ok: false, error: err && err.message }; }
  if (!r || r.ok !== true) {
    return result('helper', label, true, 'fail', `found, but it won't start${r && r.error ? ` (${r.error})` : ''}`, fix);
  }
  return result('helper', label, true, 'ok', helperPath);
}

function checkSignedIn({ configDir, env, exists } = {}) {
  const label = 'Claude Code signed in';
  const fix = 'Claude Code isn\'t signed in: run `claude` once in a terminal and log in';
  const key = env && env.ANTHROPIC_API_KEY;
  if (nonEmpty(key)) return result('signin', label, true, 'ok', 'an API key is set in the environment');
  if (!nonEmpty(configDir)) return result('signin', label, true, 'fail', 'the CLI\'s config folder isn\'t known', fix);
  const file = path.join(configDir, '.credentials.json');
  let there = false;
  try { there = typeof exists === 'function' && exists(file) === true; } catch { there = false; }
  return there
    ? result('signin', label, true, 'ok', `credentials found in ${configDir}`)
    : result('signin', label, true, 'fail', `no credentials in ${configDir}`, fix);
}

async function checkOllama({ probe } = {}) {
  const label = 'Ollama (optional)';
  const none = 'not reachable; only the local-model features need it';
  if (typeof probe !== 'function') return result('ollama', label, false, 'info', none);
  let r;
  try { r = await probe(); } catch { r = null; }
  return r && r.ok === true
    ? result('ollama', label, false, 'ok', 'reachable')
    : result('ollama', label, false, 'info', none);
}

/** All four, in a fixed order. One check throwing can't take the others down. */
async function runChecks(deps = {}) {
  const guard = async (id, label, required, fn) => {
    try { return await fn(); } catch (err) {
      return result(id, label, required, required ? 'fail' : 'info', `check failed: ${err && err.message}`);
    }
  };
  return [
    await guard('claude', 'Claude Code CLI', true, () => checkClaude({ run: deps.run })),
    await guard('helper', 'Hook helper', true, () => checkHelper({ helperPath: deps.helperPath, exists: deps.exists, run: deps.runHelper || deps.run })),
    await guard('signin', 'Claude Code signed in', true, () => checkSignedIn({ configDir: deps.configDir, env: deps.env, exists: deps.exists })),
    await guard('ollama', 'Ollama (optional)', false, () => checkOllama({ probe: deps.probe })),
  ];
}

function summarize(results) {
  const checks = Array.isArray(results) ? results : [];
  const bad = checks.find(c => c && c.required === true && c.status !== 'ok');
  return { checks, banner: bad ? (bad.fix || `${bad.label}: ${bad.detail}`) : null };
}

// --- the real world (kept out of the checks above so they stay testable) -------------------------------------------------

function execOnce(file, args, timeoutMs, env) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, env }, (err, stdout) => {
        resolve(err ? { ok: false, error: err.code || err.message } : { ok: true, stdout: String(stdout || '') });
      });
    } catch (err) {
      resolve({ ok: false, error: err && err.message });
    }
  });
}

async function ollamaProbe(baseUrl, timeoutMs = 1500, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return { ok: false };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(String(baseUrl).replace(/\/+$/, '') + '/api/tags', { signal: ctl.signal });
    return { ok: res.ok === true };
  } catch { return { ok: false }; } finally { clearTimeout(timer); }
}

/** The deps `runChecks` wants, wired to this machine. `claudeBin` and `helperPath` come from host.js. */
function realDeps({ claudeBin, helperPath, configDir, env = process.env, ollamaUrl = 'http://127.0.0.1:11434' }) {
  return {
    run: () => execOnce(claudeBin, ['--version'], 8000, env),
    // No arguments: the helper returns 0 at once when it has no --pipe/--event, without touching stdin.
    runHelper: () => execOnce(helperPath, [], 5000, env),
    helperPath,
    exists: (p) => fs.existsSync(p),
    configDir,
    env,
    probe: () => ollamaProbe(ollamaUrl),
  };
}

module.exports = {
  MIN_CLAUDE_VERSION, parseVersion, compareVersions,
  checkClaude, checkHelper, checkSignedIn, checkOllama, runChecks, summarize, realDeps, ollamaProbe,
};
