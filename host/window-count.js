'use strict';
/**
 * How many windows does host pid P have open, asked of the OS rather than the
 * host: the ESTABLISHED TCP connections on its own listening port that it owns.
 *
 *   windowCount(pid, port) -> an integer >= 0, or null when it couldn't tell
 *
 * For host/stop-holder.js, which must never stop a session with a window open
 * (Ricardo, 2026-09-30) -- including a holder that can't be asked: a lock from
 * before `install`, a build older than its controls, a token that was never
 * written, a host too busy to answer (Dexter + Miguel, PR #76 F1/B1). This is
 * the measurement that found the 14 windowless hosts on 2026-09-30.
 *
 * NULL IS NEVER 0. Get-NetTCPConnection THROWS when nothing matches; only that
 * error means "no connections". Any other failure -- a slow powershell.exe, a
 * missing cmdlet, a denied query -- is "couldn't tell", and a caller deciding
 * whether to kill must read that as "maybe". Told apart by the error's
 * FullyQualifiedErrorId, NOT its category (Dexter, PR #76 R2-1, measured): a
 * missing or unloadable cmdlet is ObjectNotFound too, but its id is
 * CommandNotFoundException; no matching rows is CmdletizationQuery_NotFound.
 *
 * A one-shot control client (host/host-client.js) is a connection too, so the
 * count can be one high while one is attached. That errs the safe way.
 */

const { defaultExec, POWERSHELL, BOM_AT_START } = require('./proc-start');

const validPid = n => Number.isInteger(n) && n > 0;
const validPort = n => Number.isInteger(n) && n > 0 && n < 65536;

// The cmdlet is a parameter only so the real-shell test can name one that
// doesn't exist; it is never anything but a plain identifier.
const CMDLET = /^[A-Za-z]+-[A-Za-z]+$/;

async function windowCount(pid, port, { exec = defaultExec, platform = process.platform, cmdlet = 'Get-NetTCPConnection' } = {}) {
  if (platform !== 'win32' || !validPid(pid) || !validPort(port)) return null;
  if (typeof cmdlet !== 'string' || !CMDLET.test(cmdlet)) return null;
  const script = "$ErrorActionPreference='Stop'; try { " +
    `$c = @(${cmdlet} -LocalPort ${port} -State Established | ` +
    `Where-Object { $_.OwningProcess -eq ${pid} }).Count; "COUNT $c" } ` +
    "catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { 'COUNT 0' } else { 'FAILED' } }; 'END'";

  let out;
  try {
    out = await exec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script]);
  } catch {
    return null;
  }
  const lines = String(out).replace(BOM_AT_START, '').split(/\r?\n/).map(l => l.trim());
  if (!lines.includes('END')) return null;
  const counts = lines.map(l => /^COUNT (\d+)$/.exec(l)).filter(Boolean);
  return counts.length === 1 ? Number(counts[0][1]) : null;
}

module.exports = { windowCount };
