'use strict';
/**
 * The tool belt's hook (BACKLOG #17): a PreToolUse command for the Agent tool
 * that rewrites the spawn from the loadout the host owns.
 *
 *   node host/loadout-hook.js --state <dir>      (payload JSON on stdin)
 *
 * It prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
 * "updatedInput":{...}}}` ONLY when there is something to change, and prints
 * nothing otherwise. It ALWAYS exits 0 and NEVER throws: a hook that failed a
 * spawn because a JSON file was damaged would turn a convenience feature into
 * an outage, so every failure path is silent and the agent runs unmodified.
 *
 * NO permissionDecision in the output, on purpose. Rewriting the input is all
 * this hook does; answering the user's permission prompt for them is a
 * different power and not the tool belt's to take.
 *
 * WHY A SCRIPT WHEN THE OTHER HOOKS ARE A NATIVE HELPER. helper/hook-helper.cs
 * is transport-only and must never block (it fires on every Bash and Agent
 * call). This one has to READ state and DECIDE, and it is matched to Agent|Task
 * only, so Node's 50-100 ms startup (measured ~54 ms,
 * verify/probe-loadout-hook.js) is paid per subagent spawn -- not per Read or
 * Bash. It requires only the pure core and the payload contract; a test pins
 * that, because an accidental require of the store would add to every spawn.
 *
 * The file is read on EVERY invocation, so an equip lands on the very next
 * spawn with no restart. Reading it is a plain fs read of `loadout.json`
 * (host/store.js's key 'loadout'); the store writes it atomically by rename, so
 * this reader sees the old file or the new one, never half of one.
 */

const fs = require('fs');
const path = require('path');
const { validateLoadout, applyLoadout } = require('./loadout');
const { AGENT_TOOLS } = require('./payload-contract');

/**
 * The stdout for one hook payload, or null for "print nothing". Pure apart
 * from the file read. Never throws.
 */
function decide(rawPayload, stateDir) {
  try {
    if (typeof stateDir !== 'string' || !stateDir) return null;
    const payload = JSON.parse(rawPayload);
    if (!payload || typeof payload !== 'object' || !AGENT_TOOLS.includes(payload.tool_name)) return null;

    const loadout = validateLoadout(JSON.parse(fs.readFileSync(path.join(stateDir, 'loadout.json'), 'utf8')));
    const updatedInput = applyLoadout(payload.tool_input, loadout);
    if (!updatedInput) return null;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } });
  } catch {
    return null;
  }
}

function stateDirFrom(argv) {
  const i = argv.indexOf('--state');
  return i > -1 && typeof argv[i + 1] === 'string' ? argv[i + 1] : null;
}

const STDIN_TIMEOUT_MS = 3000;

/**
 * Read the payload, answer once, return a promise for "answered". Injectable
 * (stdin, argv, write, timeoutMs) so the timeout and error branches are tested
 * without a 3 s wait or a real broken pipe (PR #68, Miguel I3).
 *
 * If the CLI never closes stdin we do not hold the spawn open: after the
 * timeout we answer with what we have and DESTROY stdin. There is deliberately
 * no process.exit(): on an asynchronous stdout pipe an immediate exit can
 * truncate a large updatedInput, and truncated JSON is ignored silently. With
 * stdin destroyed and the timer cleared nothing keeps the loop alive, so the
 * process ends by itself once stdout has drained.
 */
function run({ stdin = process.stdin, argv = process.argv, write = (s) => process.stdout.write(s),
  timeoutMs = STDIN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        const out = decide(raw, stateDirFrom(argv));
        if (out) write(out);
      } catch { /* silent: the agent runs unmodified */ }
      try { if (typeof stdin.destroy === 'function') stdin.destroy(); } catch { /* already closed */ }
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    try { stdin.setEncoding('utf8'); } catch { /* fake or closed stdin */ }
    stdin.on('data', (d) => { raw += d; });
    stdin.on('end', finish);
    stdin.on('error', finish);
  });
}

if (require.main === module) {
  run().then(() => { process.exitCode = 0; });
}

module.exports = { decide, stateDirFrom, run, STDIN_TIMEOUT_MS };
