'use strict';
/**
 * ONE long-lived powershell.exe, fed one script per call over stdin (BACKLOG #100 c). The resource sampler used to
 * start a fresh powershell.exe for every sample; MEASURED 2026-10-15 on the dev machine, each of those cost about 3.1 s
 * of powershell CPU and 8.9 s of wall time for a full sample, a good part of it start-up plus Defender's scan of the new
 * process. A shell that stays up pays the start-up once.
 *
 * THE PROTOCOL. `powershell -NoProfile -NonInteractive -Command -` runs each stdin line as it arrives. A script is
 * many lines, so it travels on ONE line: base64 of its UTF-8, decoded and run with Invoke-Expression. Output is read
 * until an `END` line (the sample script already prints one; the exit code is useless here, the process never exits).
 * `END` must be a whole line AT THE END of what has arrived: a process whose command line merely ends in "END" and
 * happens to end a chunk is not the sentinel. Output is decoded with a StringDecoder, so a multi-byte character split
 * across two chunks stays whole. The console's output encoding is set to UTF-8 by the first line sent, BEFORE any script
 * prints (MEASURED: set inside the same script that prints, the first line of output is already mis-encoded).
 *
 * ONE CALL AT A TIME, in order: a call made while another runs waits. A call that outlives `timeoutMs` kills the shell by
 * its own handle and rejects; the next call starts a fresh one, so a late answer of the dead shell can never be read as
 * the next call's (its handlers are tied to that child). The shell is also replaced after `maxUses` answers (a long-lived
 * PowerShell holding 300 KB of CIM objects a call is bounded, not left to grow) and ended after `idleMs` with no call.
 * It is only ever ended by its own handle (`child.kill()`), never by name.
 *
 * `exec(script)` -> Promise<string> with `.kill()` (ends the shell, rejecting that call); `exec.close()` ends the shell for
 * good and refuses later calls; `exec.pid()` is the live shell's pid or null.
 */

const path = require('path');
const { StringDecoder } = require('string_decoder');
const childProcess = require('child_process');

// By absolute path: a bare powershell.exe is looked up in the cwd first (host/proc-start.js, Miguel G1).
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TIMEOUT_MS = 20000;
const MAX_USES = 360;
const IDLE_MS = 120000;
const INIT = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'\n";
const ENDS_WITH_SENTINEL = /(?:^|\n)END\r?\n$/;

const unrefTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; };

function createPersistentExec({
  spawn = childProcess.spawn, file = POWERSHELL, timeoutMs = TIMEOUT_MS, maxUses = MAX_USES, idleMs = IDLE_MS,
  setTimer = unrefTimer, clearTimer = clearTimeout,
} = {}) {
  let child = null;
  let decoder = null;
  let buf = '';
  let job = null;          // { script, resolve, reject, timer } on the shell now
  const queue = [];
  let uses = 0;
  let closed = false;
  let idleTimer = null;

  function endShell() {
    const c = child;
    child = null;
    if (c) { try { c.kill(); } catch { /* already gone */ } }
  }

  function fail(j, err) {
    if (!j) return;
    if (j.timer) clearTimer(j.timer);
    j.reject(err);
  }

  function spawnShell() {
    const c = spawn(file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = c;
    decoder = new StringDecoder('utf8');
    buf = '';
    // Every handler is tied to THIS child: whatever a shell that was ended says afterwards is nobody's answer.
    c.stdout.on('data', (d) => {
      if (child !== c) return;
      buf += typeof d === 'string' ? d : decoder.write(d);
      if (job && ENDS_WITH_SENTINEL.test(buf)) finish(buf);
    });
    c.stderr.on('data', () => {});
    c.stdin.on('error', () => {});
    c.on('error', (err) => {
      if (child !== c) return;
      child = null;
      try { c.kill(); } catch { /* already gone */ }
      const j = job;
      job = null;
      fail(j, err instanceof Error ? err : new Error(String(err)));
      pump();
    });
    c.on('exit', () => {
      if (child !== c) return;
      child = null;
      const j = job;
      job = null;
      fail(j, new Error('the PowerShell process exited before the sample ended'));
      pump();
    });
    c.stdin.write(INIT);
    return c;
  }

  function finish(text) {
    const j = job;
    job = null;
    buf = '';
    if (j.timer) clearTimer(j.timer);
    uses++;
    if (uses >= maxUses) { endShell(); uses = 0; }
    else armIdle();
    j.resolve(text);
    pump();
  }

  function armIdle() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = null;
    if (!child || !(idleMs > 0)) return;
    idleTimer = setTimer(() => { idleTimer = null; if (!job && queue.length === 0) { endShell(); uses = 0; } }, idleMs);
  }

  function pump() {
    if (job || queue.length === 0 || closed) return;
    const next = queue.shift();
    if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
    job = next;
    let c = child;
    try {
      if (!c) { c = spawnShell(); uses = 0; }
      const line = `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(next.script, 'utf8').toString('base64')}')))\n`;
      c.stdin.write(line);
    } catch (err) {
      endShell();
      job = null;
      fail(next, err);
      pump();
      return;
    }
    next.timer = setTimer(() => {
      if (job !== next) return;
      job = null;
      endShell();
      fail(next, new Error(`the PowerShell sample timed out after ${timeoutMs} ms`));
      pump();
    }, timeoutMs);
  }

  function exec(script) {
    let entry = null;
    const done = new Promise((resolve, reject) => {
      if (closed) { reject(new Error('the persistent PowerShell is closed')); return; }
      entry = { script: String(script), resolve, reject, timer: null };
      queue.push(entry);
    });
    // The promise rejects only through fail(): a call nobody awaits any more must not become an unhandled rejection.
    done.catch(() => {});
    // Ends the shell (this call is the one in flight, or a queued one that is dropped), by its own handle.
    const result = new Promise((resolve, reject) => done.then(resolve, reject));
    result.kill = () => {
      if (!entry) return;
      const i = queue.indexOf(entry);
      if (i >= 0) { queue.splice(i, 1); fail(entry, new Error('the sample was cancelled')); return; }
      if (job === entry) {
        job = null;
        endShell();
        fail(entry, new Error('the sample was cancelled'));
        pump();
      }
    };
    pump();
    return result;
  }

  exec.close = () => {
    closed = true;
    if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
    const j = job;
    job = null;
    endShell();
    fail(j, new Error('the persistent PowerShell is closed'));
    while (queue.length) fail(queue.shift(), new Error('the persistent PowerShell is closed'));
  };
  exec.pid = () => (child && Number.isInteger(child.pid) ? child.pid : null);
  return exec;
}

module.exports = { createPersistentExec, POWERSHELL, TIMEOUT_MS, MAX_USES, IDLE_MS };
