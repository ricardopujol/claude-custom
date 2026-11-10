'use strict';
/**
 * Probe: what the real CLI does with `--continue` (BACKLOG #166; documentation/DESIGN_TABS_SESSIONS.md 3.1).
 *
 *   node verify/probe-continue.js fresh   a folder with NO earlier conversation: what does `claude --continue` print and exit with?
 *   node verify/probe-continue.js prior   a folder WITH one (a first turn is made for it): does `--continue` pick it up?
 *
 * Runs in a SCRATCH folder under the OS temp dir (never dev\), under the heavy lock (verify/lib/launch-electron.js takes it on
 * require), one non-interactive turn at most per step, on the smallest model. The claude it starts is stopped by its own PID.
 * Prints `[probe-continue] ...` lines; exit 0 when it measured, 1 when it could not.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { noteChild } = require('./lib/launch-electron');
const { killPidTree } = require('../host/kill-tree');

const mode = process.argv[2] === 'prior' ? 'prior' : 'fresh';
const SCRATCH = path.join(os.tmpdir(), 'claude', 'cc-continue-scratch', `${mode}-${Date.now()}`);
fs.mkdirSync(SCRATCH, { recursive: true });
const say = (...a) => console.log('[probe-continue]', ...a);

/** One non-interactive turn in the scratch folder; the prompt goes in on stdin. -> { code, out, err, timedOut } */
function turn(extra, prompt, ms = 120000) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--model', 'haiku', ...extra], { cwd: SCRATCH, shell: true, windowsHide: true });
    noteChild(child);
    let out = ''; let err = ''; let timedOut = false;
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => { timedOut = true; try { killPidTree(child.pid); } catch { /* gone */ } }, ms);   // kill-ok(held-handle): the child this probe just spawned
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim(), timedOut }); });
    child.stdin.end(prompt);
  });
}

/** The interactive CLI (what a tab runs) in a pty, with `--continue` and nothing to continue: no turn is made, only the screen is read. */
function tty(ms = 20000) {
  return new Promise((resolve) => {
    const pty = require('node-pty');
    // the host's own candidates (host/host.js resolveClaude)
    const bin = [path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'), path.join(os.homedir(), '.local/bin/claude.exe')]
      .find(c => fs.existsSync(c)) || 'claude.exe';
    say(`binary ${bin}`);
    const p = pty.spawn(bin, ['--continue', '--model', 'haiku'], { cwd: SCRATCH, cols: 120, rows: 30, env: process.env });
    noteChild(p);
    let screen = ''; let exited = null;
    p.onData(d => { screen += d; });
    p.onExit(e => { exited = e.exitCode; });
    setTimeout(() => {
      try { killPidTree(p.pid); } catch { /* gone */ }   // kill-ok(held-handle): the pty child this probe just spawned
      resolve({ screen: screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim(), exited });
    }, ms);
  });
}

(async () => {
  say(`scratch folder ${SCRATCH}`);
  if (process.argv[2] === 'tty') {
    const r = await tty();
    say(`interactive --continue, nothing to continue: ${r.exited === null ? 'still running after 20 s' : `exited ${r.exited}`}`);
    say(`screen: ${JSON.stringify(r.screen.slice(0, 600))}`);
    say(/no conversation/i.test(r.screen) ? 'ERRORS: "No conversation" shown' : 'NO ERROR TEXT on the screen');
    process.exit(0);
  }
  if (mode === 'prior') {
    const first = await turn([], 'Reply with exactly the word: pineapple');
    say(`first turn: exit ${first.code}, out ${JSON.stringify(first.out.slice(0, 80))}, err ${JSON.stringify(first.err.slice(0, 120))}`);
    if (first.code !== 0) { say('could not make a conversation'); process.exit(1); }
  }
  const r = await turn(['--continue'], mode === 'prior' ? 'What single word did I ask you to reply with? Answer in one word.' : 'Reply with exactly the word: fresh');
  say(`--continue (${mode}): exit ${r.code}${r.timedOut ? ' (timed out)' : ''}`);
  say(`stdout: ${JSON.stringify(r.out.slice(0, 200))}`);
  say(`stderr: ${JSON.stringify(r.err.slice(0, 300))}`);
  if (mode === 'prior') say(r.code === 0 && /pineapple/i.test(r.out) ? 'RESUMED: it remembered the earlier turn' : 'NOT RESUMED');
  else say(r.code === 0 ? 'FRESH SESSION: no error with nothing to continue' : 'ERRORS with nothing to continue: detect "no conversation" and omit the flag');
  process.exit(0);
})().catch((e) => { say('failed:', e && e.message); process.exit(1); });
