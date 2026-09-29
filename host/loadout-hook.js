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

function main() {
  let raw = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const out = decide(raw, stateDirFrom(process.argv));
    if (out) process.stdout.write(out);
    process.exitCode = 0;
  };
  // If the CLI never closes stdin, do not hold the spawn open for it. unref'd,
  // so it never keeps a finished process alive.
  setTimeout(() => { finish(); process.exit(0); }, 3000).unref();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
}

if (require.main === module) main();

module.exports = { decide, stateDirFrom };
